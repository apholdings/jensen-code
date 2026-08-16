/**
 * First-Class Mission Result (2.3.0).
 *
 * A MissionResult is structured outcome data, not prose. Parent code can
 * distinguish SUCCESS / FAILURE / PARTIAL / BLOCKED / CANCELLED / TIMED_OUT /
 * CRASHED without parsing presentation text. Executor diagnostics (exit code,
 * signal, stderr) live in a dedicated field and never masquerade as domain
 * state: a raw process exit of 0 is NEVER equivalent to mission SUCCEEDED.
 */

import type { MissionState } from "./mission-state.js";

// =============================================================================
// Component types
// =============================================================================

export type StructuredFailureCategory =
	| "LAUNCH"
	| "EXECUTION"
	| "VERIFICATION"
	| "CANCELLED"
	| "TIMED_OUT"
	| "CRASHED"
	| "BLOCKED";

export interface StructuredFailure {
	category: StructuredFailureCategory;
	message: string;
	code?: string;
	details?: unknown;
}

export interface MissionUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	turns?: number;
}

export interface MissionVerification {
	/**
	 * - `verified`: completion was proven by deterministic verification / the
	 *   Reliability Kernel Completion Gate.
	 * - `unverified`: execution finished but mission success was not proven.
	 * - `failed`: verification ran and did not pass.
	 */
	status: "verified" | "unverified" | "failed";
	summary?: string;
	criterionIds?: readonly string[];
}

/** Executor-specific diagnostics, kept separate from domain outcome. */
export interface ExecutorDiagnostics {
	executorId: string;
	processExitCode?: number | null;
	signal?: string;
	timedOut?: boolean;
	launchError?: string;
	stderr?: string;
	/** Remote execution location proof (host/user/cwd/pid/platform). */
	remoteLocation?: {
		host: string;
		user: string;
		cwd: string;
		pid: number;
		platform: string;
	};
	/** Remote execution evidence items (file hashes, command exits, ...). */
	remoteEvidence?: readonly unknown[];
	/** Remote target id the work executed on, when remote. */
	remoteTargetId?: string;
}

/**
 * Executor-level completion, independent of the mission-level `MissionState`.
 *
 * This is the single structured answer to "did the executor/process finish
 * normally?" It must NOT be conflated with verified mission success:
 *
 *   - `COMPLETED`: the executor finished normally and produced a usable result.
 *     The mission may still be UNVERIFIED (PARTIAL) or have failed verification
 *     (FAILED with a VERIFICATION failure). A raw exit code of 0 maps here.
 *   - `FAILED`/`CANCELLED`/`TIMED_OUT`/`CRASHED`: the execution itself did not
 *     finish normally (non-zero exit, abort, timeout, or failed launch).
 *
 * Consumers use this field (not prose) to decide whether dependent work may
 * continue in a chain.
 */
export type MissionExecutionOutcome = "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "CRASHED";

export const MISSION_EXECUTION_OUTCOMES: ReadonlySet<MissionExecutionOutcome> = new Set<MissionExecutionOutcome>([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TIMED_OUT",
	"CRASHED",
]);

/** Runtime type guard for a canonical MissionExecutionOutcome. */
export function isMissionExecutionOutcome(value: unknown): value is MissionExecutionOutcome {
	return typeof value === "string" && (MISSION_EXECUTION_OUTCOMES as ReadonlySet<string>).has(value);
}

// =============================================================================
// MissionResult
// =============================================================================

export interface MissionResult {
	readonly missionId: string;
	readonly parentMissionId?: string;
	readonly depth: number;
	/** Terminal lifecycle state. */
	readonly state: MissionState;
	/** Executor-level completion, distinct from mission-level `state`. */
	readonly executionOutcome: MissionExecutionOutcome;
	/** True only when state === SUCCEEDED (clean, verified mission success). */
	readonly success: boolean;
	/** Presentation text (optional, never the authority for domain status). */
	readonly outputText?: string;
	/** Evidence references produced/observed during execution. */
	readonly evidenceRefs: readonly string[];
	readonly verification: MissionVerification;
	/** Completion Gate decision when a gate was consulted; otherwise `unavailable`. */
	readonly completionDecision: "accepted" | "rejected" | "unavailable";
	readonly failures: readonly StructuredFailure[];
	readonly usage?: MissionUsage;
	readonly touchedResources?: readonly string[];
	readonly executorDiagnostics: ExecutorDiagnostics;
	readonly startedAtMs: number;
	readonly finishedAtMs: number;
}

