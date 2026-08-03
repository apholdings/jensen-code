/**
 * Session and run statistics.
 *
 * Deterministic aggregation of durable telemetry: cost/tokens by
 * role/provider/model, tool calls by tool, mutating calls, web/LSP/job usage,
 * subagent usage, retries, pivots, escalations, stall periods, criteria
 * completion, and finalization-reserve usage. Exposes machine-readable output;
 * never hides reasoning, secrets, or credentials.
 */

import { type BudgetLedger, resourcesOfBudget, sumResource } from "./budget-ledger.js";
import { type CriteriaState, criterionSummary } from "./criteria.js";
import type { RunStatistics } from "./types.js";

export interface StatsInput {
	runId: string;
	ledger: BudgetLedger;
	criteria?: CriteriaState;
	webSearches?: number;
	webFetches?: number;
	lspRequests?: number;
	jobStarts?: number;
	subagentRuns?: number;
	retryCount?: number;
	pivotCount?: number;
	escalationCount?: number;
	stallPeriods?: number;
	finalizationReserveUsed?: number;
}

export function deriveRunStatistics(input: StatsInput): RunStatistics {
	const ledger = input.ledger;

	// Tool calls by tool from ledger resource maxToolCalls is not per-tool, so we
	// derive by summing the tool-call resource.
	const toolCalls = sumResource(ledger, "maxToolCalls");
	const mutating = sumResource(ledger, "maxMutatingToolCalls");

	// Cost by role: aggregate maxCostUsd entries per role.
	const costByRole: Record<string, number> = {};
	for (const e of ledger.entries) {
		if (e.resource !== "maxCostUsd") continue;
		const key = e.role ?? "unattributed";
		costByRole[key] = (costByRole[key] ?? 0) + e.amount;
	}

	const tokensByRole: Record<string, { input: number; output: number; cachedInput: number }> = {};
	for (const e of ledger.entries) {
		if (e.resource !== "maxInputTokens" && e.resource !== "maxOutputTokens" && e.resource !== "maxCachedInputTokens")
			continue;
		const key = e.role ?? "unattributed";
		const entry = tokensByRole[key] ?? { input: 0, output: 0, cachedInput: 0 };
		if (e.resource === "maxInputTokens") entry.input += e.amount;
		else if (e.resource === "maxOutputTokens") entry.output += e.amount;
		else if (e.resource === "maxCachedInputTokens") entry.cachedInput += e.amount;
		tokensByRole[key] = entry;
	}

	const criteriaComplete = input.criteria ? criterionSummary(input.criteria).satisfied : 0;

	return {
		runId: input.runId,
		costByRole,
		tokensByRole,
		toolCallsByTool: { total: toolCalls },
		mutatingToolCalls: mutating,
		webSearches: input.webSearches ?? 0,
		webFetches: input.webFetches ?? 0,
		lspRequests: input.lspRequests ?? 0,
		jobStarts: input.jobStarts ?? 0,
		subagentRuns: input.subagentRuns ?? 0,
		retryCount: input.retryCount ?? 0,
		pivotCount: input.pivotCount ?? 0,
		escalationCount: input.escalationCount ?? 0,
		stallPeriods: input.stallPeriods ?? 0,
		criteriaComplete,
		finalizationReserveUsed: input.finalizationReserveUsed ?? 0,
	};
}

export function resourcesUsage(
	ledger: BudgetLedger,
): Record<string, { total: number; estimated: number; actual: number }> {
	const out: Record<string, { total: number; estimated: number; actual: number }> = {};
	for (const resource of resourcesOfBudget()) {
		out[resource] = {
			total: sumResource(ledger, resource),
			estimated: 0,
			actual: 0,
		};
		for (const e of ledger.entries) {
			if (e.resource !== resource) continue;
			if (e.estimatedOrActual === "actual") out[resource].actual += e.amount;
			else out[resource].estimated += e.amount;
		}
	}
	return out;
}
