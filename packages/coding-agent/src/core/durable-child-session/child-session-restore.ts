/**
 * Durable Child AgentSession Restore (2.6.0).
 *
 * Closes the boundary between a durable delegated child *mission* and a durable
 * child *AgentSession*. A delegated child no longer executes through the
 * ephemeral `--no-session` path: it acquires a stable `childSessionId` (stored
 * on the immutable MissionRequest) BEFORE external execution, persists its
 * conversation/todo/memory/evidence state through the standard SessionManager,
 * binds that session to exactly one mission, and can be explicitly resumed
 * after process interruption as the SAME mission + SAME session with a NEW
 * execution attempt.
 *
 * Invariants:
 *   - child process lifetime != child AgentSession lifetime != child mission lifetime.
 *   - resume != rerun from scratch.
 *   - The DurableMissionStore remains the authority for mission lifecycle and
 *     terminal result; the session can never fabricate SUCCEEDED.
 */

import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import {
	checkpointToRehydrationPreamble,
	createMissionContextCheckpoint,
	type MissionContextCheckpoint,
} from "../context-runtime/index.js";
import type { DurableMissionDelegator } from "../durable-delegation/durable-delegation.js";
import type { DurableMissionRecord, DurableMissionStore } from "../mission-domain/durable-store.js";
import { isResumableMissionState, isTerminalMissionState } from "../mission-domain/mission-state.js";
import {
	ProcessMissionExecutor,
	type ProcessMissionLaunch,
	type ProcessMissionVerifier,
} from "../mission-domain/process-mission-executor.js";
import {
	type ChildMissionBinding,
	getLatestCompactionEntry,
	SessionManager,
	validateSessionFile,
} from "../session-manager.js";

export type { ChildMissionBinding } from "../session-manager.js";

// =============================================================================
// Paths
// =============================================================================

/** Dedicated directory for durable child AgentSessions (discoverable by id). */
export function defaultChildSessionDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "child-sessions");
}

// =============================================================================
// Structured errors
// =============================================================================

export type ChildSessionRestoreErrorCode =
	| "MISSION_NOT_FOUND"
	| "MISSION_CORRUPT"
	| "MISSION_NOT_RESUMABLE"
	| "MISSION_TERMINAL"
	| "NOT_A_DURABLE_CHILD"
	| "CHILD_SESSION_NOT_FOUND"
	| "CHILD_SESSION_CORRUPT"
	| "CHILD_SESSION_BINDING_MISMATCH";

export class ChildSessionRestoreError extends Error {
	readonly code: ChildSessionRestoreErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: ChildSessionRestoreErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "ChildSessionRestoreError";
		this.code = code;
		this.details = details;
	}
}

// =============================================================================
// Binding
// =============================================================================

/**
 * Establish or validate the durable child session<->mission binding.
 *
 * On first execution no binding exists: it is persisted (identity correlation
 * only, never mission state). On restore the binding must already match;
 * otherwise the load fails closed and the session is never silently rebound.
 */
export function bindChildSession(
	sessionManager: SessionManager,
	missionId: string,
	parentMissionId?: string,
): ChildMissionBinding {
	const sessionId = sessionManager.getSessionId();
	const existing = sessionManager.getLatestChildBinding();
	if (existing) {
		if (existing.sessionId !== sessionId || existing.missionId !== missionId) {
			throw new ChildSessionRestoreError(
				"CHILD_SESSION_BINDING_MISMATCH",
				`Session ${sessionId} is bound to mission ${existing.missionId}, not ${missionId}`,
				{ sessionId, expectedMissionId: missionId, actualMissionId: existing.missionId },
			);
		}
		return existing;
	}
	const binding: ChildMissionBinding = { sessionId, missionId, parentMissionId };
	sessionManager.appendChildBinding(binding);
	return binding;
}

// =============================================================================
// Resolve (locate + validate) for explicit resume
// =============================================================================

export interface ResolvedChildSession {
	record: DurableMissionRecord;
	sessionManager: SessionManager;
	childSessionId: string;
	binding: ChildMissionBinding;
}

/**
 * Load a durable child mission and resolve + validate its bound AgentSession.
 *
 * Fails conservatively (never fabricates or rebinds) for: missing/corrupt
 * mission, terminal mission, mission without a durable child session id, missing
 * session file, corrupt session file, or a binding mismatch.
 */
