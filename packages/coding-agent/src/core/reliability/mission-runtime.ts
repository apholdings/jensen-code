/**
 * Mission Runtime — the Reliability Kernel's runtime facade.
 *
 * Owns the durable Mission Contract, Requirement Ledger, and Mission Execution
 * State Machine (all from the Long-Horizon subsystem) and exposes a small,
 * Jensen-owned API for the agent loop:
 *
 *   - decode/validate model actions (validator is separate; see action-validator)
 *   - record deterministic verification evidence (authoritative, never agent-claim)
 *   - advance acceptance criteria to SATISFIED only from authoritative evidence
 *   - run the Completion Gate on FINAL_CANDIDATE
 *   - serialize/deserialize durably (survives resume/compaction/restart)
 *
 * The model interacts only through the untrusted context; the runtime holds the
 * trusted mutation/validation contexts that authorize authoritative evidence and
 * SATISFIED transitions.
 */

import { randomUUID } from "node:crypto";
import type {
	MissionConstraint,
	MissionContractV1,
	MissionExecutionRecordV1,
	MissionExecutionState,
	MissionExecutionTransitionKind,
	RequirementEvaluationStatus,
	RequirementLedgerV1,
} from "../long-horizon/index.js";
import {
	addLedgerEvidence,
	applyMissionExecutionTransition,
	applyRequirementTransition,
	initializeMissionExecution,
	initializeRequirementLedger,
	inspectRequirementLedgerStructure,
	validateMissionContract,
} from "../long-horizon/index.js";
import type { TrustedLedgerMutationContext, TrustedValidationContext } from "../long-horizon/trusted-context.js";
import {
	_internalCreateTrustedContext,
	_internalCreateTrustedValidationContext,
} from "../long-horizon/trusted-context.js";
import { evaluateCompletionGate } from "./completion-gate.js";
import { runtimeSourceId, VERIFICATION_EVIDENCE_MAP } from "./evidence-mapping.js";
import { buildMissionContract, type MissionDefinitionInput } from "./mission-contract-factory.js";
import { InMemoryReliabilityRecorder, type ReliabilityRecorder } from "./telemetry.js";
import type {
	CompletionGateResult,
	CriterionSource,
	FailureEvent,
	MissionEvidence,
	ReliabilityPhase,
	RuntimeAcceptanceCriterion,
	VerificationResult,
	VerificationSpec,
} from "./types.js";

export const MISSION_RUNTIME_SCHEMA_VERSION = 1 as const;

export const RUNTIME_PRINCIPAL = "jensen-runtime";
export const COMPLETION_PRINCIPAL = "completion-operator";

interface CriterionMeta {
	id: string;
	description: string;
	source: CriterionSource;
	verification: VerificationSpec;
}

export interface MissionRuntimeDocumentV1 {
	schemaVersion: 1;
	missionId: string;
	goal: string;
	contract: MissionContractV1;
	ledger: RequirementLedgerV1;
	execution: MissionExecutionRecordV1;
	criteria: CriterionMeta[];
	constraints: MissionConstraint[];
	createdAtMs: number;
	updatedAtMs: number;
}

const RUNTIME_CAPABILITIES = [
	"evidence:command-result",
	"evidence:test-result",
	"evidence:repository-observation",
	"evidence:runtime-observation",
	"evidence:operator-confirmation",
	"transition:satisfy",
	"transition:not-applicable",
] as const;

const RUNTIME_SOURCE_GRANTS = [
	{
		authority: "command-result",
		capability: "evidence:command-result",
		allowedEvidenceTypes: ["command-result", "build-result"],
	},
	{ authority: "test-result", capability: "evidence:test-result", allowedEvidenceTypes: ["test-result"] },
	{
		authority: "repository-observation",
		capability: "evidence:repository-observation",
		allowedEvidenceTypes: ["file-change", "repository-state"],
	},
	{
		authority: "runtime-observation",
		capability: "evidence:runtime-observation",
		allowedEvidenceTypes: ["runtime-observation"],
	},
	{
		authority: "operator-confirmation",
		capability: "evidence:operator-confirmation",
		allowedEvidenceTypes: ["operator-confirmation"],
	},
] as const;

function buildTrustedMutationContext(): TrustedLedgerMutationContext {
	return _internalCreateTrustedContext({
		principalId: RUNTIME_PRINCIPAL,
		principalKind: "system",
		capabilities: [...RUNTIME_CAPABILITIES],
	});
}

