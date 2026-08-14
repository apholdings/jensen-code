/**
 * Durable mission-level cognitive checkpoint (L2 warm memory).
 *
 * This is a *bounded operational projection* over Jensen's already-durable
 * state (MissionRuntime, session memory, todos, tasks, file operations). It is
 * NOT a new authority surface and can never fabricate mission success: the
 * Reliability Kernel / Completion Gate remain the sole authority for completion.
 *
 * The checkpoint is versioned, keyed to mission/session identity, corruption
 * safe, and provider-independent. It is the semantic bridge that lets a
 * rehydrated context continue the same mission without replaying the full
 * transcript.
 */

export const MISSION_CONTEXT_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface DecisionRecord {
	decision: string;
	rationale: string;
}

export interface FindingRecord {
	subject: string;
	detail: string;
	/** Deterministic evidence id or file:line reference, never fabricated. */
	evidenceRef?: string;
}

export interface TestState {
	command?: string;
	/** lastPassing/failing evidence references (observations, not conclusions). */
	lastResult?: "pass" | "fail" | "unknown";
	evidenceRef?: string;
}

export interface EvidenceReference {
	evidenceId: string;
	summary: string;
}

export interface MissionContextCheckpoint {
	schemaVersion: typeof MISSION_CONTEXT_CHECKPOINT_SCHEMA_VERSION;
	missionId: string;
	revision: number;
	updatedAtMs: number;
	objective: string;
	constraints: string[];
	decisions: DecisionRecord[];
	plan: string;
	completedSteps: string[];
	pendingSteps: string[];
	activeFiles: string[];
	findings: FindingRecord[];
	evidenceRefs: EvidenceReference[];
	testState: TestState;
	blockers: string[];
	nextActions: string[];
	/**
	 * Explicit authority marker. Context persistence must never promote mission
	 * state; completion authority is always "mission-runtime-only".
	 */
	completionAuthority: "mission-runtime-only";
}

export interface CheckpointPatch {
	objective?: string;
	constraints?: string[];
	decisions?: DecisionRecord[];
	plan?: string;
	completedSteps?: string[];
	pendingSteps?: string[];
	activeFiles?: string[];
	findings?: FindingRecord[];
	evidenceRefs?: EvidenceReference[];
	testState?: TestState;
	blockers?: string[];
	nextActions?: string[];
}

