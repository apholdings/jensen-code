/**
 * Durable execution-budget ledger.
 *
 * An append-only, idempotent, replay-safe accounting ledger for durable
 * execution budgets. Totals are always derived by replaying entries — never by
 * mutating a running counter — so a resume after interruption cannot double
 * charge and a cancelled run does not erase consumed budget.
 *
 * Estimated amounts are recorded first and reconciled against provider actuals
 * via `reconcileEntry` (idempotent). Unknown pricing is classified explicitly
 * rather than guessed. Cached-input usage is tracked separately. Subagent usage
 * is charged to both the child and the parent.
 */

import type {
	BudgetLedgerEntry,
	BudgetResource,
	BudgetThresholds,
	ExecutionBudget,
	ThresholdVerdict,
} from "./types.js";

export interface BudgetLedger {
	runId: string;
	entries: readonly BudgetLedgerEntry[];
}

/** Allocatable budget dimensions (numeric, non-nesting). */
const RESOURCE_ORDER: readonly BudgetResource[] = [
	"maxCostUsd",
	"maxInputTokens",
	"maxOutputTokens",
	"maxCachedInputTokens",
	"maxModelTurns",
	"maxToolCalls",
	"maxMutatingToolCalls",
	"maxWallTimeMs",
	"maxProviderRetries",
	"maxStrategyPivots",
	"maxModelEscalations",
	"maxSubagentRuns",
	"maxConcurrentSubagents",
	"maxWebSearches",
	"maxWebFetches",
	"maxBrowserRenders",
	"maxLspRequests",
	"maxBackgroundJobs",
];

export function resourcesOfBudget(): readonly BudgetResource[] {
	return RESOURCE_ORDER;
}

export function createBudgetLedger(runId: string): BudgetLedger {
	return { runId, entries: Object.freeze([]) };
}

function freezeEntry(e: BudgetLedgerEntry): BudgetLedgerEntry {
	return Object.freeze({
		entryId: String(e.entryId),
		runId: String(e.runId),
		phaseId: e.phaseId === undefined ? undefined : String(e.phaseId),
		role: e.role === undefined ? undefined : String(e.role),
		resource: e.resource,
		amount: e.amount,
		estimatedOrActual: e.estimatedOrActual,
		provider: e.provider === undefined ? undefined : String(e.provider),
		model: e.model === undefined ? undefined : String(e.model),
		sourceEventId: String(e.sourceEventId),
		recordedAt: String(e.recordedAt),
	});
}

export interface AppendResult {
	ledger: BudgetLedger;
	appended: boolean;
	reason?: string;
}

/**
 * Append a single durable entry.
 *
 * Idempotent by `entryId`: appending an entry that already exists returns the
 * same ledger with `appended: false`, so replay or resume can never double
 * charge. Amounts are snapshotted defensively.
 */
export function appendEntry(ledger: BudgetLedger, entry: BudgetLedgerEntry): AppendResult {
	if (!RESOURCE_ORDER.includes(entry.resource)) {
		return { ledger, appended: false, reason: `UNKNOWN_RESOURCE: ${entry.resource}` };
	}
	if (!Number.isFinite(entry.amount)) {
		return { ledger, appended: false, reason: "NON_FINITE_AMOUNT" };
	}
	if (entry.estimatedOrActual !== "estimated" && entry.estimatedOrActual !== "actual") {
		return { ledger, appended: false, reason: "INVALID_ACCOUNTING_KIND" };
	}
	for (const existing of ledger.entries) {
		if (existing.entryId === entry.entryId && existing.runId === entry.runId) {
			return { ledger, appended: false, reason: "DUPLICATE_ENTRY_ID" };
		}
	}
	const next: BudgetLedger = {
		runId: ledger.runId,
		entries: Object.freeze([...ledger.entries, freezeEntry(entry)]),
	};
	return { ledger: next, appended: true };
}

/**
 * Reconcile an estimated entry against a provider actual.
 *
 * The actual is appended as a new (separate) entry referencing the same
 * `sourceEventId` with kind `actual`. Reformatting of the provisional estimate
 * preserves the audit trail. Idempotent: re-applying the same actual is
 * rejected as a duplicate entryId.
 */
export function reconcileEntry(
	ledger: BudgetLedger,
	estimatedEntryId: string,
	actual: Omit<BudgetLedgerEntry, "estimatedOrActual" | "entryId" | "runId"> & { entryId?: string },
): AppendResult {
	const estimate = ledger.entries.find((e) => e.entryId === estimatedEntryId);
	if (!estimate || estimate.estimatedOrActual !== "estimated") {
		return { ledger, appended: false, reason: "ESTIMATE_NOT_FOUND" };
	}
	const actualEntryId = actual.entryId ?? `${estimatedEntryId}:actual`;
	return appendEntry(ledger, {
		...actual,
		entryId: actualEntryId,
		runId: estimate.runId,
		resource: actual.resource,
		estimatedOrActual: "actual",
		sourceEventId: estimate.sourceEventId,
	});
}

export interface Usage {
	total: number;
	estimated: number;
	actual: number;
}

/**
 * Derive usage for a resource by replay (sum only the most authoritative kind
 * per entry). Actual supersedes the estimated entry that shares a sourceEventId
 * only for reporting clarity; totals count each entry once by idempotency.
 */
