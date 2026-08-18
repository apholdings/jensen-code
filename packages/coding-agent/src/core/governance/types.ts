/**
 * Mission Governance domain contracts.
 *
 * Governance is a policy/admission/decision layer. It does not launch work,
 * select executors, acquire inference leases, or commit Mission state.
 */

import type { InferencePriority, SharedInferenceResourceStatus } from "../shared-inference/types.js";

/** Maximum number of recent policy decisions retained in each durable ledger. */
export const GOVERNANCE_DECISION_HISTORY_LIMIT = 100;

export type GovernanceAction =
	| "CONTINUE"
	| "PARK"
	| "THROTTLE"
	| "DENY_NEW_CHILD"
	| "DENY_INFERENCE"
	| "REQUEST_REPLAN"
	| "RETRY_OUTPUT_CONTRACT"
	| "RETRY_TOOL"
	| "RETRY_EXECUTION"
	| "RETRY_PLANNER"
	| "RETRY_REMOTE_EXECUTION"
	| "ESCALATE_MODEL"
	| "TERMINATE_CHILD"
	| "TERMINATE_MISSION";
export type GovernanceStatus = "NORMAL" | "NEAR_LIMIT" | "LIMIT_REACHED" | "UNKNOWN";
export type GovernanceScope = "child" | "parent" | "orchestration" | "session";
export type GovernanceRetryClass =
	| "tool"
	| "output_contract"
	| "execution"
	| "planner"
	| "replan"
	| "remote_execution"
	| "provider";
export type GovernanceCostStatus = "KNOWN" | "UNKNOWN" | "NONE";
export interface GovernanceCorrelation {
	parentMissionId?: string;
	orchestrationId?: string;
	nodeId?: string;
	phase?: string;
	attempt?: number;
}
export type GovernanceModelMode =
	| "local_default"
	| "cloud_escalation"
	| "cloud_prohibited"
	| "cloud_preferred"
	| "fixed"
	| "fallback_chain";
export type GovernanceProgressState =
	| "ACTIVE_PROGRESS"
	| "IDLE_WAIT"
	| "RESOURCE_WAIT"
	| "BLOCKED_DEPENDENCY"
	| "STAGNATING";

export interface GovernanceBudget {
	maxTurns?: number;
	maxContextTokens?: number;
	maxGeneratedTokens?: number;
	maxToolCalls?: number;
	maxRetries?: number;
	maxWallClockMs?: number;
	maxInferenceRequests?: number;
	maxChildren?: number;
	maxLogicalAgents?: number;
	maxTotalRetries?: number;
	maxReplans?: number;
	maxFanOut?: number;
	maxDepth?: number;
	maxReadyChildren?: number;
	maxCloudSpendUsd?: number;
	maxModelEscalations?: number;
}

export interface GovernancePolicy {
	schemaVersion: 1;
	operator?: GovernanceBudget;
	mission?: GovernanceBudget;
	orchestration?: GovernanceBudget;
	child?: GovernanceBudget;
	cloudAllowed: boolean;
	modelMode: GovernanceModelMode;
	localModel: { provider: string; model: string };
	fixedModel?: { provider: string; model: string };
	cloudEscalation?: { provider: string; model: string };
	fallbackChain?: readonly { provider: string; model: string }[];
	softWallClockRatio?: number;
	stagnation?: { maxNoProgressTurns: number; maxRepeatedFailure: number; maxOutputContractRetries: number };
	retryCaps?: Partial<Record<GovernanceRetryClass, number>>;
}

