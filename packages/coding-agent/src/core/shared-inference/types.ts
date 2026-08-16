/**
 * Shared Inference Scheduler — domain types (3.0.0 foundation).
 *
 * The central architectural invariant:
 *
 *   LOGICAL AGENT CONCURRENCY != INFERENCE CONCURRENCY
 *
 * A physical model resource (e.g. Qwen3.8-27B on Bucephalus) is loaded ONCE and
 * shared by many logical Jensen agents. An inference request is a short,
 * independently schedulable lease against that resource; it is never durable
 * agent ownership and never an Assignment-scoped reservation.
 *
 * Boundaries preserved here:
 *   - logical agent != Mission != Assignment != Worker process != execution
 *     target != inference slot.
 *   - Assignment ownership != inference-slot ownership.
 *   - execution location != inference location.
 *   - model residency != request concurrency.
 *
 * Nothing in this file depends on provider/CLI/UI machinery. The queue ledger
 * stores only correlation + estimate metadata; it NEVER stores prompts, message
 * bodies, or API credentials.
 */

// =============================================================================
// Shared inference resource (the physical model resource)
// =============================================================================

export type SharedInferenceResourceState = "available" | "unavailable" | "degraded";

/**
 * A physical, resident model resource shared by many logical clients.
 *
 * `capacity` is the physical generation-slot count (llama.cpp `--parallel` /
 * `total_slots`). It is a property of the resource, never of an agent,
 * assignment, worker, or execution target.
 */
export interface SharedInferenceResource {
	/** Stable resource identity, e.g. "qwen38-bucephalus". */
	resourceId: string;
	/** Backend/provider identity, e.g. "llamacpp-qwen38-bucephalus". */
	backend: string;
	/** Model identity, e.g. "qwen3.8-27b". */
	model: string;
	/** Physical location of the resident weights, e.g. "bucephalus". */
	location: string;
	/** Physical generation-slot capacity (>= 1). */
	capacity: number;
	/** Declared context window (tokens). Used for context-pressure telemetry. */
	contextWindow?: number;
	/** Declared max output tokens. */
	maxOutputTokens?: number;
	/** Operational state. */
	state: SharedInferenceResourceState;
	/** Optional base URL for capacity/slot observation. Never a secret. */
	baseUrl?: string;
}

// =============================================================================
// Inference request
// =============================================================================

export type InferenceRequestState = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED";

export const INFERENCE_REQUEST_STATES: ReadonlySet<InferenceRequestState> = new Set<InferenceRequestState>([
	"QUEUED",
	"RUNNING",
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"INTERRUPTED",
]);

export function isInferenceRequestState(value: unknown): value is InferenceRequestState {
	return typeof value === "string" && (INFERENCE_REQUEST_STATES as ReadonlySet<string>).has(value);
}

export const INFERENCE_TERMINAL_STATES: ReadonlySet<InferenceRequestState> = new Set<InferenceRequestState>([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"INTERRUPTED",
]);

/**
 * Structured, deterministic scheduling priority. No LLM-decided priority.
 *
 * `base` is the caller-provided importance. `interactive` and `verification`
 * are boolean signals mapped to fixed deterministic boosts by the scheduler.
 * `dependencyCriticality` (unblocksCount) is a structured signal from a future
 * Orchestrator; it is numeric and bounded, never model-inferred.
 */
export interface InferencePriority {
	/** Higher = more important. Default 0. */
	base: number;
	/** Interactive/foreground work (adds a fixed boost). */
	interactive?: boolean;
	/** Verification/reviewer work (adds a fixed boost). */
	verification?: boolean;
}

export interface InferenceRequestDependency {
	/**
	 * Number of downstream runnable work items this request would unlock. A
	 * deterministic dependency-criticality signal; full workflow-graph wiring
	 * belongs to the future Orchestrator.
	 */
	unblocksCount: number;
}

/**
 * Durable inference request record. This is a scheduling handle, not the model
 * prompt: the surrounding durable AgentSession already owns the (virtualized)
 * context; the queue persists only correlation + estimates.
 */
export interface InferenceRequestRecord {
	schemaVersion: 1;
	inferenceRequestId: string;
	logicalAgentId: string;
	/** Requester control-plane owner identity (for lease assignment, not a secret). */
	ownerId: string;
	missionId?: string;
	assignmentId?: string;
	executionId?: string;
	resourceId: string;
	provider: string;
	model: string;
	requestedAtMs: number;
	enqueuedAtMs: number;
	priority: InferencePriority;
	dependency?: InferenceRequestDependency;
	/** Estimated input tokens (metadata only; never the prompt). */
	estimatedInputTokens?: number;
	/** Requested max output tokens. */
	maxOutputTokens?: number;
	state: InferenceRequestState;
	/** Present only while RUNNING; fencing identity, not durable ownership. */
	lease?: InferenceRequestLease;
	/** Terminal/telemetry metadata. */
	admittedAtMs?: number;
	finishedAtMs?: number;
	queueWaitMs?: number;
	inferenceWallMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	errorMessage?: string;
}

/**
 * A temporary inference-slot lease. Slot identity is internal telemetry only;
 * it is never durable agent ownership.
 */
export interface InferenceRequestLease {
	ownerId: string;
	leaseId: string;
	slot: number;
	acquiredAtMs: number;
	expiresAtMs: number;
}

