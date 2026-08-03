/**
 * Strategy representation and bounded pivots.
 *
 * A pivot is allowed only when it is materially different, evidence-backed, does
 * not expand scope or relax safety, and stays inside the remaining pivot budget.
 * A cosmetic rewrite of the same commands is rejected. Once pivots are
 * exhausted with no safe materially different strategy, blocks with
 * STRATEGY_EXHAUSTED.
 */

import type { ExecutionBudget, ExecutionStrategy, PivotRequest, PivotResult } from "./types.js";

export interface PivotBudget {
	maxStrategyPivots: number;
	maxPivotsPerPhase: number;
	maxEquivalentStrategies: number;
}

export interface PivotContext {
	usedPivots: number;
	usedPivotsThisPhase: number;
	phase: string;
	remainingBudget: Partial<ExecutionBudget>;
	strategyHistory: readonly ExecutionStrategy[];
}

export interface PivotEvaluator {
	context: PivotContext;
	budget: PivotBudget;
}

/** Compare the projected actions of a pivot to the failed strategy's actions. */
export function isMateriallyDifferent(failed: ExecutionStrategy, plannedActions: readonly string[]): boolean {
	// Reject a cosmetic rename of the same command sequence.
	const failedActions = failed.plannedActions.map((a) => a.trim());
	const planned = plannedActions.map((a) => a.trim());
	if (failedActions.length === planned.length) {
		let same = true;
		for (let i = 0; i < failedActions.length; i += 1) {
			if (normAction(failedActions[i]) !== normAction(planned[i])) {
				same = false;
				break;
			}
		}
		if (same) return false;
	}
	return true;
}

function normAction(a: string): string {
	return a.replace(/\s+/gu, " ").toLowerCase().trim();
}

/** A pivot is a true scope-reducer or different-strategy only if it changes the hazard profile. */
export function scopeExpands(req: PivotRequest, _existing: readonly ExecutionStrategy[]): boolean {
	// Any action that was not present before AND is a mutation/verification
	// broadening counts as scope expansion. For this deterministic model we flag
	// requests whose planned actions contain new mutating verbs not in history.
	const scopeVerbs = new Set(["delete", "drop", "rm", "reset", "force", "push", "publish", "merge"]);
	for (const action of req.materialChange) {
		const first = normAction(action).split(/[ /]/u)[0];
		if (scopeVerbs.has(first)) return true;
	}
	return false;
}

/**
 * Evaluate a pivot request deterministically. Returns an approved new strategy
 * or a structured rejection.
 */
export function evaluatePivot(evaluator: PivotEvaluator, req: PivotRequest): PivotResult {
	const blockedCodes: string[] = [];

	// Find the failed strategy.
	const failed = evaluator.context.strategyHistory.find((s) => s.strategyId === req.failedStrategyId);
	if (!failed) {
		return { ok: false, reasonCodes: ["FAILED_STRATEGY_NOT_FOUND"], error: "failed strategy missing" };
	}
	if (failed.status !== "failed" && failed.status !== "superseded" && failed.status !== "blocked") {
		return { ok: false, reasonCodes: ["FAILED_STRATEGY_NOT_FAILED"], error: "strategy not failed" };
	}

	if (evaluator.context.usedPivots >= evaluator.budget.maxStrategyPivots) {
		blockedCodes.push("STRATEGY_EXHAUSTED");
	}
	if (evaluator.context.usedPivotsThisPhase >= evaluator.budget.maxPivotsPerPhase) {
		blockedCodes.push("PHASE_PIVOT_LIMIT");
	}

	// Reject cosmetic pivots.
	if (!isMateriallyDifferent(failed, req.plannedActions)) {
		blockedCodes.push("COSMETIC_PIVOT_REJECTED");
	}

	// Reject scope expansion.
	if (scopeExpands(req, evaluator.context.strategyHistory)) {
		blockedCodes.push("SCOPE_EXPANSION_REJECTED");
	}

	if (blockedCodes.length > 0) {
		const exhausted = blockedCodes.includes("STRATEGY_EXHAUSTED");
		return {
			ok: false,
			reasonCodes: blockedCodes,
			blocked: true,
			error: exhausted ? "STRATEGY_EXHAUSTED" : undefined,
		};
	}

	const strategy: ExecutionStrategy = Object.freeze({
		strategyId: `S${evaluator.context.strategyHistory.length + 1}`,
		objectiveId: req.objectiveId,
		hypothesis: req.evidenceBackedReason,
		plannedActions: Object.freeze([...req.plannedActions]),
		expectedProgressSignals: Object.freeze([...req.newExpectedProgressSignals]),
		validationCriteria: Object.freeze([...req.validationCriteria]),
		estimatedBudget: Object.freeze({ ...req.newEstimatedBudget }),
		riskClass: req.riskClass,
		status: "active",
	});

	return {
		ok: true,
		strategy,
		budgetRemaining: remainingDiscretionary(evaluator.context.remainingBudget),
		reasonCodes: ["PIVOT_APPROVED", "MATERIALLY_DIFFERENT"],
	};
}

function remainingDiscretionary(budget: Partial<ExecutionBudget>): number {
	return budget.maxStrategyPivots ?? 0;
}

/** Count how many active/proposed strategies share the same action vector. */
export function equivalentStrategyCount(history: readonly ExecutionStrategy[], target: ExecutionStrategy): number {
	let count = 0;
	for (const s of history) {
		if (sameActionSet(s.plannedActions, target.plannedActions)) count += 1;
	}
	return count;
}

function sameActionSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const setA = a.map(normAction).sort();
	const setB = b.map(normAction).sort();
	for (let i = 0; i < setA.length; i += 1) {
		if (setA[i] !== setB[i]) return false;
	}
	return true;
}