export interface GovernanceBudgetUsage {
	turns: number;
	contextTokens: number;
	generatedTokens: number;
	toolCalls: number;
	retries: number;
	wallClockMs: number;
	inferenceRequests: number;
	children: number;
	logicalAgents: number;
	totalRetries: number;
	replans: number;
	fanOut: number;
	depth: number;
	readyChildren: number;
	cloudSpendUsd: number;
	modelEscalations: number;
}
export interface GovernanceRetryUsage {
	tool: number;
	output_contract: number;
	execution: number;
	planner: number;
	replan: number;
	remote_execution: number;
	provider: number;
}
export interface GovernanceCostUsage {
	status: GovernanceCostStatus;
	knownUsd: number;
	unknownPaidEvents: number;
	localInferenceRequests: number;
}
export interface GovernanceEvent {
	eventId: string;
	scope: GovernanceScope;
	kind: "consume" | "retry" | "decision" | "escalation" | "progress";
	resource?: keyof GovernanceBudgetUsage;
	amount?: number;
	retryClass?: GovernanceRetryClass;
	costStatus?: GovernanceCostStatus;
	costUsd?: number;
	provider?: string;
	model?: string;
	childId?: string;
	reason?: string;
	correlation?: GovernanceCorrelation;
	atMs: number;
}
export interface GovernanceEscalationRecord {
	escalationId: string;
	from: { provider: string; model: string };
	to: { provider: string; model: string };
	reason: string;
	missionId: string;
	orchestrationId?: string;
	nodeId?: string;
	logicalAgentId?: string;
	assignmentId?: string;
	executionId?: string;
	sessionId?: string;
	atMs: number;
}
export interface GovernanceDecision {
	action: GovernanceAction;
	status: GovernanceStatus;
	reason: string;
	evidence: readonly GovernanceEvidence[];
	from?: { provider: string; model: string };
	to?: { provider: string; model: string };
	preserveIdentity: boolean;
	atMs: number;
}
export interface GovernanceLedger {
	schemaVersion: 1;
	missionId: string;
	parentMissionId?: string;
	revision: number;
	usage: GovernanceBudgetUsage;
	retries: GovernanceRetryUsage;
	cost: GovernanceCostUsage;
	escalationHistory: GovernanceEscalationRecord[];
	/** Most-recent decision is also retained in `lastDecision` for compatibility. */
	decisionHistory: GovernanceDecision[];
	events: GovernanceEvent[];
	lastDecision?: GovernanceDecision;
}
export interface GovernanceContext {
	missionId: string;
	parentMissionId?: string;
	scope: GovernanceScope;
	provider: string;
	model: string;
	isPaidInference?: boolean;
	costStatus?: GovernanceCostStatus;
	usage: GovernanceBudgetUsage;
	retries: GovernanceRetryUsage;
	cost: GovernanceCostUsage;
	progress?: {
		state: GovernanceProgressState;
		noProgressTurns: number;
		repeatedFailureCount: number;
		lastProgressAtMs?: number;
	};
	wallClockNowMs: number;
	wallClockStartedAtMs: number;
	requestedChildren?: number;
	orchestrationDepth?: number;
	readyChildren?: number;
	outputContractMissing?: boolean;
	resourceWait?: boolean;
	dependencyBlocked?: boolean;
	inferenceStatus?: SharedInferenceResourceStatus;
	priority?: InferencePriority;
	orchestrationId?: string;
	nodeId?: string;
}
export interface GovernanceEvidence {
	code: string;
	observed: Readonly<Record<string, string | number | boolean | undefined>>;
}
export interface GovernanceStatusSnapshot {
	missionId: string;
	parentMissionId?: string;
	revision: number;
	status: GovernanceStatus;
	usage: GovernanceBudgetUsage;
	remaining: Partial<GovernanceBudgetUsage>;
	retries: GovernanceRetryUsage;
	cost: GovernanceCostUsage;
	escalations: number;
	lastDecision?: GovernanceDecision;
}
export interface GovernanceConsumeRequest {
	eventId: string;
	scope: GovernanceScope;
	resource: keyof GovernanceBudgetUsage;
	amount: number;
	atMs: number;
	provider?: string;
	model?: string;
	costStatus?: GovernanceCostStatus;
	costUsd?: number;
	childId?: string;
	correlation?: GovernanceCorrelation;
}
export interface GovernanceConsumeResult {
	allowed: boolean;
	reason?: string;
	ledger: GovernanceLedger;
}
export interface GovernanceOrchestrationChildRequest {
	missionId: string;
	eventId: string;
	childId: string;
	atMs: number;
	orchestrationDepth: number;
	correlation: GovernanceCorrelation;
}
export interface GovernanceModelTransition {
	missionId: string;
	eventId: string;
	from: { provider: string; model: string };
	to: { provider: string; model: string };
	reason: string;
	atMs: number;
	orchestrationId?: string;
	nodeId?: string;
	logicalAgentId?: string;
	assignmentId?: string;
	executionId?: string;
	sessionId?: string;
}
export interface GovernanceStore {
	readonly storeId: string;
	create(ledger: GovernanceLedger): Promise<"created" | "idempotent" | "conflict">;
	load(
		missionId: string,
	): Promise<
		{ status: "ok"; ledger: GovernanceLedger } | { status: "missing" } | { status: "corrupt"; diagnostic: string }
	>;
	mutate<T>(
		missionId: string,
		mutation: (
			ledger: GovernanceLedger,
		) => { kind: "write"; ledger: GovernanceLedger; value: T } | { kind: "noop"; value: T },
	): Promise<{ status: "ok"; value: T } | { status: "missing" } | { status: "corrupt"; diagnostic: string }>;
}
export interface GovernanceModelResolution {
	mode: GovernanceModelMode;
	selected: { provider: string; model: string };
	fallbackChain: readonly { provider: string; model: string }[];
	reason: string;
}