export async function resolveChildSessionForResume(options: {
	store: DurableMissionStore;
	missionId: string;
	sessionDir?: string;
}): Promise<ResolvedChildSession> {
	const { store, missionId, sessionDir } = options;
	const loaded = await store.load(missionId);
	if (loaded.status === "missing") {
		throw new ChildSessionRestoreError("MISSION_NOT_FOUND", `Mission not found: ${missionId}`, { missionId });
	}
	if (loaded.status === "corrupt") {
		throw new ChildSessionRestoreError("MISSION_CORRUPT", `Mission ${missionId} is corrupt: ${loaded.diagnostic}`, {
			missionId,
			diagnostic: loaded.diagnostic,
		});
	}
	const record = loaded.record;

	if (isTerminalMissionState(record.state)) {
		throw new ChildSessionRestoreError(
			"MISSION_TERMINAL",
			`Cannot resume terminal mission ${missionId} (${record.state})`,
			{ missionId, state: record.state },
		);
	}
	if (!isResumableMissionState(record.state) || (record.state !== "INTERRUPTED" && record.state !== "CREATED")) {
		throw new ChildSessionRestoreError(
			"MISSION_NOT_RESUMABLE",
			`Cannot resume mission ${missionId} from state ${record.state}; reconcile (recover) first`,
			{ missionId, state: record.state },
		);
	}

	const childSessionId = record.request.childSessionId;
	if (!childSessionId) {
		throw new ChildSessionRestoreError(
			"NOT_A_DURABLE_CHILD",
			`Mission ${missionId} has no durable child session identity`,
			{ missionId },
		);
	}

	const dir = sessionDir ?? defaultChildSessionDir();
	const info = await SessionManager.findByExactIdInDir(childSessionId, dir);
	if (!info) {
		throw new ChildSessionRestoreError(
			"CHILD_SESSION_NOT_FOUND",
			`Child session not found for mission ${missionId}: ${childSessionId}`,
			{ missionId, childSessionId },
		);
	}
	const validation = validateSessionFile(info.path);
	if (!validation.ok) {
		throw new ChildSessionRestoreError(
			"CHILD_SESSION_CORRUPT",
			`Child session ${childSessionId} is corrupt: ${validation.reason}`,
			{ missionId, childSessionId, reason: validation.reason },
		);
	}

	const sessionManager = SessionManager.open(info.path, dir);
	if (sessionManager.getSessionId() !== childSessionId) {
		throw new ChildSessionRestoreError(
			"CHILD_SESSION_BINDING_MISMATCH",
			`Child session identity mismatch: expected ${childSessionId}, loaded ${sessionManager.getSessionId()}`,
			{ missionId, expectedSessionId: childSessionId, actualSessionId: sessionManager.getSessionId() },
		);
	}

	const binding = sessionManager.getLatestChildBinding();
	if (!binding || binding.missionId !== missionId || binding.sessionId !== childSessionId) {
		throw new ChildSessionRestoreError(
			"CHILD_SESSION_BINDING_MISMATCH",
			`Child session ${childSessionId} is not bound to mission ${missionId}`,
			{ missionId, childSessionId, binding },
		);
	}

	return { record, sessionManager, childSessionId, binding };
}

// =============================================================================
// Operational checkpoint reconstruction
// =============================================================================

/**
 * Rebuild a bounded operational checkpoint from the durable session state plus
 * the immutable mission request. This is the same projection the live
 * ContextGovernor uses; here it is rebuilt from a cold SessionManager so a
 * resumed child continues the same mission rather than replaying it.
 */
export function buildChildResumeCheckpoint(
	record: DurableMissionRecord,
	sessionManager: SessionManager,
): MissionContextCheckpoint {
	const todos = sessionManager.getLatestSessionTodos();
	const memory = sessionManager.getLatestSessionMemory();
	const tasks = sessionManager.getLatestSessionTasks();
	const evidenceRefs = sessionManager.getLatestSessionEvidenceRefs();

	const completedSteps = todos.filter((t) => t.status === "completed").map((t) => t.content);
	const pendingSteps = todos
		.filter((t) => t.status !== "completed")
		.map((t) => (t.status === "in_progress" ? t.activeForm : t.content));
	const nextActions = tasks
		.filter((t) => t.status !== "completed")
		.map((t) => t.activeForm ?? t.subject)
		.slice(0, 12);

	const findings = memory.slice(0, 24).map((m) => ({ subject: m.key, detail: m.value }));
	const decisions = memory
		.slice(0, 24)
		.filter((m) => m.key.startsWith("decision") || m.key.startsWith("decisions"))
		.map((m) => ({ decision: m.key, rationale: m.value }));

	const activeFiles: string[] = [];
	const compaction = getLatestCompactionEntry(sessionManager.getBranch());
	const details = compaction?.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined;
	const fileSet = new Set<string>();
	for (const f of details?.readFiles ?? []) fileSet.add(f);
	for (const f of details?.modifiedFiles ?? []) fileSet.add(f);
	activeFiles.push(...[...fileSet].slice(0, 64));

	return createMissionContextCheckpoint(record.missionId, {
		objective: record.request.objective,
		constraints: [...(record.request.constraints ?? [])],
		decisions,
		plan: "",
		completedSteps,
		pendingSteps,
		activeFiles,
		findings,
		evidenceRefs: evidenceRefs.slice(-24),
		testState: {},
		blockers: [],
		nextActions,
	});
}

