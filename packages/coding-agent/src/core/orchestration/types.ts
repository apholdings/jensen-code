import type { MissionRequirements } from "../assignment/assignment-types.js";
import type {
	MissionAcceptanceCriterion,
	MissionExecutionMode,
	MissionOrchestrationMetadata,
	MissionWorkspaceAccess,
} from "../mission-domain/mission-request.js";
import type { MissionState } from "../mission-domain/mission-state.js";

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
