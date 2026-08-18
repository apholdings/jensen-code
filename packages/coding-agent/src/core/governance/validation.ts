import type {
	GovernanceAction,
	GovernanceDecision,
	GovernanceEscalationRecord,
	GovernanceEvent,
	GovernanceLedger,
	GovernanceRetryClass,
	GovernanceScope,
	GovernanceStatus,
} from "./types.js";
import { GOVERNANCE_DECISION_HISTORY_LIMIT } from "./types.js";

const RETRY_KEYS = [
	"tool",
	"output_contract",
	"execution",
	"planner",
	"replan",
	"remote_execution",
	"provider",
] as const;
const USAGE_KEYS = [
	"turns",
	"contextTokens",
	"generatedTokens",
	"toolCalls",
	"retries",
	"wallClockMs",
	"inferenceRequests",
	"children",
	"logicalAgents",
	"totalRetries",
	"replans",
	"fanOut",
	"depth",
	"readyChildren",
	"cloudSpendUsd",
	"modelEscalations",
] as const;
const ACTIONS: readonly GovernanceAction[] = [
	"CONTINUE",
	"PARK",
	"THROTTLE",
	"DENY_NEW_CHILD",
	"DENY_INFERENCE",
	"REQUEST_REPLAN",
	"RETRY_OUTPUT_CONTRACT",
	"RETRY_TOOL",
	"RETRY_EXECUTION",
	"RETRY_PLANNER",
	"RETRY_REMOTE_EXECUTION",
	"ESCALATE_MODEL",
	"TERMINATE_CHILD",
	"TERMINATE_MISSION",
];
const STATUSES: readonly GovernanceStatus[] = ["NORMAL", "NEAR_LIMIT", "LIMIT_REACHED", "UNKNOWN"];
const SCOPES: readonly GovernanceScope[] = ["child", "parent", "orchestration", "session"];
const RETRY_CLASSES: readonly GovernanceRetryClass[] = [
	"tool",
	"output_contract",
	"execution",
	"planner",
	"replan",
	"remote_execution",
	"provider",
];

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function count(value: unknown): value is number {
	return nonNegativeFinite(value) && Number.isSafeInteger(value);
}
function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
	return typeof value === "string" && values.includes(value as T);
}
function model(value: unknown): value is { provider: string; model: string } {
	return record(value) && nonEmptyString(value.provider) && nonEmptyString(value.model);
}
function decision(value: unknown): value is GovernanceDecision {
	if (
		!record(value) ||
		!oneOf(value.action, ACTIONS) ||
		!oneOf(value.status, STATUSES) ||
		!nonEmptyString(value.reason)
	)
		return false;
	if (!Array.isArray(value.evidence) || !count(value.atMs) || typeof value.preserveIdentity !== "boolean")
		return false;
	if (value.from !== undefined && !model(value.from)) return false;
	if (value.to !== undefined && !model(value.to)) return false;
	return value.evidence.every(
		(item) =>
			record(item) &&
			nonEmptyString(item.code) &&
			record(item.observed) &&
			Object.values(item.observed).every(
				(observed) =>
					observed === undefined ||
					typeof observed === "string" ||
					typeof observed === "number" ||
					typeof observed === "boolean",
			),
	);
}
function escalation(value: unknown): value is GovernanceEscalationRecord {
	return (
		record(value) &&
		nonEmptyString(value.escalationId) &&
		model(value.from) &&
		model(value.to) &&
		nonEmptyString(value.reason) &&
		nonEmptyString(value.missionId) &&
		(value.orchestrationId === undefined || nonEmptyString(value.orchestrationId)) &&
		(value.nodeId === undefined || nonEmptyString(value.nodeId)) &&
		(value.logicalAgentId === undefined || nonEmptyString(value.logicalAgentId)) &&
		(value.assignmentId === undefined || nonEmptyString(value.assignmentId)) &&
		(value.executionId === undefined || nonEmptyString(value.executionId)) &&
		(value.sessionId === undefined || nonEmptyString(value.sessionId)) &&
		count(value.atMs)
	);
}
function event(value: unknown): value is GovernanceEvent {
	if (
		!record(value) ||
		!nonEmptyString(value.eventId) ||
		!oneOf(value.scope, SCOPES) ||
		!oneOf(value.kind, ["consume", "retry", "decision", "escalation", "progress"] as const) ||
		!count(value.atMs)
	)
		return false;
	if (value.resource !== undefined && !USAGE_KEYS.includes(value.resource as (typeof USAGE_KEYS)[number]))
		return false;
	if (value.amount !== undefined && !nonNegativeFinite(value.amount)) return false;
	if (value.retryClass !== undefined && !oneOf(value.retryClass, RETRY_CLASSES)) return false;
	if (value.costStatus !== undefined && !oneOf(value.costStatus, ["KNOWN", "UNKNOWN", "NONE"] as const)) return false;
	if (value.costUsd !== undefined && !nonNegativeFinite(value.costUsd)) return false;
	if (value.correlation !== undefined) {
		if (!record(value.correlation)) return false;
		for (const key of ["parentMissionId", "orchestrationId", "nodeId", "phase"])
			if (value.correlation[key] !== undefined && !nonEmptyString(value.correlation[key])) return false;
		if (value.correlation.attempt !== undefined && !count(value.correlation.attempt)) return false;
	}
	return (
		(value.provider === undefined || nonEmptyString(value.provider)) &&
		(value.model === undefined || nonEmptyString(value.model)) &&
		(value.childId === undefined || nonEmptyString(value.childId)) &&
		(value.reason === undefined || nonEmptyString(value.reason))
	);
}