/** Bounded terminal summary retained in the ledger history ring. */
export interface InferenceRequestSummary {
	inferenceRequestId: string;
	logicalAgentId: string;
	resourceId: string;
	provider: string;
	model: string;
	requestedAtMs: number;
	enqueuedAtMs: number;
	state: InferenceRequestState;
	admittedAtMs?: number;
	finishedAtMs?: number;
	queueWaitMs?: number;
	inferenceWallMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	errorMessage?: string;
}

// =============================================================================
// Admission outcomes
// =============================================================================

export interface AdmittedInference {
	inferenceRequestId: string;
	resourceId: string;
	logicalAgentId: string;
	slot: number;
	lease: InferenceRequestLease;
}

export type AcquireInferenceOutcome =
	| { status: "admitted"; admitted: AdmittedInference }
	| { status: "queued"; inferenceRequestId: string; position: number }
	| { status: "cancelled"; inferenceRequestId: string; reason: string }
	| { status: "queue_timeout"; inferenceRequestId: string; waitedMs: number };

export type ReleaseInferenceOutcome = { status: "released"; inferenceRequestId: string } | { status: "not_found" };

// =============================================================================
// Scheduler status / telemetry
// =============================================================================

export interface InferenceRequestStatus {
	inferenceRequestId: string;
	logicalAgentId: string;
	resourceId: string;
	state: InferenceRequestState;
	position?: number;
	/** Effective deterministic priority (base + boosts + bounded aging). */
	effectivePriority: number;
	basePriority: number;
	agingContribution: number;
	dependencyContribution: number;
	queuedAtMs: number;
	requestedAtMs: number;
}

export interface SharedInferenceResourceStatus {
	resourceId: string;
	backend: string;
	model: string;
	location: string;
	capacity: number;
	busySlots: number;
	idleSlots: number;
	queueDepth: number;
	completedCount: number;
	cancelledCount: number;
	failedCount: number;
	interruptedCount: number;
	totalQueueWaitMs: number;
	totalInferenceMs: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	maxQueueDepth: number;
	contextTokensActive: number;
	contextTokensQueued: number;
	state: SharedInferenceResourceState;
	observedAtMs: number;
}

export interface SharedInferenceSchedulerStatus {
	resources: SharedInferenceResourceStatus[];
	queue: InferenceRequestStatus[];
	/** Aggregate deterministic counters. */
	aggregate: {
		totalSlots: number;
		busySlots: number;
		idleSlots: number;
		queueDepth: number;
		completedCount: number;
		avoidableIdleMs: number;
	};
	/** Logical-agent activity counts derived from the runtime (filled by the runtime when wired). */
	agents: {
		runningInference: number;
		waitingInference: number;
		tooling: number;
		parked: number;
		runnable: number;
		total: number;
	};
	observedAtMs: number;
}

export interface InferenceRecoveryReport {
	scannedResources: number;
	reconciledRequests: string[];
	unchangedRunning: string[];
	corruptResources: { resourceId: string; diagnostic: string }[];
	actions: string[];
}

// =============================================================================
// Logical agent (read/control model over existing durable identities)
// =============================================================================

/**
 * Logical agent activity. A read/control model over the existing durable
 * Mission/session/execution state; it does not replace Mission state.
 *
 * WAITING_INFERENCE does not mean the logical agent ceased to exist.
 */
export type LogicalAgentActivity =
	| "RUNNABLE"
	| "RUNNING_TOOL"
	| "WAITING_TOOL"
	| "WAITING_INFERENCE"
	| "RUNNING_INFERENCE"
	| "BLOCKED_DEPENDENCY"
	| "VERIFYING"
	| "PARKED"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "INTERRUPTED";

export const LOGICAL_AGENT_ACTIVITIES: ReadonlySet<LogicalAgentActivity> = new Set<LogicalAgentActivity>([
	"RUNNABLE",
	"RUNNING_TOOL",
	"WAITING_TOOL",
	"WAITING_INFERENCE",
	"RUNNING_INFERENCE",
	"BLOCKED_DEPENDENCY",
	"VERIFYING",
	"PARKED",
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"INTERRUPTED",
]);

export function isLogicalAgentActivity(value: unknown): value is LogicalAgentActivity {
	return typeof value === "string" && (LOGICAL_AGENT_ACTIVITIES as ReadonlySet<string>).has(value);
}

export const LOGICAL_AGENT_TERMINAL: ReadonlySet<LogicalAgentActivity> = new Set<LogicalAgentActivity>([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"INTERRUPTED",
]);

/**
 * Durable logical-agent record. Reuses existing identities; does not introduce a
 * second agent identity. `logicalAgentId` is the durable child session id (or an
 * equivalent stable correlation id for non-child logical work).
 */
export interface LogicalAgentRecord {
	schemaVersion: 1;
	logicalAgentId: string;
	parentAgentId?: string;
	missionId?: string;
	assignmentId?: string;
	attemptId?: string;
	executionId?: string;
	workerId?: string;
	executorId?: string;
	modelPolicy?: { provider: string; model: string };
	/** Session identity reference (session header id). */
	sessionId: string;
	/** Session directory handle (optional). */
	sessionDir?: string;
	/** Evidence references (cold archive ids), never raw artifact bodies. */
	evidenceRefs: string[];
	activity: LogicalAgentActivity;
	waitingReason?: string;
	pendingInferenceRequestId?: string;
	/** Deterministic base priority (higher = more important). */
	priority: number;
	createdAtMs: number;
	updatedAtMs: number;
	revision: number;
}