function buildTrustedValidationContext(contract: MissionContractV1): TrustedValidationContext {
	return _internalCreateTrustedValidationContext({
		contract,
		principals: [
			{ principalId: RUNTIME_PRINCIPAL, principalKind: "system", capabilities: [...RUNTIME_CAPABILITIES] },
			{ principalId: COMPLETION_PRINCIPAL, principalKind: "operator", capabilities: ["execution:complete"] },
		],
		sourceGrants: RUNTIME_SOURCE_GRANTS.map((g) => ({
			sourceId: runtimeSourceId(g.authority),
			principalId: RUNTIME_PRINCIPAL,
			principalKind: "system" as const,
			capability: g.capability,
			allowedEvidenceTypes: [...g.allowedEvidenceTypes],
		})),
	});
}

const PHASE_BY_STATE: Record<MissionExecutionState, ReliabilityPhase> = {
	PLANNING: "PLANNING",
	EXECUTION: "ACTING",
	VERIFICATION: "VERIFYING",
	COMPLETION_REVIEW: "FINALIZING",
	BLOCKED: "BLOCKED",
	COMPLETED: "COMPLETED",
	FAILED: "FAILED",
	CANCELLED: "FAILED",
};

export class MissionRuntime {
	private _contract: MissionContractV1;
	private _ledger: RequirementLedgerV1;
	private _execution: MissionExecutionRecordV1;
	private readonly _criteria: CriterionMeta[];
	private readonly _constraints: MissionConstraint[];
	private readonly _createdAtMs: number;
	private _updatedAtMs: number;
	private readonly _recorder: ReliabilityRecorder;
	private readonly _failures: FailureEvent[];
	private readonly _trustedMutation: TrustedLedgerMutationContext;
	private readonly _trustedValidation: TrustedValidationContext;

	private constructor(input: {
		contract: MissionContractV1;
		ledger: RequirementLedgerV1;
		execution: MissionExecutionRecordV1;
		criteria: CriterionMeta[];
		constraints: MissionConstraint[];
		createdAtMs: number;
		updatedAtMs: number;
		recorder: ReliabilityRecorder;
		failures: FailureEvent[];
	}) {
		this._contract = input.contract;
		this._ledger = input.ledger;
		this._execution = input.execution;
		this._criteria = input.criteria;
		this._constraints = input.constraints;
		this._createdAtMs = input.createdAtMs;
		this._updatedAtMs = input.updatedAtMs;
		this._recorder = input.recorder;
		this._failures = input.failures;
		this._trustedMutation = buildTrustedMutationContext();
		this._trustedValidation = buildTrustedValidationContext(this._contract);
	}

	static create(
		definition: MissionDefinitionInput,
		options: { recorder?: ReliabilityRecorder; now?: number } = {},
	): MissionRuntime {
		const contract = buildMissionContract(definition);
		const validation = validateMissionContract(contract);
		if (!validation.valid) {
			throw new Error(`Invalid mission contract: ${validation.errors.map((e) => e.message).join("; ")}`);
		}
		const ledgerResult = initializeRequirementLedger(contract);
		if (!ledgerResult.ok) {
			throw new Error(`Failed to initialize requirement ledger: ${ledgerResult.error}`);
		}
		const execution = initializeMissionExecution(contract, `${contract.missionId}-exec`);
		const now = options.now ?? Date.now();

		const criteria: CriterionMeta[] = definition.criteria.map((c) => ({
			id: c.id,
			description: c.description,
			source: c.source,
			verification: c.verification,
		}));

		const recorder =
			options.recorder ?? new InMemoryReliabilityRecorder({ missionId: contract.missionId, now: () => now });
		recorder.record("mission_started", { goal: contract.objective });

		return new MissionRuntime({
			contract,
			ledger: ledgerResult.value!,
			execution,
			criteria,
			constraints: contract.constraints,
			createdAtMs: now,
			updatedAtMs: now,
			recorder,
			failures: [],
		});
	}

	static deserialize(
		document: unknown,
		options: { recorder?: ReliabilityRecorder; now?: number } = {},
	): MissionRuntime {
		if (typeof document !== "object" || document === null) {
			throw new Error("MissionRuntime document must be an object");
		}
		const doc = document as Partial<MissionRuntimeDocumentV1>;
		if (doc.schemaVersion !== 1) {
			throw new Error(`Unsupported MissionRuntime schema version: ${String(doc.schemaVersion)}`);
		}
		if (!doc.contract || !doc.ledger || !doc.execution || !Array.isArray(doc.criteria)) {
			throw new Error("MissionRuntime document is missing required fields");
		}

		const contractValidation = validateMissionContract(doc.contract);
		if (!contractValidation.valid) {
			throw new Error(
				`Invalid persisted mission contract: ${contractValidation.errors.map((e) => e.message).join("; ")}`,
			);
		}

		const structural = inspectRequirementLedgerStructure(doc.contract, doc.ledger);
		if (!structural.structurallyValid) {
			throw new Error(`Invalid persisted requirement ledger: ${JSON.stringify(structural)}`);
		}

		const now = options.now ?? Date.now();
		const recorder =
			options.recorder ?? new InMemoryReliabilityRecorder({ missionId: doc.missionId, now: () => now });
		recorder.record("mission_started", { goal: doc.goal });

		return new MissionRuntime({
			contract: doc.contract,
			ledger: doc.ledger,
			execution: doc.execution,
			criteria: doc.criteria,
			constraints: doc.constraints ?? [],
			createdAtMs: doc.createdAtMs ?? now,
			updatedAtMs: doc.updatedAtMs ?? now,
			recorder,
			failures: [],
		});
	}