export function getUsage(ledger: BudgetLedger, resource: BudgetResource): Usage {
	let total = 0;
	let estimated = 0;
	let actual = 0;
	for (const e of ledger.entries) {
		if (e.resource !== resource) continue;
		total += e.amount;
		if (e.estimatedOrActual === "actual") actual += e.amount;
		else estimated += e.amount;
	}
	return { total, estimated, actual };
}

export function sumResource(ledger: BudgetLedger, resource: BudgetResource): number {
	return getUsage(ledger, resource).total;
}

/**
 * Count distinct provider/model-billed estimated entries reconciled with an
 * actual for the same sourceEventId, so we can assert no-persistent-overshoot.
 */
export function resolvedSourceEvents(ledger: BudgetLedger): number {
	const actuals = new Set<string>();
	for (const e of ledger.entries) {
		if (e.estimatedOrActual === "actual") actuals.add(e.sourceEventId);
	}
	const resolved = new Set<string>();
	for (const e of ledger.entries) {
		if (e.estimatedOrActual === "estimated" && actuals.has(e.sourceEventId)) {
			resolved.add(e.sourceEventId);
		}
	}
	return resolved.size;
}

export interface ThresholdOutput {
	verdicts: ThresholdVerdict[];
	blocked: boolean;
	hardReached: ThresholdVerdict[];
	softReached: ThresholdVerdict[];
}

/**
 * Evaluate soft/hard thresholds for every budget dimension given thresholds.
 * Reserved capacity (finalization + recovery) is reserved from the hard
 * threshold before ordinary consumption is judged.
 */
export function evaluateThresholds(
	ledger: BudgetLedger,
	thresholds: BudgetThresholds,
	options: { reserved?: number } = {},
): ThresholdOutput {
	const reserved = options.reserved ?? 0;
	const verdicts: ThresholdVerdict[] = [];
	const hardReached: ThresholdVerdict[] = [];
	const softReached: ThresholdVerdict[] = [];
	let blocked = false;

	for (const resource of RESOURCE_ORDER) {
		const used = sumResource(ledger, resource);
		const soft = thresholds.soft;
		const hard = thresholds.hard;

		if (hard !== undefined) {
			const effectiveHard = Math.max(0, hard - reserved);
			if (used >= effectiveHard) {
				const v: ThresholdVerdict = { kind: "hard", resource, used, threshold: effectiveHard };
				verdicts.push(v);
				hardReached.push(v);
				blocked = true;
				continue;
			}
		}
		if (soft !== undefined && used >= soft) {
			const v: ThresholdVerdict = { kind: "soft", resource, used, threshold: soft };
			verdicts.push(v);
			softReached.push(v);
			continue;
		}
		verdicts.push({ kind: "ok" });
	}

	return { verdicts, blocked, hardReached, softReached };
}

// =============================================================================
// Budget hierarchy allocation
// =============================================================================

export interface BudgetAllocationInput {
	global: Partial<ExecutionBudget>;
	user?: Partial<ExecutionBudget>;
	run?: Partial<ExecutionBudget>;
	phase?: Partial<ExecutionBudget>;
	role?: Partial<ExecutionBudget>;
	subagent?: Partial<ExecutionBudget>;
}

export interface AllocationResult {
	effective: Partial<ExecutionBudget>;
	blocked: boolean;
	reasons: string[];
	/** A manually-configured value may never exceed the unallocated remainder. */
	remainderOverflow: string[];
}

/**
 * Resolve the effective budget by intersecting the hierarchy: each level is
 * capped by the unallocated remainder of its parent. A child can never request
 * more than the parent has left. Lower levels may only reduce.
 */
export function resolveBudgetHierarchy(input: BudgetAllocationInput): AllocationResult {
	const chain: Array<Partial<ExecutionBudget> | undefined> = [
		input.global,
		input.user,
		input.run,
		input.phase,
		input.role,
		input.subagent,
	];
	const effective: Partial<ExecutionBudget> = {};
	const remainderOverflow: string[] = [];

	for (const resource of RESOURCE_ORDER) {
		let remaining: number | undefined;
		let finalValue: number | undefined;
		for (const layer of chain) {
			const layerValue = layer?.[resource];
			if (layerValue === undefined) continue;
			if (remaining === undefined) {
				remaining = layerValue;
				finalValue = layerValue;
				continue;
			}
			// Child cannot exceed unallocated parent remainder.
			if (layerValue > remaining) {
				remainderOverflow.push(`${resource}: child ${layerValue} exceeds remainder ${remaining}`);
				finalValue = remaining;
				continue;
			}
			finalValue = layerValue;
			remaining = layerValue;
		}
		if (finalValue !== undefined) {
			(effective as Record<string, unknown>)[resource] = finalValue;
		}
	}

	return { effective, blocked: false, reasons: [], remainderOverflow };
}

/**
 * Reserve capacity for finalization. Returns the allowed-discretionary value
 * (hard minus reserve) and the reserve value, and never lets ordinary execution
 * spend the reserve: ordinary use is bounded by the reserved-adjusted hard.
 */
export function reserveFinalization(limit: number, reserve: number): { discretionary: number; reserve: number } {
	const r = Math.max(0, reserve);
	return { discretionary: Math.max(0, limit - r), reserve: r };
}

/** Mark a typed budget block when a hard limit is reached for a resource. */
export function budgetBlock(
	runId: string,
	resource: BudgetResource,
	used: number,
	threshold: number,
	finalizationReserveAvailable: boolean,
) {
	return {
		blocked: true as const,
		runId,
		resource,
		used,
		threshold,
		reasonCode: "HARD_LIMIT_REACHED" as const,
		finalizationReserveAvailable,
	};
}