export interface CreateMissionResultInput {
	missionId: string;
	parentMissionId?: string;
	depth: number;
	state: MissionState;
	executionOutcome: MissionExecutionOutcome;
	outputText?: string;
	evidenceRefs?: readonly string[];
	verification?: MissionVerification;
	completionDecision?: MissionResult["completionDecision"];
	failures?: readonly StructuredFailure[];
	usage?: MissionUsage;
	touchedResources?: readonly string[];
	executorDiagnostics: ExecutorDiagnostics;
	startedAtMs: number;
	finishedAtMs: number;
}

export function createMissionResult(input: CreateMissionResultInput): MissionResult {
	return Object.freeze({
		missionId: input.missionId,
		parentMissionId: input.parentMissionId,
		depth: input.depth,
		state: input.state,
		executionOutcome: input.executionOutcome,
		success: input.state === "SUCCEEDED",
		outputText: input.outputText,
		evidenceRefs: Object.freeze([...(input.evidenceRefs ?? [])]),
		verification: Object.freeze({
			status: input.verification?.status ?? "unverified",
			summary: input.verification?.summary,
			criterionIds: input.verification?.criterionIds
				? Object.freeze([...input.verification.criterionIds])
				: undefined,
		}),
		completionDecision: input.completionDecision ?? "unavailable",
		failures: Object.freeze([...(input.failures ?? [])]),
		usage: input.usage ? Object.freeze({ ...input.usage }) : undefined,
		touchedResources: input.touchedResources ? Object.freeze([...input.touchedResources]) : undefined,
		executorDiagnostics: Object.freeze({ ...input.executorDiagnostics }),
		startedAtMs: input.startedAtMs,
		finishedAtMs: input.finishedAtMs,
	});
}

// =============================================================================
// Honest process-outcome classification
// =============================================================================

/**
 * A plain-data description of an executor outcome. Deliberately has no
 * ChildProcess type so the classification stays portable and testable.
 */
export interface ExecutorOutcome {
	exitCode: number | null;
	signal?: string;
	timedOut?: boolean;
	launchError?: string;
	cancelled?: boolean;
}

export interface ExecutorOutcomeClassification {
	state: MissionState;
	/** Executor-level completion, always set alongside `state`. */
	executionOutcome: MissionExecutionOutcome;
	failure?: StructuredFailure;
	/** Human-readable reason for the classification (diagnostics, not authority). */
	reason: string;
}

/**
 * Classify an executor outcome into a terminal mission state.
 *
 * Invariant: a raw exit code of 0 without verification is classified as
 * PARTIAL ("execution completed but unverified"), never SUCCEEDED. SUCCEEDED
 * requires `verified: true` and a zero exit code.
 */
export function classifyExecutorOutcome(
	outcome: ExecutorOutcome,
	options: { verified?: boolean } = {},
): ExecutorOutcomeClassification {
	if (outcome.launchError) {
		return {
			state: "CRASHED",
			executionOutcome: "CRASHED",
			failure: { category: "LAUNCH", message: outcome.launchError },
			reason: "executor failed to launch",
		};
	}
	if (outcome.cancelled || outcome.signal === "SIGTERM" || outcome.signal === "SIGINT") {
		return {
			state: "CANCELLED",
			executionOutcome: "CANCELLED",
			failure: { category: "CANCELLED", message: `cancelled (signal ${outcome.signal ?? "external"})` },
			reason: "execution was cancelled",
		};
	}
	if (outcome.timedOut) {
		return {
			state: "TIMED_OUT",
			executionOutcome: "TIMED_OUT",
			failure: { category: "TIMED_OUT", message: "execution timed out" },
			reason: "execution timed out",
		};
	}
	if (outcome.exitCode === 0 && options.verified === true) {
		return {
			state: "SUCCEEDED",
			executionOutcome: "COMPLETED",
			reason: "execution completed and verification passed",
		};
	}
	if (outcome.exitCode === 0) {
		return {
			state: "PARTIAL",
			executionOutcome: "COMPLETED",
			reason: "execution completed but mission success was not verified",
		};
	}
	return {
		state: "FAILED",
		executionOutcome: "FAILED",
		failure: {
			category: "EXECUTION",
			message: `process exited with code ${outcome.exitCode}`,
			code: String(outcome.exitCode),
		},
		reason: `process exited with code ${outcome.exitCode}`,
	};
}