export function createMissionContextCheckpoint(
	missionId: string,
	patch: CheckpointPatch,
	options: { now?: number } = {},
): MissionContextCheckpoint {
	const now = options.now ?? Date.now();
	return {
		schemaVersion: MISSION_CONTEXT_CHECKPOINT_SCHEMA_VERSION,
		missionId,
		revision: 1,
		updatedAtMs: now,
		objective: patch.objective ?? "",
		constraints: [...(patch.constraints ?? [])],
		decisions: (patch.decisions ?? []).map((d) => ({ ...d })),
		plan: patch.plan ?? "",
		completedSteps: [...(patch.completedSteps ?? [])],
		pendingSteps: [...(patch.pendingSteps ?? [])],
		activeFiles: [...(patch.activeFiles ?? [])],
		findings: (patch.findings ?? []).map((f) => ({ ...f })),
		evidenceRefs: (patch.evidenceRefs ?? []).map((e) => ({ ...e })),
		testState: { ...(patch.testState ?? {}) },
		blockers: [...(patch.blockers ?? [])],
		nextActions: [...(patch.nextActions ?? [])],
		completionAuthority: "mission-runtime-only",
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isDecisionRecord(value: unknown): value is DecisionRecord {
	if (typeof value !== "object" || value === null) return false;
	const d = value as Record<string, unknown>;
	return typeof d.decision === "string" && typeof d.rationale === "string";
}

function isFindingRecord(value: unknown): value is FindingRecord {
	if (typeof value !== "object" || value === null) return false;
	const f = value as Record<string, unknown>;
	return typeof f.subject === "string" && typeof f.detail === "string";
}

function isEvidenceReference(value: unknown): value is EvidenceReference {
	if (typeof value !== "object" || value === null) return false;
	const e = value as Record<string, unknown>;
	return typeof e.evidenceId === "string" && typeof e.summary === "string";
}

/**
 * Deserialize a checkpoint. Fails closed (throws) on structural corruption so
 * a partial/truncated document can never fabricate state, decisions, evidence,
 * or success.
 */
export function parseMissionContextCheckpoint(data: unknown): MissionContextCheckpoint {
	if (typeof data !== "object" || data === null) {
		throw new Error("MissionContextCheckpoint must be an object");
	}
	const doc = data as Record<string, unknown>;
	if (doc.schemaVersion !== MISSION_CONTEXT_CHECKPOINT_SCHEMA_VERSION) {
		throw new Error(`Unsupported MissionContextCheckpoint schema version: ${String(doc.schemaVersion)}`);
	}
	if (typeof doc.missionId !== "string" || doc.missionId.length === 0) {
		throw new Error("MissionContextCheckpoint is missing missionId");
	}
	if (typeof doc.objective !== "string") {
		throw new Error("MissionContextCheckpoint is missing objective");
	}
	if (doc.completionAuthority !== "mission-runtime-only") {
		throw new Error("MissionContextCheckpoint has invalid completionAuthority");
	}

	return createMissionContextCheckpoint(
		doc.missionId,
		{
			objective: doc.objective,
			constraints: isStringArray(doc.constraints) ? doc.constraints : [],
			decisions: Array.isArray(doc.decisions) ? doc.decisions.filter(isDecisionRecord) : [],
			plan: typeof doc.plan === "string" ? doc.plan : "",
			completedSteps: isStringArray(doc.completedSteps) ? doc.completedSteps : [],
			pendingSteps: isStringArray(doc.pendingSteps) ? doc.pendingSteps : [],
			activeFiles: isStringArray(doc.activeFiles) ? doc.activeFiles : [],
			findings: Array.isArray(doc.findings) ? doc.findings.filter(isFindingRecord) : [],
			evidenceRefs: Array.isArray(doc.evidenceRefs) ? doc.evidenceRefs.filter(isEvidenceReference) : [],
			testState: typeof doc.testState === "object" && doc.testState !== null ? (doc.testState as TestState) : {},
			blockers: isStringArray(doc.blockers) ? doc.blockers : [],
			nextActions: isStringArray(doc.nextActions) ? doc.nextActions : [],
		},
		{
			now: typeof doc.updatedAtMs === "number" ? doc.updatedAtMs : undefined,
		},
	);
}

/**
 * Deterministic, bounded rehydration preamble. Contains the operational facts a
 * model needs to continue the SAME mission after a context rollover — never
 * raw reasoning, never raw transcripts, never secrets.
 */
export function checkpointToRehydrationPreamble(checkpoint: MissionContextCheckpoint): string {
	const lines: string[] = [];
	lines.push("<mission-context-checkpoint>");
	lines.push(`mission-id: ${checkpoint.missionId}`);
	lines.push(`revision: ${checkpoint.revision}`);
	lines.push(`objective: ${checkpoint.objective}`);

	if (checkpoint.constraints.length > 0) {
		lines.push("constraints:");
		for (const c of checkpoint.constraints) lines.push(`- ${c}`);
	}

	if (checkpoint.decisions.length > 0) {
		lines.push("decisions:");
		for (const d of checkpoint.decisions) lines.push(`- ${d.decision} (rationale: ${d.rationale})`);
	}

	if (checkpoint.plan) {
		lines.push(`plan: ${checkpoint.plan}`);
	}

	if (checkpoint.completedSteps.length > 0) {
		lines.push("completed:");
		for (const s of checkpoint.completedSteps) lines.push(`- [x] ${s}`);
	}

	if (checkpoint.pendingSteps.length > 0) {
		lines.push("pending:");
		for (const s of checkpoint.pendingSteps) lines.push(`- [ ] ${s}`);
	}

	if (checkpoint.activeFiles.length > 0) {
		lines.push("active-files:");
		for (const f of checkpoint.activeFiles) lines.push(`- ${f}`);
	}

	if (checkpoint.findings.length > 0) {
		lines.push("findings:");
		for (const f of checkpoint.findings) {
			lines.push(`- ${f.subject}: ${f.detail}${f.evidenceRef ? ` [ref: ${f.evidenceRef}]` : ""}`);
		}
	}

	if (checkpoint.evidenceRefs.length > 0) {
		lines.push("evidence-refs:");
		for (const e of checkpoint.evidenceRefs) lines.push(`- ${e.evidenceId}: ${e.summary}`);
	}

	if (checkpoint.testState.command || checkpoint.testState.lastResult) {
		lines.push(
			`test-state: ${checkpoint.testState.command ?? "(no command)"} -> ${checkpoint.testState.lastResult ?? "unknown"}`,
		);
		if (checkpoint.testState.evidenceRef) lines.push(`test-evidence: ${checkpoint.testState.evidenceRef}`);
	}

	if (checkpoint.blockers.length > 0) {
		lines.push("blockers:");
		for (const b of checkpoint.blockers) lines.push(`- ${b}`);
	}

	if (checkpoint.nextActions.length > 0) {
		lines.push("next-actions:");
		for (const a of checkpoint.nextActions) lines.push(`- ${a}`);
	}

	lines.push(
		"authority: completion remains governed by the Reliability Kernel; this checkpoint cannot certify success.",
	);
	lines.push("</mission-context-checkpoint>");
	return lines.join("\n");
}
