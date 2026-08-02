import { describe, expect, it } from "vitest";
import {
	percentDifference,
	validateCycleAverage,
	validateFlatBonus,
	validateTargetMultiplierPlusProc,
	validateUpgradeLevels,
} from "./numeric.js";

describe("numeric validation", () => {
	it("treats a flat +15 as additive, not percent", () => {
		const result = validateFlatBonus("1", "NPC bonus", 175, 15, false);
		expect(result.outcome).toBe("verified");
		expect(result.computed).toBe(190);
	});

	it("rejects interpreting a flat +15 as +15%", () => {
		// A flat +15 cannot be treated as a percentage bonus without a source
		// explicitly saying percent. The verifier therefore computes base + delta.
		const result = validateFlatBonus("2", "NPC bonus", 175, 15, false);
		expect(result.outcome).toBe("verified");
		expect(result.computed).toBe(190); // 175 + 15, not 175 × 1.15
		// Guard: without a percent source, the +15 must remain additive.
		expect(result.assumed).toContain("175 + 15");
		// Only an explicit percent source may produce 175 × 1.15 = 201.25.
		const percentOnly = validateFlatBonus("2", "percent misuse", 175, 15, true);
		expect(percentOnly.computed).toBeCloseTo(201.25);
	});

	it("applies a target multiplier to base then adds the flat proc", () => {
		const result = validateTargetMultiplierPlusProc("3", "target multiplier plus proc", 210, 3.5, 200, false);
		expect(result.outcome).toBe("verified");
		// 210 × 3.5 + 200 = 935
		expect(result.computed).toBe(935);
	});

	it("only multiplies the proc when the source says so", () => {
		// When source applies multiplier to proc: (210 + 200) × 3.5 = 1435
		const result = validateTargetMultiplierPlusProc("4", "multiplier applies to proc", 210, 3.5, 200, true);
		expect(result.computed).toBe(1435);
		// Default (no evidence) keeps the additive proc outside the multiplier.
		const defaultResult = validateTargetMultiplierPlusProc("5", "default", 210, 3.5, 200, false);
		expect(defaultResult.computed).toBe(935);
	});

	it("labels a per-cycle average not as DPS without sourced cadence", () => {
		const result = validateCycleAverage("6", "cycle average", [210, 210, 210, 210, 410]);
		expect(result.computed).toBe(250);
		// Explicitly not labeled DPS without attacks-per-second.
		expect(result.assumed).toContain("not labeled DPS");
	});

	it("computes DPS only when attacks-per-second is sourced", () => {
		const result = validateCycleAverage("7", "cycle DPS", [210, 210, 210, 210, 410], 2);
		expect(result.computed).toBe(500);
		expect(result.assumed).toContain("DPS");
	});

	it("computes percentage difference correctly", () => {
		expect(percentDifference(200, 250)).toBeCloseTo(25);
		expect(percentDifference(250, 200)).toBeCloseTo(-20);
	});

	it("applies upgrade levels with a cap", () => {
		const result = validateUpgradeLevels("8", "upgrades", 100, 5, 5, 20);
		// 5 × 5% = 25% but capped at 20% => 120
		expect(result.computed).toBe(120);
	});
});