// =============================================================================
// Structured set aggregation (parallel / chain)
// =============================================================================

export interface MissionSetResult {
	readonly results: readonly MissionResult[];
	/** Structured aggregate outcome: SUCCEEDED / PARTIAL / FAILED. */
	readonly outcome: "SUCCEEDED" | "PARTIAL" | "FAILED";
	readonly succeeded: number;
	readonly partial: number;
	readonly failed: number;
	readonly cancelled: number;
	readonly timedOut: number;
	readonly crashed: number;
	readonly total: number;
	readonly allSucceeded: boolean;
	readonly someSucceeded: boolean;
	readonly allFailed: boolean;
	/**
	 * True when at least one child has a hard failure (FAILED, CANCELLED,
	 * TIMED_OUT, or CRASHED). Unverified-but-completed children (PARTIAL) do
	 * NOT set this.
	 */
	readonly anyHardFailure: boolean;
	/**
	 * True when every child's executor finished normally (executionOutcome ===
	 * "COMPLETED"), regardless of mission-level verification. Empty set: false.
	 */
	readonly allCompletedExecution: boolean;
}

/**
 * Aggregate a set of child MissionResults into a structured outcome.
 *
 *   - SUCCEEDED: every child SUCCEEDED (verified mission success).
 *   - FAILED:    at least one child hard-failed (FAILED / CANCELLED / TIMED_OUT
 *                / CRASHED).
 *   - PARTIAL:   no hard failures, but not every child was verified-successful
 *                (some children remain unverified/partial).
 *
 * An all-unverified set therefore reports PARTIAL (execution completed but
 * success unproven), never FAILED and never SUCCEEDED.
 */
export function aggregateMissionResults(results: readonly MissionResult[]): MissionSetResult {
	const summary = {
		succeeded: 0,
		partial: 0,
		failed: 0,
		cancelled: 0,
		timedOut: 0,
		crashed: 0,
	};

	for (const result of results) {
		switch (result.state) {
			case "SUCCEEDED":
				summary.succeeded += 1;
				break;
			case "PARTIAL":
				summary.partial += 1;
				break;
			case "FAILED":
				summary.failed += 1;
				break;
			case "CANCELLED":
				summary.cancelled += 1;
				break;
			case "TIMED_OUT":
				summary.timedOut += 1;
				break;
			case "CRASHED":
				summary.crashed += 1;
				break;
			default:
				// Non-terminal states are not expected in a completed set; treat as
				// a hard failure so a never-finished child cannot look like success.
				summary.failed += 1;
				break;
		}
	}

	const total = results.length;
	const allSucceeded = total > 0 && summary.succeeded === total;
	const allFailed = total > 0 && summary.succeeded === 0 && summary.partial === 0;
	const someSucceeded = summary.succeeded > 0 && !allSucceeded;
	const anyHardFailure = summary.failed + summary.cancelled + summary.timedOut + summary.crashed > 0;
	const allCompletedExecution = total > 0 && results.every((result) => result.executionOutcome === "COMPLETED");

	const outcome: MissionSetResult["outcome"] = allSucceeded
		? "SUCCEEDED"
		: anyHardFailure
			? "FAILED"
			: summary.partial > 0
				? "PARTIAL"
				: "FAILED";

	return Object.freeze({
		results: Object.freeze([...results]),
		outcome,
		...summary,
		total,
		allSucceeded,
		someSucceeded,
		allFailed,
		anyHardFailure,
		allCompletedExecution,
	});
}

// =============================================================================
// Chain continuation policy
// =============================================================================

/**
 * Chain continuation states for the transitional runtime (execution-compatible
 * chain). A child that SUCCEEDED (verified) or PARTIAL (execution completed
 * normally but unverified) may allow the next dependent child to run. Any hard
 * failure — FAILED / CANCELLED / TIMED_OUT / CRASHED — stops the chain.
 *
 * This deliberately does NOT upgrade PARTIAL to SUCCEEDED; it only recognizes
 * that an unverified-but-completed legacy child is not a failure signal.
 */
export const MISSION_CHAIN_CONTINUE_STATES: ReadonlySet<MissionState> = new Set<MissionState>(["SUCCEEDED", "PARTIAL"]);

/** True when a chain should continue to the next child after `result`. */
export function shouldContinueMissionChain(result: MissionResult): boolean {
	return MISSION_CHAIN_CONTINUE_STATES.has(result.state);
}
