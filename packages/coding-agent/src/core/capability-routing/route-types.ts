/**
 * Capability Routing — route model (2.15.0).
 *
 * Deterministic execution-location routing. This module answers one question:
 * "which execution routes satisfy this Mission's hard requirements, and are they
 * available right now?" It never selects a final executor (the Scheduler does),
 * never routes inference, and never models shared-Qwen capacity.
 *
 *   - Execution route  → where tool/process work physically runs.
 *   - Inference route  → where a model request gets a physical slot (NEXT phase).
 *   - Scheduler policy → which eligible route receives the assignment.
 *
 * These are four distinct facts; this module owns only the first.
 */

import type {
	CompatibilityRequirementItem,
	ExecutionRouteMode,
	MissionRequirements,
} from "../assignment/assignment-types.js";
import type { ExecutorCapabilities, ExecutorLivenessStatus } from "../executor-registry/executor-registry-types.js";
import type { RemoteTargetHealth, RemoteTransportKind } from "../remote-execution/remote-target-types.js";

// =============================================================================
// Structured errors
// =============================================================================

export type CapabilityRoutingErrorCode =
	| "INVALID_REQUIREMENTS"
	| "NO_EXECUTORS"
	| "MISSION_NOT_FOUND"
	| "MISSION_CORRUPT"
	| "MISSION_TERMINAL";

export class CapabilityRoutingError extends Error {
	readonly code: CapabilityRoutingErrorCode;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: CapabilityRoutingErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
		super(message);
		this.name = "CapabilityRoutingError";
		this.code = code;
		this.details = Object.freeze({ ...details });
	}
}

// =============================================================================
// Routability states
// =============================================================================

/**
 * Structured route state. `ELIGIBLE` means the route satisfies every hard
 * requirement and is available now; each rejection/unavailability is a distinct,
 * explainable state rather than one opaque boolean.
 */
export type RoutabilityStatus =
	| "ELIGIBLE"
	| "INELIGIBLE_CAPABILITY"
	| "INELIGIBLE_PLATFORM"
	| "INELIGIBLE_ARCH"
	| "INELIGIBLE_EXECUTION_MODE"
	| "UNAVAILABLE_WORKER"
	| "UNAVAILABLE_TARGET"
	| "UNKNOWN_REQUIREMENT";

// =============================================================================
// Route + candidate
// =============================================================================

/** A fully-resolved execution route, independent of requirement evaluation. */
export interface ExecutionRoute {
	executorId: string;
	executionMode: ExecutionRouteMode;
	remoteTargetId?: string;
	transport?: RemoteTransportKind;
	/** Authoritative execution platform (target platform for remote routes). */
	platform?: string;
	arch?: string;
	/** Executor-declared execution capabilities (never target-inferred). */
	capabilities: ExecutorCapabilities;
	/** Worker liveness, independent of capabilities. */
	status: ExecutorLivenessStatus;
	retired: boolean;
	/** Present for remote routes; resolved/deduplicated outside the evaluator. */
	targetHealth?: RemoteTargetHealth;
}

/**
 * One executor route evaluated against a Mission's hard requirements plus
 * current availability. Eligibility is deterministic; every rejection carries a
 * structured reason.
 */
export interface RouteCandidate {
	executorId: string;
	executionMode: ExecutionRouteMode;
	remoteTargetId?: string;
	transport?: RemoteTransportKind;
	platform?: string;
	arch?: string;
	/** True only when every hard requirement matches AND the route is available. */
	eligible: boolean;
	status: RoutabilityStatus;
	/** Static hard-requirement match (platform/arch/execution-mode/capabilities). */
	capabilityMatch: boolean;
	platformMatch: boolean;
	archMatch: boolean;
	executionModeMatch: boolean;
	/** Worker is ONLINE and not retired. */
	workerAvailable: boolean;
	/** Remote target reachable (or no target required for local routes). */
	targetAvailable: boolean;
	workerStatus: ExecutorLivenessStatus;
	retired: boolean;
	targetHealth?: RemoteTargetHealth;
	matchedRequirements: CompatibilityRequirementItem[];
	rejectedRequirements: CompatibilityRequirementItem[];
	rejectionReasons: string[];
	/** Ranking metadata only; never eligibility. Higher = more preferred. */
	preferenceScore: number;
	preferenceReasons: string[];
}

// =============================================================================
// Evaluation
// =============================================================================

export interface RoutingEvaluation {
	missionId?: string;
	requirements: MissionRequirements;
	candidates: RouteCandidate[];
	eligibleCount: number;
	eligibleExecutorIds: string[];
	/** Corrupt executor records surfaced structurally, never guessed. */
	corrupt: { executorId: string; diagnostic: string }[];
	/** Corrupt/unresolvable target records surfaced structurally. */
	targetCorrupt: { targetId: string; diagnostic: string }[];
	evaluatedAtMs: number;
}

/** Narrow evaluator port consumed by the Scheduler (never a full router). */
export interface CapabilityRouteEvaluator {
	evaluate(input: { requirements: MissionRequirements; missionId?: string }): Promise<RoutingEvaluation>;
}

export type { ExecutionRouteMode };
