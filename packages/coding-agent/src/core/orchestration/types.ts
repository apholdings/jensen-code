import type { MissionRequirements } from "../assignment/assignment-types.js";
import type {
	MissionAcceptanceCriterion,
	MissionExecutionMode,
	MissionOrchestrationMetadata,
	MissionWorkspaceAccess,
} from "../mission-domain/mission-request.js";
import type { MissionState } from "../mission-domain/mission-state.js";
import type { SchedulingIntentState } from "../scheduler/scheduler-types.js";
import type { WorkerActivity, WorkerDaemonState } from "../worker-daemon/worker-types.js";

export const ORCHESTRATION_SCHEMA_VERSION = 1 as const;

export type OrchestrationDecision = "DIRECT" | "FANOUT";
export type OrchestrationPlanState = "DRAFT" | "ACTIVE" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type OrchestrationNodeKind = MissionOrchestrationMetadata["nodeKind"];
export type OrchestrationNodeRequirement = MissionOrchestrationMetadata["requirement"];
export type OrchestrationNodeStatus =
	| "PROPOSED"
	| "BLOCKED"
	| "READY"
	| "MATERIALIZING"
	| "MATERIALIZED"
	| "RUNNING"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "UNSCHEDULABLE"
	| "SUPERSEDED";

export type OrchestrationReason =
	| "independent_recon"
	| "specialized_capability"
	| "parallel_tool_wait"
	| "independent_review"
	| "regression_verification"
	| "uncertainty_reduction"
	| "dependency_decomposition"
	| "synthesis_required"
	| "direct_trivial_task";

export interface OrchestrationNode {
	nodeId: string;
	role: string;
	nodeKind: OrchestrationNodeKind;
	objective: string;
	agent: string;
	executionMode: MissionExecutionMode;
	requirement: OrchestrationNodeRequirement;
	workspaceAccess: MissionWorkspaceAccess;
	workspaceKey?: string;
	independenceReason?: OrchestrationReason;
	requirements?: MissionRequirements;
	acceptanceCriteria: readonly MissionAcceptanceCriterion[];
	capabilities?: readonly string[];
	constraints?: readonly string[];
	priority?: number;
	verification?: boolean;
	dependencyCriticality: number;
	status: OrchestrationNodeStatus;
	childMissionId?: string;
	childSessionId?: string;
	lastChildState?: MissionState;
	lastError?: string;
}

export interface OrchestrationEdge {
	from: string;
	to: string;
	kind: "REQUIRED" | "OPTIONAL";
}