/** The explicit-resume prompt a child receives to CONTINUE rather than replay. */
export function buildChildResumePrompt(record: DurableMissionRecord, sessionManager: SessionManager): string {
	const checkpoint = buildChildResumeCheckpoint(record, sessionManager);
	const preamble = checkpointToRehydrationPreamble(checkpoint);
	return [
		"<resume-instruction>",
		`You are resuming durable child mission ${record.missionId}.`,
		`Bound child AgentSession: ${record.request.childSessionId ?? "(unknown)"}.`,
		"This is a NEW execution attempt; the previous attempt was interrupted.",
		"Continue the REMAINING work. Do not replay already-completed steps. First verify current filesystem and test state against the checkpoint below, then proceed conservatively and surface any ambiguity.",
		"</resume-instruction>",
		"",
		preamble,
	].join("\n");
}

// =============================================================================
// Explicit resume orchestration
// =============================================================================

export interface ResumeChildMissionOptions {
	store: DurableMissionStore;
	missionId: string;
	sessionDir?: string;
	/** Builds the concrete child CLI launch for the resume execution attempt. */
	buildResumeLaunch: (input: {
		request: DurableMissionRecord["request"];
		resumePrompt: string;
		childSessionId: string;
	}) => ProcessMissionLaunch;
	/** Executor identity (tests). */
	executorId?: string;
	/** Optional verifier that can promote a clean exit-0 child to SUCCEEDED. */
	verifier?: ProcessMissionVerifier;
	/** Attempt identity factory (tests). */
	attemptIdFactory?: () => string;
	now?: () => number;
}

export interface BuiltChildResume {
	childSessionId: string;
	resumePrompt: string;
	executor: ProcessMissionExecutor;
}

/**
 * Build the continue-not-replay child executor from a resolved session. This is
 * the single executor-construction path shared by the direct resume helper and
 * the Mission Control plane, so the two can never drift in how a resume launch
 * is produced.
 */
export function buildChildResumeExecutor(options: {
	record: DurableMissionRecord;
	sessionManager: SessionManager;
	childSessionId: string;
	buildResumeLaunch: ResumeChildMissionOptions["buildResumeLaunch"];
	executorId?: string;
	verifier?: ProcessMissionVerifier;
}): BuiltChildResume {
	const { record, sessionManager, childSessionId } = options;
	const resumePrompt = buildChildResumePrompt(record, sessionManager);
	const executor = new ProcessMissionExecutor({
		executorId: options.executorId ?? "subagent-process-resume",
		verifier: options.verifier,
		buildLaunch: (request) => options.buildResumeLaunch({ request, resumePrompt, childSessionId }),
	});
	return { childSessionId, resumePrompt, executor };
}

/**
 * Explicitly resume an interrupted durable child to terminal state.
 *
 * Resolves the SAME mission + SAME session, validates the binding, builds a
 * continue-not-replay prompt from the durable checkpoint, and drives the
 * coordinator to allocate a NEW attempt/execution before launching the child.
 */
export async function resumeChildMission(
	delegator: DurableMissionDelegator,
	options: ResumeChildMissionOptions,
): Promise<ReturnType<DurableMissionDelegator["resumeMission"]>> {
	const resolved = await resolveChildSessionForResume({
		store: options.store,
		missionId: options.missionId,
		sessionDir: options.sessionDir,
	});
	const built = buildChildResumeExecutor({
		record: resolved.record,
		sessionManager: resolved.sessionManager,
		childSessionId: resolved.childSessionId,
		buildResumeLaunch: options.buildResumeLaunch,
		executorId: options.executorId,
		verifier: options.verifier,
	});

	return delegator.resumeMission(options.missionId, built.executor);
}