export function validateGovernanceLedger(
	value: unknown,
	missionId: string,
): { valid: true; ledger: GovernanceLedger } | { valid: false; diagnostic: string } {
	if (!record(value)) return { valid: false, diagnostic: "ledger is not an object" };
	const ledger = value as Partial<GovernanceLedger>;
	if (ledger.schemaVersion !== 1 || ledger.missionId !== missionId || !count(ledger.revision))
		return { valid: false, diagnostic: "invalid identity or revision" };
	if (ledger.parentMissionId !== undefined && !nonEmptyString(ledger.parentMissionId))
		return { valid: false, diagnostic: "invalid parent mission identity" };
	if (!record(ledger.usage) || !record(ledger.retries) || !record(ledger.cost))
		return { valid: false, diagnostic: "missing ledger sections" };
	if (
		!Array.isArray(ledger.events) ||
		!Array.isArray(ledger.escalationHistory) ||
		!Array.isArray(ledger.decisionHistory)
	)
		return { valid: false, diagnostic: "missing ledger history sections" };
	for (const key of USAGE_KEYS) {
		if (key === "cloudSpendUsd" ? !nonNegativeFinite(ledger.usage[key]) : !count(ledger.usage[key]))
			return { valid: false, diagnostic: `invalid usage.${key}` };
	}
	for (const key of RETRY_KEYS)
		if (!count(ledger.retries[key])) return { valid: false, diagnostic: `invalid retries.${key}` };
	if (
		!oneOf(ledger.cost.status, ["KNOWN", "UNKNOWN", "NONE"] as const) ||
		!nonNegativeFinite(ledger.cost.knownUsd) ||
		!count(ledger.cost.unknownPaidEvents) ||
		!count(ledger.cost.localInferenceRequests)
	)
		return { valid: false, diagnostic: "invalid cost accounting" };
	if (ledger.decisionHistory.length > GOVERNANCE_DECISION_HISTORY_LIMIT)
		return { valid: false, diagnostic: "decision history exceeds bounded limit" };
	if (ledger.lastDecision !== undefined && !decision(ledger.lastDecision))
		return { valid: false, diagnostic: "invalid last decision" };
	for (const item of ledger.decisionHistory)
		if (!decision(item)) return { valid: false, diagnostic: "invalid decision history entry" };
	if (ledger.lastDecision !== undefined && ledger.decisionHistory.length > 0) {
		const latest = ledger.decisionHistory[ledger.decisionHistory.length - 1];
		if (JSON.stringify(latest) !== JSON.stringify(ledger.lastDecision))
			return { valid: false, diagnostic: "last decision does not match decision history" };
	}
	const ids = new Set<string>();
	for (const item of ledger.events) {
		if (!event(item) || ids.has(item.eventId))
			return { valid: false, diagnostic: "invalid or duplicate governance event" };
		ids.add(item.eventId);
	}
	const escalationIds = new Set<string>();
	for (const item of ledger.escalationHistory) {
		if (!escalation(item) || item.missionId !== missionId || escalationIds.has(item.escalationId))
			return { valid: false, diagnostic: "invalid or duplicate escalation record" };
		escalationIds.add(item.escalationId);
	}
	return { valid: true, ledger: ledger as GovernanceLedger };
}