export interface OrchestrationPlan {
	schemaVersion: 1;
	orchestrationId: string;
	parentMissionId: string;
	decision: OrchestrationDecision;
	rationale: string;
	nodes: OrchestrationNode[];
	edges: OrchestrationEdge[];
	revision: number;
	state: OrchestrationPlanState;
	maxDepth: number;
	maxChildrenPerNode: number;
	maxTotalLogicalAgents: number;
	maxReplans: number;
	replanCount: number;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface OrchestrationPlanRevision {
	revision: number;
	reason: string;
	retainedNodeIds: string[];
	supersededNodeIds: string[];
	addedNodeIds: string[];
	recordedAtMs: number;
}

export interface OrchestrationPlanDocument {
	schemaVersion: 1;
	plan: OrchestrationPlan;
	revisions: OrchestrationPlanRevision[];
}

export interface OrchestrationValidationIssue {
	code:
		| "ORCHESTRATION_PLAN_INVALID"
		| "ORCHESTRATION_CYCLE"
		| "ORCHESTRATION_MISSING_DEPENDENCY"
		| "ORCHESTRATION_DUPLICATE_NODE"
		| "ORCHESTRATION_DUPLICATE_WORK"
		| "ORCHESTRATION_CHILD_LIMIT"
		| "ORCHESTRATION_DEPTH_EXCEEDED"
		| "ORCHESTRATION_UNSAFE_WRITERS"
		| "ORCHESTRATION_INVALID_ROLE"
		| "ORCHESTRATION_INVALID_REQUIREMENT";
	path: string;
	message: string;
}

export interface OrchestrationValidationResult {
	valid: boolean;
	issues: OrchestrationValidationIssue[];
	dependencyCriticality: ReadonlyMap<string, number>;
}

export interface OrchestrationGraphNode {
	nodeId: string;
	status: OrchestrationNodeStatus;
	role: string;
	objective: string;
	reason?: OrchestrationReason;
	childMissionId?: string;
	dependencies: string[];
	waitingFor: string[];
	workspaceAccess: MissionWorkspaceAccess;
}

export interface OrchestrationStatus {
	orchestrationId: string;
	parentMissionId: string;
	decision: OrchestrationDecision;
	state: OrchestrationPlanState;
	planRevision: number;
	replanCount: number;
	nodesTotal: number;
	childrenMaterialized: number;
	childrenActive: number;
	childrenBlocked: number;
	childrenCompleted: number;
	childrenFailed: number;
	childrenCancelled: number;
	localChildren: number;
	remoteChildren: number;
	runnableAgents: number;
	waitingInferenceAgents: number;
	toolingAgents: number;
	parkedAgents: number;
	fanoutReasonCounts: Partial<Record<OrchestrationReason, number>>;
	graph: OrchestrationGraphNode[];
}

export interface OrchestrationJoinResult {
	orchestrationId: string;
	parentMissionId: string;
	state: OrchestrationPlanState;
	decision: OrchestrationDecision;
	terminal: boolean;
	requiredFailures: string[];
	optionalFailures: string[];
	completedNodeIds: string[];
	pendingNodeIds: string[];
	results: Array<{ nodeId: string; missionId: string; state: MissionState; success: boolean; summary?: string }>;
}

export interface OrchestrationProposalInput {
	parentMissionId: string;
	objective: string;
	constraints: readonly string[];
	maxTotalLogicalAgents: number;
}

export interface OrchestrationPlanner {
	propose(input: OrchestrationProposalInput): Promise<unknown>;
	/**
	 * Optional: the agent names this planner may assign to nodes (for example
	 * the operator roster a Qwen planner derives from). When exposed,
	 * `OrchestratorService` passes the set to `validateOrchestrationPlan` as
	 * `operatorAgents`, keeping the planner's roster in sync with plan
	 * validation. Planners without this method are validated against the
	 * canonical subagent registry alone.
	 */
	allowedAgents?(): readonly string[];
}

export interface OrchestrationPlanProposal {
	decision: OrchestrationDecision;
	rationale: string;
	nodes: OrchestrationNode[];
	edges: OrchestrationEdge[];
}

export interface OrchestrationStore {
	readonly storeId: string;
	create(
		document: OrchestrationPlanDocument,
	): Promise<
		| { status: "created" }
		| { status: "idempotent"; document: OrchestrationPlanDocument }
		| { status: "conflict"; error: string }
	>;
	load(
		orchestrationId: string,
	): Promise<
		| { status: "ok"; document: OrchestrationPlanDocument }
		| { status: "missing" }
		| { status: "corrupt"; diagnostic: string }
	>;
	save(
		document: OrchestrationPlanDocument,
		options?: { expectedRevision?: number },
	): Promise<
		| { status: "saved"; document: OrchestrationPlanDocument }
		| { status: "stale"; expectedRevision: number; actualRevision?: number }
	>;
	mutate<T>(
		orchestrationId: string,
		mutation: (
			document: OrchestrationPlanDocument,
		) => { kind: "write"; document: OrchestrationPlanDocument; value: T } | { kind: "noop"; value: T },
	): Promise<{ status: "ok"; value: T } | { status: "missing" } | { status: "corrupt"; diagnostic: string }>;
	list(): Promise<string[]>;
	/** Optional cross-process exclusive reconciliation transaction. */
	withExclusive?<T>(
		orchestrationId: string,
		fn: (
			document: OrchestrationPlanDocument,
			save: (document: OrchestrationPlanDocument) => Promise<void>,
		) => Promise<T>,
	): Promise<T>;
}

// =============================================================================
// Child execution authority port
// =============================================================================

/**
 * Structured identity of a materialized orchestration child whose execution
 * the parent lifecycle executor wants to authorize and launch. Carries only
 * durable structured identity from the plan node — never PID, prompt text, or
 * ephemeral process state.
 */
export interface OrchestrationChildExecutionRequest {
	orchestrationId: string;
	nodeId: string;
	childMissionId: string;
	childSessionId: string;
	workspaceAccess: MissionWorkspaceAccess;
}

/** Receipt issued by a child execution authority for an execution request. */
export interface OrchestrationChildExecutionReceipt {
	/** Whether child execution was authorized and launched. */
	accepted: boolean;
	/** Authority identity that issued the receipt. */
	authority: string;
	/** Declined reason when `accepted` is false. */
	reason?: string;
}

/** Per-worker read-model snapshot for child status polling. */
export interface OrchestrationChildWorkerStatus {
	workerId: string;
	daemonState: WorkerDaemonState;
	activity: WorkerActivity;
	/** Set only when this worker's current assignment is the polled child mission. */
	executingChildMissionId?: string;
}

/**
 * Status/terminal polling snapshot of one materialized orchestration child.
 * Read-only: produced from the durable mission store, the scheduling intent
 * store, and the worker read model — never from process state.
 */
export interface OrchestrationChildExecutionStatus {
	orchestrationId: string;
	nodeId: string;
	childMissionId: string;
	childSessionId: string;
	/** Current mission state, or "MISSING" when the child was never materialized. */
	missionState: MissionState | "MISSING";
	/** True once the mission reached a terminal state. */
	terminal: boolean;
	/** True only for a terminal success result (SUCCEEDED). */
	success: boolean;
	/** Authoritative child result verification status, when terminal. */
	verificationStatus?: "verified" | "unverified" | "failed";
	/** Authoritative Completion Gate decision, when terminal. */
	completionDecision?: "accepted" | "rejected" | "unavailable";
	/** Compact deterministic verification summary, when available. */
	verificationSummary?: string;
	/** Scheduling intent for the child, when one has been enqueued. */
	intent?: {
		intentId: string;
		state: SchedulingIntentState;
		assignmentId?: string;
		unschedulableReason?: string;
	};
	/** Read-model snapshots of the configured workers (never launched by this port). */
	workers: OrchestrationChildWorkerStatus[];
}

/**
 * Child execution authority port.
 *
 * `OrchestratorService` stores this as an option (`childExecutionPort`) and
 * exposes it through its access seam; the parent lifecycle executor resolves
 * the authority named by
 * `MissionRequest.orchestrationExecution.childExecutionAuthority` against
 * `port.authority` and launches materialized children through `executeChild`.
 * The orchestrator never launches children itself — a port implementation
 * owns the launch (Mission/Scheduler, local runtime, or remote executor).
 */
export interface OrchestrationChildExecutionPort {
	/** Stable identity of this child execution authority. */
	readonly authority: string;
	/** Authorize and launch execution of a materialized orchestration child. */
	executeChild(request: OrchestrationChildExecutionRequest): Promise<OrchestrationChildExecutionReceipt>;
	/**
	 * Optional: status/terminal polling for a materialized child. Ports that
	 * own execution outside the Scheduler/Worker chain (local runtime, remote
	 * executor) may omit it; the parent lifecycle executor treats a missing
	 * implementation as a hard error, never a default.
	 */
	childStatus?(request: OrchestrationChildExecutionRequest): Promise<OrchestrationChildExecutionStatus>;
}

export function orchestrationMetadataForNode(
	plan: OrchestrationPlan,
	node: OrchestrationNode,
): MissionOrchestrationMetadata {
	return {
		orchestrationId: plan.orchestrationId,
		planRevision: plan.revision,
		nodeId: node.nodeId,
		role: node.role,
		nodeKind: node.nodeKind,
		requirement: node.requirement,
		workspaceAccess: node.workspaceAccess,
		independenceReason: node.independenceReason,
		dependencyCriticality: node.dependencyCriticality,
		priority: node.priority,
		verification: node.verification,
	};
}
