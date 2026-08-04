/**
 * Budget-class selection.
 *
 * Budget classes define bounded dimensions. Operator ceilings remain
 * authoritative. Unused budget is not interpreted as failure. A finalization
 * reserve is mandatory. Escalation requires available reserve. Candidate
 * scores are normalized for the budget class so comparison avoids rewarding
 * unlimited budgets.
 */

import type { BudgetClass } from "./types.js";

export interface BudgetBounds {
	maxModelCalls: number;
	maxToolCalls: number;
	maxSubagents: number;
	maxRetrievalQueries: number;
	maxContextTokens: number;
	maxOutputTokens: number;
	maxWallTimeMs: number;
	maxCostUsd: number;
	finalizationReserveRatio: number;
}

export const BUDGET_CLASSES: Record<BudgetClass, BudgetBounds> = {
	tiny: {
		maxModelCalls: 2,
		maxToolCalls: 8,
		maxSubagents: 0,
		maxRetrievalQueries: 5,
		maxContextTokens: 20_000,
		maxOutputTokens: 4_000,
		maxWallTimeMs: 30_000,
		maxCostUsd: 0.1,
		finalizationReserveRatio: 0.2,
	},
	small: {
		maxModelCalls: 5,
		maxToolCalls: 24,
		maxSubagents: 1,
		maxRetrievalQueries: 12,
		maxContextTokens: 40_000,
		maxOutputTokens: 8_000,
		maxWallTimeMs: 120_000,
		maxCostUsd: 0.5,
		finalizationReserveRatio: 0.2,
	},
	standard: {
		maxModelCalls: 15,
		maxToolCalls: 100,
		maxSubagents: 3,
		maxRetrievalQueries: 30,
		maxContextTokens: 128_000,
		maxOutputTokens: 16_000,
		maxWallTimeMs: 300_000,
		maxCostUsd: 2,
		finalizationReserveRatio: 0.2,
	},
	large: {
		maxModelCalls: 40,
		maxToolCalls: 300,
		maxSubagents: 6,
		maxRetrievalQueries: 80,
		maxContextTokens: 256_000,
		maxOutputTokens: 32_000,
		maxWallTimeMs: 900_000,
		maxCostUsd: 8,
		finalizationReserveRatio: 0.2,
	},
	high_assurance: {
		maxModelCalls: 60,
		maxToolCalls: 400,
		maxSubagents: 8,
		maxRetrievalQueries: 120,
		maxContextTokens: 256_000,
		maxOutputTokens: 32_000,
		maxWallTimeMs: 1_800_000,
		maxCostUsd: 15,
		finalizationReserveRatio: 0.3,
	},
	release: {
		maxModelCalls: 100,
		maxToolCalls: 600,
		maxSubagents: 12,
		maxRetrievalQueries: 200,
		maxContextTokens: 512_000,
		maxOutputTokens: 64_000,
		maxWallTimeMs: 3_600_000,
		maxCostUsd: 30,
		finalizationReserveRatio: 0.3,
	},
};

export interface BudgetSelectionInput {
	budgetClass: string;
	operatorCeiling?: Partial<BudgetBounds>;
}

export interface BudgetSelectionResult {
	budgetClass: string;
	bounds: BudgetBounds;
	finalizationReserve: Record<string, number>;
	operatorCeilingApplied: boolean;
}

/**
 * Select budget bounds for a class, intersecting with operator ceilings.
 * Operator ceilings are authoritative and always win.
 */
export function selectBudget(input: BudgetSelectionInput): BudgetSelectionResult {
	const base = BUDGET_CLASSES[input.budgetClass as BudgetClass] ?? BUDGET_CLASSES.standard;
	const bounds: BudgetBounds = { ...base };
	const operator = input.operatorCeiling ?? {};
	const operatorCeilingApplied = Object.keys(operator).length > 0;

	for (const key of Object.keys(bounds) as (keyof BudgetBounds)[]) {
		if (key === "finalizationReserveRatio") continue;
		if (operator[key] !== undefined && (operator[key] as number) < bounds[key]) bounds[key] = operator[key] as number;
	}

	const reserve: Record<string, number> = {};
	(reserve as Record<string, number>).maxCostUsd = bounds.maxCostUsd * bounds.finalizationReserveRatio;
	(reserve as Record<string, number>).maxWallTimeMs = bounds.maxWallTimeMs * bounds.finalizationReserveRatio;
	(reserve as Record<string, number>).maxModelCalls = Math.round(
		bounds.maxModelCalls * bounds.finalizationReserveRatio,
	);

	return { budgetClass: input.budgetClass, bounds, finalizationReserve: reserve, operatorCeilingApplied };
}

/** Whether escalation is permitted given budget usage and the mandatory reserve. */
export function canEscalate(
	used: { costUsd?: number; wallTimeMs?: number; modelCalls?: number },
	bounds: BudgetBounds,
): boolean {
	const reserveCost = bounds.maxCostUsd * bounds.finalizationReserveRatio;
	const reserveTime = bounds.maxWallTimeMs * bounds.finalizationReserveRatio;
	const reserveCalls = Math.round(bounds.maxModelCalls * bounds.finalizationReserveRatio);
	if (used.costUsd !== undefined && bounds.maxCostUsd - used.costUsd < reserveCost) return false;
	if (used.wallTimeMs !== undefined && bounds.maxWallTimeMs - used.wallTimeMs < reserveTime) return false;
	if (used.modelCalls !== undefined && bounds.maxModelCalls - used.modelCalls < reserveCalls) return false;
	return true;
}
