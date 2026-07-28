/**
 * Fixture expectation verification.
 *
 * Table-driven test that loads each M01-M20 and M14-alt fixture,
 * validates it, and asserts that runtime behavior matches the
 * declared expectations in the fixture manifest.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { initializeRequirementLedger, validateMissionContract } from "../../src/core/long-horizon/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures");

interface FixtureExpectation {
	contractValid?: boolean;
	errorContains?: string;
	requirementCount?: number;
	acceptanceCriterionCount?: number;
	initialRevision?: number;
	initialStates?: Record<string, string>;
	workstreamCount?: number;
}

interface ManifestEntry {
	contractValid?: boolean;
	errorContains?: string;
	requirementCount?: number;
	acceptanceCriterionCount?: number;
	initialRevision?: number;
	initialStates?: Record<string, string>;
	workstreamCount?: number;
}

interface Manifest {
	fixtures: Record<string, ManifestEntry>;
}

const manifest: Manifest = JSON.parse(readFileSync(resolve(fixturesDir, "manifest.json"), "utf-8"));

function loadFixture(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(resolve(fixturesDir, `${name}-contract.json`), "utf-8"));
}

const fixtureNames = [
	"M01",
	"M02",
	"M03",
	"M04",
	"M05",
	"M06",
	"M07",
	"M08",
	"M09",
	"M10",
	"M11",
	"M12",
	"M13",
	"M14",
	"M14-alt",
	"M15",
	"M16",
	"M17",
	"M18",
	"M19",
	"M20",
];

describe("Fixture expectation table", () => {
	for (const name of fixtureNames) {
		const expectations = manifest.fixtures[name] as FixtureExpectation | undefined;

		describe(`Fixture ${name}`, () => {
			it("loads from its own file", () => {
				const contract = loadFixture(name);
				expect(contract).toBeDefined();
				expect(typeof contract).toBe("object");
			});

			if (expectations?.contractValid !== undefined) {
				it(`contract validation: ${expectations.contractValid ? "valid" : "invalid"}`, () => {
					const contract = loadFixture(name);
					const result = validateMissionContract(contract);
					expect(result.valid).toBe(expectations.contractValid);
					if (expectations.errorContains) {
						expect(result.errors.some((e) => e.message.includes(expectations.errorContains!))).toBe(true);
					}
				});
			}

			if (expectations?.contractValid === true) {
				it("initializes ledger with expected revision", () => {
					const contract = loadFixture(name);
					const result = initializeRequirementLedger(contract as never);
					expect(result.ok).toBe(true);
					if (!result.ok) return;
					const ledger = result.value!;

					if (expectations.initialRevision !== undefined) {
						expect(ledger!.revision).toBe(expectations.initialRevision);
					}

					if (expectations.requirementCount !== undefined) {
						expect(ledger!.requirements).toHaveLength(expectations.requirementCount);
					}

					if (expectations.initialStates) {
						for (const [reqId, expectedStatus] of Object.entries(expectations.initialStates)) {
							const entry = ledger!.requirements.find((r) => r.requirementId === reqId);
							expect(entry).toBeDefined();
							expect(entry?.status).toBe(expectedStatus);
						}
					}
				});
			}
		});
	}
});