	// =========================================================================
	// Accessors
	// =========================================================================

	get missionId(): string {
		return this._contract.missionId;
	}

	get goal(): string {
		return this._contract.objective;
	}

	get contract(): MissionContractV1 {
		return this._contract;
	}

	get ledger(): RequirementLedgerV1 {
		return this._ledger;
	}

	get execution(): MissionExecutionRecordV1 {
		return this._execution;
	}

	get phase(): ReliabilityPhase {
		return PHASE_BY_STATE[this._execution.state];
	}

	get recorder(): ReliabilityRecorder {
		return this._recorder;
	}

	get failures(): readonly FailureEvent[] {
		return this._failures;
	}

	get constraints(): readonly MissionConstraint[] {
		return this._constraints;
	}

	// =========================================================================
	// Criteria view
	// =========================================================================

	criterionView(): RuntimeAcceptanceCriterion[] {
		return this._criteria.map((meta) => ({
			id: meta.id,
			description: meta.description,
			source: meta.source,
			status: this._criterionStatus(meta.id),
			verification: meta.verification,
			evidenceIds: this._ledger.evidence.filter((e) => e.criterionIds.includes(meta.id)).map((e) => e.id),
		}));
	}

	private _criterionStatus(criterionId: string): "pending" | "passed" | "failed" | "blocked" {
		const entry = this._ledger.requirements.find((r) => r.requirementId === criterionId);
		if (entry?.status === "SATISFIED") return "passed";
		if (entry?.status === "BLOCKED") return "blocked";
		if (entry?.status === "FAILED") return "failed";
		return "pending";
	}

	// =========================================================================
	// Deterministic verification
	// =========================================================================

	/**
	 * Record the outcome of a deterministic verification for a criterion.
	 * A passing verification advances the criterion to SATISFIED using only
	 * authoritative evidence; a failing verification records a fail evidence
	 * and leaves the criterion unsatisfied (the model cannot self-certify).
	 */
	recordVerification(criterionId: string, result: VerificationResult): void {
		const meta = this._criteria.find((c) => c.id === criterionId);
		if (!meta) {
			this._recordFailure("INTERNAL_RUNTIME_FAILURE", `Unknown criterion id: ${criterionId}`, false);
			return;
		}
		const mapping = VERIFICATION_EVIDENCE_MAP[meta.verification.kind];
		const status = result.passed ? ("pass" as const) : ("fail" as const);
		const evidenceId = this._nextEvidenceId(criterionId);

		// Passing evidence binds to the criterion (authorizes SATISFIED). Failing
		// evidence is recorded as an unbound observation of a failed verification
		// so it can never violate a criterion's pass-required evidence policy.
		const requirementIds = result.passed ? [criterionId] : [];
		const criterionIds = result.passed ? [criterionId] : [];

		const addResult = addLedgerEvidence(
			this._contract,
			this._ledger,
			{
				expectedRevision: this._ledger.revision,
				evidence: {
					id: evidenceId,
					type: mapping.ledgerType,
					requirementIds,
					criterionIds,
					status,
					source: runtimeSourceId(mapping.authority),
					summary: result.evidence.summary,
					reportedCollectorType: mapping.collector,
					reportedAuthority: true,
					metadata: { verificationKind: meta.verification.kind },
				},
			},
			this._trustedMutation,
			this._trustedValidation,
		);

		if (!addResult.ok) {
			this._recordFailure("VERIFICATION_FAILURE", `Failed to record evidence: ${addResult.error}`, false);
			return;
		}
		this._ledger = addResult.value!;
		this._recorder.record("evidence_recorded", { criterionId, evidenceId, passed: result.passed });

		if (result.passed) {
			this._advanceToSatisfied(criterionId, evidenceId);
			this._recorder.record("criterion_passed", { criterionId });
		} else {
			this._regressIfSatisfied(criterionId);
			this._recorder.record("criterion_failed", { criterionId });
		}
		this._recorder.record("verification_executed", { criterionId, passed: result.passed });
		this._touch();
	}

