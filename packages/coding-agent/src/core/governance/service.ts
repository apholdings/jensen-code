import { effectiveBudget } from "./evaluator.js";
import {
	consumeGovernanceInternal,
	createGovernanceLedger,
	FileGovernanceStore,
	recordGovernanceDecision,
	recordGovernanceEscalation,
	recordGovernanceRetry,
} from "./ledger.js";
import type {
	GovernanceBudget,
	GovernanceConsumeRequest,
	GovernanceConsumeResult,
	GovernanceCorrelation,
	GovernanceDecision,
	GovernanceEscalationRecord,
	GovernanceLedger,
	GovernanceModelTransition,
	GovernanceOrchestrationChildRequest,
	GovernancePolicy,
	GovernanceRetryClass,
	GovernanceStatusSnapshot,
} from "./types.js";

const RESOURCE_TO_LIMIT: Partial<Record<keyof GovernanceLedger["usage"], keyof GovernanceBudget>> = {
	turns: "maxTurns",
	contextTokens: "maxContextTokens",
	generatedTokens: "maxGeneratedTokens",
	toolCalls: "maxToolCalls",
	retries: "maxRetries",
	wallClockMs: "maxWallClockMs",
	inferenceRequests: "maxInferenceRequests",
	children: "maxChildren",
	logicalAgents: "maxLogicalAgents",
	totalRetries: "maxTotalRetries",
	replans: "maxReplans",
	fanOut: "maxFanOut",
	depth: "maxDepth",
	readyChildren: "maxReadyChildren",
	cloudSpendUsd: "maxCloudSpendUsd",
	modelEscalations: "maxModelEscalations",
};
const COUNT_RESOURCES = new Set<keyof GovernanceLedger["usage"]>([
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
	"modelEscalations",
]);

function hardLimitFor(
	policy: GovernancePolicy,
	resource: keyof GovernanceLedger["usage"] | keyof GovernanceBudget,
): number | undefined {
	const field = RESOURCE_TO_LIMIT[resource as keyof GovernanceLedger["usage"]];
	const budgetField = field ?? (resource as keyof GovernanceBudget);
	return effectiveBudget(policy)[budgetField];
}
function isLocalProvider(policy: GovernancePolicy, provider: string): boolean {
	return provider === policy.localModel.provider || provider.startsWith("llamacpp-");
}

/**
 * Durable Governance admission facade. It performs only policy arithmetic and
 * accounting. Callers perform the admitted action through their owning
 * authority (Scheduler, Worker, provider stream, or executor).
 */
