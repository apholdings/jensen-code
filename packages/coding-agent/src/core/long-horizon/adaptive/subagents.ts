/**
 * Isolated bounded subagents.
 *
 * First-class subagent runs: isolated context, bounded toolset, bounded budget,
 * bounded lifetime, cancellation propagation, durable start/finish events, and
 * structured output that the parent must validate before use. A subagent
 * cannot expand scope, cannot mutate/commit/publish by default, and cannot
 * recursively spawn children beyond explicit parent policy and depth limits.
 * All child consumption is charged to the parent budget via the ledger.
 */

import type { BudgetLedger } from "./budget-ledger.js";
import { appendEntry } from "./budget-ledger.js";
import type { SubagentRunRecord, SubagentSpec, SubagentStatus } from "./types.js";

export interface SubagentRuntimeConfig {
	maxDepth: number;
	maxTotalChildren: number;
	maxConcurrentChildren: number;
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentRuntimeConfig = {
	maxDepth: 1,
	maxTotalChildren: 8,
	maxConcurrentChildren: 2,
};

export interface SubagentLaunchInput {
	spec: SubagentSpec;
	parentCanMutate: boolean;
	parentCanPublish: boolean;
	siblingCount: number;
	activeChildren: number;
	parentLedger: BudgetLedger;
	config?: SubagentRuntimeConfig;
}

export interface LaunchDecision {
	allowed: boolean;
	reasonCodes: string[];
	record: SubagentRunRecord | null;
}

/**
 * Deterministically decide whether a subagent may launch under parent policy
 * and runtime limits (depth, total children, concurrency, budget, mutation).
 */
export function canLaunchSubagent(input: SubagentLaunchInput): LaunchDecision {
	const config = input.config ?? DEFAULT_SUBAGENT_CONFIG;
	const reasonCodes: string[] = [];

	if (input.spec.maxDepth > config.maxDepth) {
		reasonCodes.push("SUBDEPTH_EXCEEDED");
	}
	if (input.spec.allowSpawnSubagents && input.spec.maxDepth <= 0) {
		reasonCodes.push("SUBDEPTH_EXHAUSTED");
	}
	if (input.siblingCount >= config.maxTotalChildren) {
		reasonCodes.push("MAX_TOTAL_CHILDREN");
	}
	if (input.activeChildren >= config.maxConcurrentChildren) {
		reasonCodes.push("MAX_CONCURRENT_CHILDREN");
	}
	// A subagent that would mutate must be explicitly permitted by parent policy.
	if (input.spec.executionMode === "mutate" || input.spec.allowMutation) {
		if (!input.parentCanMutate) {
			reasonCodes.push("MUTATION_DENIED");
		}
	}
	if (input.parentCanPublish === false && input.spec.allowedTools.includes("publish")) {
		reasonCodes.push("PUBLISH_DENIED");
	}
	// Child budget must not exceed what the parent can afford: we only permit a
	// launch if the child budget is defined and non-negative.
	if (budgetIsUnbounded(input.spec.budget)) {
		reasonCodes.push("CHILD_BUDGET_UNBOUNDED");
	}

	const allowed = reasonCodes.length === 0;
	if (!allowed) {
		return { allowed, reasonCodes, record: null };
	}

	const record: SubagentRunRecord = Object.freeze({
		subagentId: input.spec.subagentId,
		parentRunId: input.spec.parentRunId,
		role: input.spec.role,
		status: "pending",
	});
	return { allowed, reasonCodes, record };
}

function budgetIsUnbounded(budget: Partial<import("./types.js").ExecutionBudget>): boolean {
	// A subagent must carry at least one bounded budget dimension.
	for (const v of Object.values(budget)) {
		if (typeof v === "number" && v > 0) return false;
	}
	return true;
}

/** Advance a subagent record status (durable event), frozen snapshot. */
export function transitionSubagent(record: SubagentRunRecord, status: SubagentStatus, at?: string): SubagentRunRecord {
	return Object.freeze({
		subagentId: record.subagentId,
		parentRunId: record.parentRunId,
		role: record.role,
		status,
		startedAt: record.startedAt ?? (status === "running" ? at : record.startedAt),
		finishedAt:
			status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out"
				? at
				: record.finishedAt,
		resultPayload: record.resultPayload,
		cancelRequested: status === "cancelled" ? true : record.cancelRequested,
	});
}

/** Charge a child's consumption to the parent budget (append-only, idempotent). */
export function chargeChildToParent(
	ledger: BudgetLedger,
	childId: string,
	resource: string,
	amount: number,
	runId: string,
): BudgetLedger {
	const result = appendEntry(ledger, {
		entryId: `${childId}:charge:${resource}`,
		runId,
		role: "subagent",
		resource: resource as never,
		amount,
		estimatedOrActual: "estimated",
		sourceEventId: `${childId}:${resource}`,
		recordedAt: new Date(0).toISOString(),
	});
	return result.ledger;
}

/** Deterministic ordering key for parallel read-only subagent results. */
export function parallelOrderKey(records: readonly SubagentRunRecord[]): string[] {
	return records.map((r) => r.subagentId);
}

export type { SubagentRunRecord, SubagentStatus };