	/**
	 * Record an observed tool-execution outcome as mission evidence (not tied to
	 * a specific criterion). Jensen records the observed facts; the model cannot
	 * fabricate them.
	 */
	recordToolEvidence(evidence: MissionEvidence): void {
		const mapping = VERIFICATION_EVIDENCE_MAP.command;
		const evidenceId = this._nextEvidenceId("tool");
		const addResult = addLedgerEvidence(
			this._contract,
			this._ledger,
			{
				expectedRevision: this._ledger.revision,
				evidence: {
					id: evidenceId,
					type: mapping.ledgerType,
					requirementIds: [],
					criterionIds: evidence.criterionIds ?? [],
					status: evidence.success === false ? "fail" : "unknown",
					source: runtimeSourceId(mapping.authority),
					summary: evidence.summary,
					reportedCollectorType: mapping.collector,
					reportedAuthority: true,
					metadata: evidence.data as Record<string, unknown> | undefined,
				},
			},
			this._trustedMutation,
			this._trustedValidation,
		);
		if (addResult.ok) {
			this._ledger = addResult.value!;
			this._recorder.record("evidence_recorded", { evidenceId, tool: evidence.source });
		}
		this._touch();
	}

	private _nextEvidenceId(criterionId: string): string {
		return `ev_${criterionId}_${this._ledger.revision + 1}`;
	}

	private _advanceToSatisfied(requirementId: string, evidenceId: string): void {
		let entry = this._ledger.requirements.find((r) => r.requirementId === requirementId);
		if (!entry) return;

		// Reach IMPLEMENTED_UNVERIFIED, then SATISFIED.
		let guard = 0;
		while (entry.status !== "SATISFIED" && guard < 8) {
			guard += 1;
			const next = this._nextTowardSatisfied(entry.status);
			if (next === undefined) return;
			const transition = applyRequirementTransition(
				this._contract,
				this._ledger,
				{
					transitionId: this._txId(requirementId, next),
					expectedRevision: this._ledger.revision,
					requirementId,
					toStatus: next,
					reason: next === "SATISFIED" ? "deterministic verification passed" : "advancing toward satisfaction",
					evidenceIds: next === "SATISFIED" ? [evidenceId] : [],
					reportedActorType: "system",
					reportedActorId: RUNTIME_PRINCIPAL,
				},
				this._trustedMutation,
				this._trustedValidation,
			);
			if (!transition.ok) {
				this._recordFailure("VERIFICATION_FAILURE", `Transition to ${next} failed: ${transition.error}`, false);
				return;
			}
			this._ledger = transition.value!;
			entry = this._ledger.requirements.find((r) => r.requirementId === requirementId)!;
		}
	}

	/**
	 * When a previously-satisfied criterion fails verification, transition it out
	 * of SATISFIED so the completion gate requires fresh authoritative evidence.
	 */
	private _regressIfSatisfied(requirementId: string): void {
		const entry = this._ledger.requirements.find((r) => r.requirementId === requirementId);
		if (entry?.status !== "SATISFIED") return;
		const transition = applyRequirementTransition(
			this._contract,
			this._ledger,
			{
				transitionId: this._txId(requirementId, "IMPLEMENTED_UNVERIFIED"),
				expectedRevision: this._ledger.revision,
				requirementId,
				toStatus: "IMPLEMENTED_UNVERIFIED",
				reason: "verification failed after prior satisfaction",
				evidenceIds: [],
				reportedActorType: "system",
				reportedActorId: RUNTIME_PRINCIPAL,
			},
			this._trustedMutation,
			this._trustedValidation,
		);
		if (transition.ok) {
			this._ledger = transition.value!;
		}
	}

	private _nextTowardSatisfied(status: RequirementEvaluationStatus): RequirementEvaluationStatus | undefined {
		switch (status) {
			case "UNASSESSED":
			case "PENDING":
			case "IN_PROGRESS":
				return "IMPLEMENTED_UNVERIFIED";
			case "IMPLEMENTED_UNVERIFIED":
				return "SATISFIED";
			case "BLOCKED":
			case "FAILED":
				return "IN_PROGRESS";
			case "NOT_APPLICABLE":
				return "PENDING";
			default:
				return undefined;
		}
	}

	private _txId(requirementId: string, toStatus: string): string {
		return `tx_${requirementId}_${this._ledger.revision + 1}_${toStatus}`;
	}