export class GovernanceService {
	readonly store: FileGovernanceStore;
	readonly policy: GovernancePolicy;
	constructor(options: { store?: FileGovernanceStore; policy: GovernancePolicy }) {
		this.store = options.store ?? new FileGovernanceStore();
		this.policy = options.policy;
	}
	async ensureMission(missionId: string, parentMissionId?: string): Promise<void> {
		const result = await this.store.create(createGovernanceLedger(missionId, parentMissionId));
		if (result !== "conflict") return;
		const existing = await this.store.load(missionId);
		if (existing.status !== "ok") throw new Error(`GOVERNANCE_LEDGER_CONFLICT:${missionId}`);
		if (parentMissionId !== undefined && existing.ledger.parentMissionId !== parentMissionId)
			throw new Error(`GOVERNANCE_PARENT_CONFLICT:${missionId}`);
	}
	/** Atomic admission for a single provider inference request. */
	async admitInference(input: {
		missionId: string;
		eventId: string;
		provider: string;
		model: string;
		atMs: number;
	}): Promise<{ allowed: boolean; reason?: string }> {
		await this.ensureMission(input.missionId);
		const local = isLocalProvider(this.policy, input.provider);
		if (!local && !this.policy.cloudAllowed) return { allowed: false, reason: "CLOUD_PROHIBITED" };
		const result = await this.store.mutate<{ allowed: boolean; reason?: string }>(input.missionId, (ledger) => {
			const limit = hardLimitFor(this.policy, "inferenceRequests");
			if (limit !== undefined && ledger.usage.inferenceRequests + 1 > limit)
				return { kind: "noop", value: { allowed: false, reason: "INFERENCE_REQUESTS_HARD_LIMIT" } };
			const spendLimit = hardLimitFor(this.policy, "cloudSpendUsd");
			if (
				!local &&
				spendLimit !== undefined &&
				(ledger.cost.unknownPaidEvents > 0 || ledger.cost.knownUsd >= spendLimit)
			)
				return {
					kind: "noop",
					value: {
						allowed: false,
						reason: ledger.cost.unknownPaidEvents > 0 ? "UNKNOWN_CLOUD_COST" : "CLOUD_COST_HARD_LIMIT",
					},
				};
			const accounted = consumeGovernanceInternal(ledger, {
				eventId: input.eventId,
				scope: "session",
				resource: "inferenceRequests",
				amount: 1,
				atMs: input.atMs,
				provider: input.provider,
				model: input.model,
				costStatus: local ? "NONE" : undefined,
			});
			return { kind: "write", ledger: accounted.ledger, value: { allowed: true } };
		});
		if (result.status !== "ok")
			throw new Error(`GOVERNANCE_LEDGER_${result.status.toUpperCase()}:${input.missionId}`);
		return result.value;
	}
	/** Record authoritative provider result telemetry after the provider returns. */
	async recordInferenceResult(input: {
		missionId: string;
		eventId: string;
		provider: string;
		model: string;
		inputTokens?: number;
		outputTokens?: number;
		costUsd?: number;
		costStatus?: "KNOWN" | "UNKNOWN";
		atMs: number;
	}): Promise<void> {
		await this.ensureMission(input.missionId);
		const local = isLocalProvider(this.policy, input.provider);
		await this.store.mutate(input.missionId, (ledger) => {
			if (ledger.events.some((event) => event.eventId === input.eventId)) return { kind: "noop", value: undefined };
			const next = JSON.parse(JSON.stringify(ledger)) as GovernanceLedger;
			if (input.inputTokens !== undefined && (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0))
				throw new Error("INVALID_INPUT_TOKEN_USAGE");
			if (input.outputTokens !== undefined && (!Number.isSafeInteger(input.outputTokens) || input.outputTokens < 0))
				throw new Error("INVALID_OUTPUT_TOKEN_USAGE");
			if (input.inputTokens !== undefined) next.usage.contextTokens += input.inputTokens;
			if (input.outputTokens !== undefined) next.usage.generatedTokens += input.outputTokens;
			if (
				input.inputTokens !== undefined &&
				hardLimitFor(this.policy, "maxContextTokens") !== undefined &&
				next.usage.contextTokens > hardLimitFor(this.policy, "maxContextTokens")!
			)
				throw new Error("INPUT_TOKEN_HARD_LIMIT");
			if (
				input.outputTokens !== undefined &&
				hardLimitFor(this.policy, "maxGeneratedTokens") !== undefined &&
				next.usage.generatedTokens > hardLimitFor(this.policy, "maxGeneratedTokens")!
			)
				throw new Error("GENERATED_TOKEN_HARD_LIMIT");
			if (!local && input.costStatus === undefined && input.costUsd === undefined)
				throw new Error("UNKNOWN_CLOUD_COST");
			if (local && input.costUsd !== undefined) throw new Error("LOCAL_COST_MUST_BE_NONE");
			if (!local && input.costUsd !== undefined && Number.isFinite(input.costUsd) && input.costUsd >= 0) {
				const spendLimit = hardLimitFor(this.policy, "cloudSpendUsd");
				if (spendLimit !== undefined && next.cost.knownUsd + input.costUsd > spendLimit)
					throw new Error("CLOUD_COST_HARD_LIMIT");
				next.cost.knownUsd += input.costUsd;
				next.usage.cloudSpendUsd += input.costUsd;
				next.cost.status = "KNOWN";
			} else if (!local && input.costStatus === "UNKNOWN") {
				next.cost.unknownPaidEvents += 1;
				next.cost.status = "UNKNOWN";
			} else if (local) {
				next.cost.status = next.cost.unknownPaidEvents > 0 ? "UNKNOWN" : "NONE";
			}
			next.events.push({
				eventId: input.eventId,
				scope: "session",
				kind: "consume",
				resource: "generatedTokens",
				amount: input.outputTokens ?? 0,
				provider: input.provider,
				model: input.model,
				costStatus: input.costStatus,
				costUsd: input.costUsd,
				atMs: input.atMs,
			});
			next.revision += 1;
			return { kind: "write", ledger: next, value: undefined };
		});
	}
	async recordRetry(
		missionId: string,
		eventId: string,
		retryClass: GovernanceRetryClass,
		atMs: number,
		correlation?: GovernanceCorrelation,
	): Promise<void> {
		await this.ensureMission(missionId);
		const result = await this.store.mutate(missionId, (ledger) => ({
			kind: "write" as const,
			ledger: recordGovernanceRetry(ledger, eventId, retryClass, atMs, correlation),
			value: undefined,
		}));
		if (result.status !== "ok") throw new Error(`GOVERNANCE_LEDGER_${result.status.toUpperCase()}:${missionId}`);
	}
	async recordDecision(missionId: string, eventId: string, decision: GovernanceDecision): Promise<void> {
		await this.ensureMission(missionId);
		const result = await this.store.mutate(missionId, (ledger) => ({
			kind: "write" as const,
			ledger: recordGovernanceDecision(ledger, eventId, decision),
			value: undefined,
		}));
		if (result.status !== "ok") throw new Error(`GOVERNANCE_LEDGER_${result.status.toUpperCase()}:${missionId}`);
	}
	async recordEscalation(missionId: string, eventId: string, record: GovernanceEscalationRecord): Promise<void> {
		await this.ensureMission(missionId);
		const result = await this.store.mutate(missionId, (ledger) => ({
			kind: "write" as const,
			ledger: recordGovernanceEscalation(ledger, eventId, record),
			value: undefined,
		}));
		if (result.status !== "ok") throw new Error(`GOVERNANCE_LEDGER_${result.status.toUpperCase()}:${missionId}`);
	}
	async recordModelTransition(input: GovernanceModelTransition): Promise<void> {
		await this.recordEscalation(input.missionId, input.eventId, {
			escalationId: input.eventId,
			from: input.from,
			to: input.to,
			reason: input.reason,
			missionId: input.missionId,
			orchestrationId: input.orchestrationId,
			nodeId: input.nodeId,
			logicalAgentId: input.logicalAgentId,
			assignmentId: input.assignmentId,
			executionId: input.executionId,
			sessionId: input.sessionId,
			atMs: input.atMs,
		});
	}
	/** Record a policy-governed non-inference unit (child, retry, replan, etc.). */
	async consume(missionId: string, request: GovernanceConsumeRequest): Promise<GovernanceConsumeResult> {
		await this.ensureMission(missionId);
		if (request.provider && !isLocalProvider(this.policy, request.provider) && !this.policy.cloudAllowed)
			return { allowed: false, reason: "CLOUD_PROHIBITED", ledger: createGovernanceLedger(missionId) };
		if (COUNT_RESOURCES.has(request.resource) && (!Number.isSafeInteger(request.amount) || request.amount <= 0))
			return {
				allowed: false,
				reason: "COUNT_AMOUNT_MUST_BE_POSITIVE_INTEGER",
				ledger: createGovernanceLedger(missionId),
			};
		if (request.resource === "cloudSpendUsd" && (!Number.isFinite(request.amount) || request.amount <= 0))
			return { allowed: false, reason: "COST_AMOUNT_MUST_BE_POSITIVE", ledger: createGovernanceLedger(missionId) };
		if (request.resource === "cloudSpendUsd" && request.costUsd !== undefined)
			return {
				allowed: false,
				reason: "COST_MUST_USE_ONE_AUTHORITATIVE_AMOUNT",
				ledger: createGovernanceLedger(missionId),
			};
		if (request.costUsd !== undefined && (!Number.isFinite(request.costUsd) || request.costUsd < 0))
			return { allowed: false, reason: "INVALID_COST", ledger: createGovernanceLedger(missionId) };
		let outcome: GovernanceConsumeResult = {
			allowed: false,
			reason: "UNSET",
			ledger: createGovernanceLedger(missionId),
		};
		const result = await this.store.mutate(missionId, (ledger) => {
			const limit = hardLimitFor(this.policy, request.resource);
			if (limit !== undefined && ledger.usage[request.resource] + request.amount > limit) {
				outcome = { allowed: false, reason: `${String(request.resource).toUpperCase()}_HARD_LIMIT`, ledger };
				return { kind: "noop", value: outcome };
			}
			if (
				request.costStatus === "UNKNOWN" &&
				request.provider &&
				!isLocalProvider(this.policy, request.provider) &&
				hardLimitFor(this.policy, "cloudSpendUsd") !== undefined
			) {
				outcome = { allowed: false, reason: "UNKNOWN_CLOUD_COST", ledger };
				return { kind: "noop", value: outcome };
			}
			outcome = consumeGovernanceInternal(ledger, request);
			return { kind: "write", ledger: outcome.ledger, value: outcome };
		});
		if (result.status !== "ok") throw new Error(`GOVERNANCE_LEDGER_${result.status.toUpperCase()}:${missionId}`);
		return outcome;
	}
	async recordOrchestrationChild(input: GovernanceOrchestrationChildRequest): Promise<GovernanceConsumeResult> {
		await this.ensureMission(input.missionId);
		const requests: GovernanceConsumeRequest[] = [
			{
				eventId: input.eventId,
				scope: "orchestration",
				resource: "children",
				amount: 1,
				atMs: input.atMs,
				childId: input.childId,
				correlation: input.correlation,
			},
			{
				eventId: `${input.eventId}:fanout`,
				scope: "orchestration",
				resource: "fanOut",
				amount: 1,
				atMs: input.atMs,
				childId: input.childId,
				correlation: input.correlation,
			},
			{
				eventId: `${input.eventId}:depth`,
				scope: "orchestration",
				resource: "depth",
				amount: input.orchestrationDepth,
				atMs: input.atMs,
				childId: input.childId,
				correlation: input.correlation,
			},
		];
		let outcome: GovernanceConsumeResult = {
			allowed: false,
			reason: "UNSET",
			ledger: createGovernanceLedger(input.missionId),
		};
		const result = await this.store.mutate(input.missionId, (ledger) => {
			if (requests.every((request) => ledger.events.some((event) => event.eventId === request.eventId)))
				return { kind: "noop" as const, value: { allowed: true, ledger } };
			let next = ledger;
			for (const request of requests) {
				const limit = hardLimitFor(this.policy, request.resource);
				if (limit !== undefined && next.usage[request.resource] + request.amount > limit) {
					outcome = { allowed: false, reason: `${String(request.resource).toUpperCase()}_HARD_LIMIT`, ledger };
					return { kind: "noop" as const, value: outcome };
				}
				const accounted = consumeGovernanceInternal(next, request);
				if (!accounted.allowed) {
					outcome = { allowed: false, reason: accounted.reason, ledger };
					return { kind: "noop" as const, value: outcome };
				}
				next = accounted.ledger;
			}
			outcome = { allowed: true, ledger: next };
			return { kind: "write" as const, ledger: next, value: outcome };
		});
		if (result.status !== "ok")
			throw new Error(`GOVERNANCE_LEDGER_${result.status.toUpperCase()}:${input.missionId}`);
		return result.value;
	}
	async snapshot(missionId: string): Promise<GovernanceStatusSnapshot | undefined> {
		const loaded = await this.store.load(missionId);
		if (loaded.status !== "ok") return undefined;
		const budget = effectiveBudget(this.policy);
		const remaining: Partial<GovernanceLedger["usage"]> = {};
		for (const [resource, field] of Object.entries(RESOURCE_TO_LIMIT) as Array<
			[keyof GovernanceLedger["usage"], keyof GovernanceBudget]
		>) {
			const limit = budget[field];
			if (limit !== undefined) remaining[resource] = Math.max(0, limit - loaded.ledger.usage[resource]);
		}
		const status =
			loaded.ledger.cost.status === "UNKNOWN"
				? "UNKNOWN"
				: Object.values(remaining).some((value) => value === 0)
					? "LIMIT_REACHED"
					: "NORMAL";
		return {
			missionId,
			parentMissionId: loaded.ledger.parentMissionId,
			revision: loaded.ledger.revision,
			status,
			usage: loaded.ledger.usage,
			remaining,
			retries: loaded.ledger.retries,
			cost: loaded.ledger.cost,
			escalations: loaded.ledger.escalationHistory.length,
			lastDecision: loaded.ledger.lastDecision,
		};
	}
}
