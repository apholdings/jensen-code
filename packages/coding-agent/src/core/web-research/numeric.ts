import type { NumericFact, NumericVerification, NumericVerificationOutcome } from "./types.js";

/**
 * Bounded research calculation verifier.
 *
 * This is not a general theorem prover. It validates arithmetic and units used
 * in research synthesis:
 * - flat additions versus percentage additions
 * - additive versus multiplicative bonuses
 * - per-shot versus per-cycle versus per-second terminology
 * - percentages and deltas
 * - upgrade-level application
 * - caps and set thresholds
 *
 * When the verifier cannot resolve units or order of operations it marks the
 * calculation `unsupported` rather than silently choosing a formula.
 */

export interface FlatPercentAdd {
	kind: "flat" | "percent";
}

/**
 * Decide whether a "+N" additive delta should be treated as flat (+N) or
 * percent (× (1 + N/100)).
 */
export function classifyFlatVsPercent(
	delta: number,
	sourceSaysPercent: boolean,
	deltaOption?: FlatPercentAdd,
): {
	additive: boolean;
	multiplier: number;
} {
	if (deltaOption?.kind === "percent" || sourceSaysPercent) {
		// Only treat as percent when a source explicitly says percent.
		return { additive: false, multiplier: 1 + delta / 100 };
	}
	// Default: flat additive bonus.
	return { additive: true, multiplier: 0 };
}

/**
 * Validate a base + flat bonus computation.
 * Rejects interpreting a flat `+15` as `× 1.15`.
 */
export function validateFlatBonus(
	id: string,
	description: string,
	base: number,
	delta: number,
	sourceSaysPercent: boolean,
): NumericVerification {
	const classified = classifyFlatVsPercent(delta, sourceSaysPercent);
	if (!classified.additive && !sourceSaysPercent) {
		return {
			id,
			description,
			outcome: "unsupported",
			assumed: `${base} × (1 + ${delta}/100)`,
			violation: `Flat +${delta} was treated as a percent bonus without a source saying percent.`,
		};
	}
	if (classified.additive) {
		const computed = base + delta;
		return {
			id,
			description,
			outcome: "verified",
			computed,
			assumed: `${base} + ${delta} = ${computed}`,
		};
	}
	// Percent bonus explicitly sourced: base × (1 + delta/100).
	const computed = base * classified.multiplier;
	return {
		id,
		description,
		outcome: "verified",
		computed,
		assumed: `${base} × (1 + ${delta}/100) = ${computed}`,
	};
}

/**
 * Validate additive + multiplicative composition.
 * Default order: multiplier applies to base, then flat proc is added.
 */
export function validateTargetMultiplierPlusProc(
	id: string,
	description: string,
	base: number,
	multiplier: number,
	flatProc: number,
	multiplierAppliesToProc: boolean,
): NumericVerification {
	const computed = multiplierAppliesToProc ? (base + flatProc) * multiplier : base * multiplier + flatProc;
	return {
		id,
		description,
		outcome: "verified",
		computed,
		assumed: multiplierAppliesToProc
			? `(${base} + ${flatProc}) × ${multiplier} = ${computed}`
			: `${base} × ${multiplier} + ${flatProc} = ${computed}`,
	};
}

/**
 * Compute a per-cycle average and label it correctly.
 * Refuses to label it DPS unless attacks-per-second is sourced.
 */
export function validateCycleAverage(
	id: string,
	description: string,
	attacks: number[],
	attacksPerSecond?: number,
): NumericVerification {
	const average = attacks.reduce((sum, value) => sum + value, 0) / attacks.length;
	if (attacksPerSecond !== undefined) {
		return {
			id,
			description,
			outcome: "verified",
			computed: average * attacksPerSecond,
			assumed: `average = ${average.toFixed(2)}; DPS = ${average.toFixed(2)} × ${attacksPerSecond} attacks/s = ${(average * attacksPerSecond).toFixed(2)}`,
		};
	}
	return {
		id,
		description,
		outcome: "verified",
		computed: average,
		assumed: `average nominal damage per attack = ${average.toFixed(2)} (no attacks-per-second sourced; not labeled DPS)`,
	};
}

/** Percentage difference between two values. */
export function percentDifference(left: number, right: number): number {
	return ((right - left) / left) * 100;
}

/**
 * Apply an upgrade-level bonus. Default supported model: cumulative percent
 * bonus per level, capped.
 */
export function validateUpgradeLevels(
	id: string,
	description: string,
	base: number,
	levels: number,
	percentPerLevel: number,
	capPercent?: number,
): NumericVerification {
	const rawBonus = levels * percentPerLevel;
	const effectiveBonus = capPercent !== undefined ? Math.min(rawBonus, capPercent) : rawBonus;
	const computed = base * (1 + effectiveBonus / 100);
	return {
		id,
		description,
		outcome: "verified",
		computed,
		assumed: `base ${base} × (1 + ${effectiveBonus}%/100) = ${computed}${capPercent !== undefined ? ` (capped at ${capPercent}%)` : ""}`,
	};
}

export type { NumericFact, NumericVerificationOutcome };