	// =========================================================================
	// Finalization
	// =========================================================================

	proposeFinalCandidate(): CompletionGateResult {
		this._recorder.record("finalization_proposed", { phase: this.phase });
		const gate = evaluateCompletionGate(this._contract, this._ledger, this._trustedValidation);
		if (gate.decision === "reject") {
			this._recorder.record("finalization_rejected", { missingCriterionIds: gate.missingCriterionIds });
			this._recordFailure(
				"FINALIZATION_REJECTED",
				`Unverified acceptance criteria: ${gate.missingCriterionIds.join(", ") || "(none)"}`,
				true,
				{ missingCriterionIds: gate.missingCriterionIds },
			);
		}
		this._touch();
		return gate;
	}

	/** Transition the execution state machine by kind. */
	transition(kind: MissionExecutionTransitionKind): { ok: boolean; error?: string } {
		const result = applyMissionExecutionTransition(this._contract, this._execution, {
			transitionId: `exec_${this._execution.revision + 1}_${kind}`,
			expectedRevision: this._execution.revision,
			kind,
		});
		if (!result.ok) {
			return { ok: false, error: result.error };
		}
		this._execution = result.record;
		this._touch();
		return { ok: true };
	}

	/** Approve completion through the execution state machine (COMPLETED). */
	approveCompletion(): { ok: boolean; error?: string } {
		const gate = evaluateCompletionGate(this._contract, this._ledger, this._trustedValidation);
		if (gate.decision === "reject") {
			return { ok: false, error: `completion gate rejected: ${gate.reasons.join("; ")}` };
		}
		const result = applyMissionExecutionTransition(
			this._contract,
			this._execution,
			{
				transitionId: `exec_${this._execution.revision + 1}_APPROVE_COMPLETION`,
				expectedRevision: this._execution.revision,
				kind: "APPROVE_COMPLETION",
			},
			{ trustedValidationContext: this._trustedValidation },
		);
		if (!result.ok) {
			return { ok: false, error: result.error };
		}
		this._execution = result.record;
		this._recorder.record("mission_completed", { phase: "COMPLETED" });
		this._touch();
		return { ok: true };
	}

	block(reason: string): { ok: boolean; error?: string } {
		const result = applyMissionExecutionTransition(this._contract, this._execution, {
			transitionId: `exec_${this._execution.revision + 1}_BLOCK`,
			expectedRevision: this._execution.revision,
			kind: "BLOCK",
		});
		if (!result.ok) {
			return { ok: false, error: result.error };
		}
		this._execution = result.record;
		this._recorder.record("mission_blocked", { reason });
		this._recordFailure("CONTEXT_REQUIRED", reason, true);
		this._touch();
		return { ok: true };
	}

	// =========================================================================
	// Context presentation
	// =========================================================================

	/** Compact, token-disciplined mission state for the model context. */
	summarizeForModel(): string {
		const criteria = this.criterionView();
		const lines: string[] = [];
		lines.push("MISSION");
		lines.push(`Goal: ${this.goal}`);
		lines.push(`Status: ${this.phase}`);
		if (this._constraints.length > 0) {
			lines.push("Required constraints:");
			for (const c of this._constraints) lines.push(`- ${c.id}: ${c.statement}`);
		}
		lines.push("Acceptance criteria:");
		for (const c of criteria) {
			const mark = c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "○";
			lines.push(`${mark} ${c.id} — ${c.description}`);
		}
		lines.push("Next responsibility: propose actions; Jensen validates and verifies completion.");
		return lines.join("\n");
	}

	// =========================================================================
	// Durable serialization
	// =========================================================================

	serialize(): MissionRuntimeDocumentV1 {
		return {
			schemaVersion: MISSION_RUNTIME_SCHEMA_VERSION,
			missionId: this._contract.missionId,
			goal: this._contract.objective,
			contract: this._contract,
			ledger: this._ledger,
			execution: this._execution,
			criteria: this._criteria.map((c) => ({ ...c })),
			constraints: this._constraints,
			createdAtMs: this._createdAtMs,
			updatedAtMs: this._updatedAtMs,
		};
	}

	toJSON(): string {
		return JSON.stringify(this.serialize());
	}

	private _touch(): void {
		this._updatedAtMs = Date.now();
	}

	private _recordFailure(
		category: FailureEvent["category"],
		message: string,
		recoverable: boolean,
		details?: unknown,
	): void {
		this._failures.push({
			category,
			message,
			recoverable,
			timestamp: new Date().toISOString(),
			details,
		});
	}
}

/** Convenience: new mission id. */
export function newMissionId(): string {
	return `mission_${randomUUID()}`;
}
