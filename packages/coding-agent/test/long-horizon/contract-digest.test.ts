/**
 * Contract digest stability and sensitivity tests.
 *
 * Verifies that computeMissionContractDigest produces:
 *   - stable output for identical contracts
 *   - different output for semantically different contracts
 *   - lowercase hexadecimal format
 *   - deterministic across multiple calls
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
	computeMissionContractDigest,
	initializeRequirementLedger,
	type MissionContractV1,
} from "../../src/core/long-horizon/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures");

function loadContract(name: string): MissionContractV1 {
	return JSON.parse(readFileSync(resolve(fixturesDir, `${name}-contract.json`), "utf-8"));
}

describe("Contract digest stability", () => {
	it("produces the same digest across multiple calls", () => {
		const contract = loadContract("M01");
		const d1 = computeMissionContractDigest(contract);
		const d2 = computeMissionContractDigest(contract);
		const d3 = computeMissionContractDigest(contract);
		expect(d1).toBe(d2);
		expect(d1).toBe(d3);
	});

	it("produces lowercase hexadecimal output", () => {
		const contract = loadContract("M01");
		const digest = computeMissionContractDigest(contract);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces different digest for different contracts", () => {
		const c1 = loadContract("M01");
		const c2 = loadContract("M02");
		const d1 = computeMissionContractDigest(c1);
		const d2 = computeMissionContractDigest(c2);
		expect(d1).not.toBe(d2);
	});
});

describe("Contract digest sensitivity", () => {
	it("changes when objective changes", () => {
		const contract = loadContract("M01");
		const d1 = computeMissionContractDigest(contract);
		const modified = { ...contract, objective: `${contract.objective} (modified)` };
		expect(computeMissionContractDigest(modified)).not.toBe(d1);
	});

	it("changes when title changes", () => {
		const contract = loadContract("M01");
		const d1 = computeMissionContractDigest(contract);
		const modified = { ...contract, title: "New Title" };
		expect(computeMissionContractDigest(modified)).not.toBe(d1);
	});

	it("changes when revision changes", () => {
		const contract = loadContract("M01");
		const d1 = computeMissionContractDigest(contract);
		const modified = { ...contract, revision: 99 };
		expect(computeMissionContractDigest(modified)).not.toBe(d1);
	});

	it("changes when a requirement statement changes", () => {
		const contract = loadContract("M01");
		const d1 = computeMissionContractDigest(contract);
		const modified = {
			...contract,
			requirements: contract.requirements.map((r) => ({
				...r,
				statement: "Modified statement",
			})),
		} as MissionContractV1;
		expect(computeMissionContractDigest(modified)).not.toBe(d1);
	});

	it("changes when a constraint is added", () => {
		const contract = loadContract("M01");
		const d1 = computeMissionContractDigest(contract);
		const modified = {
			...contract,
			constraints: [
				...contract.constraints,
				{
					id: "C-NEW",
					kind: "SECURITY" as const,
					statement: "New rule",
					sourceRefs: [],
					severity: "error" as const,
				},
			],
		};
		expect(computeMissionContractDigest(modified)).not.toBe(d1);
	});

	it("changes when a workstream is added", () => {
		const contract = loadContract("M01");
		const d1 = computeMissionContractDigest(contract);
		const modified = {
			...contract,
			workstreams: [...contract.workstreams, { id: "WS-NEW", title: "New", order: 99 }],
		};
		expect(computeMissionContractDigest(modified)).not.toBe(d1);
	});
});

describe("Contract digest excludes metadata", () => {
	it("does not change when metadata changes", () => {
		const contract = loadContract("M01");
		const d1 = computeMissionContractDigest(contract);
		const modified = { ...contract, metadata: { foo: "bar" } };
		expect(computeMissionContractDigest(modified)).toBe(d1);
	});

	it("does not change when metadata is added", () => {
		const contract = { ...loadContract("M01") };
		const d1 = computeMissionContractDigest(contract as MissionContractV1);
		(contract as unknown as Record<string, unknown>).metadata = { timestamp: "2024-01-01", author: "test" };
		expect(computeMissionContractDigest(contract as MissionContractV1)).toBe(d1);
	});
});

describe("Contract digest bound to ledger", () => {
	it("ledger stores correct contract digest", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const expectedDigest = computeMissionContractDigest(contract);
		expect(result.value!.contractDigest).toBe(expectedDigest);
	});

	it("ledger stores missionId and contractRevision", () => {
		const contract = loadContract("M01");
		const result = initializeRequirementLedger(contract);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value!.missionId).toBe(contract.missionId);
		expect(result.value!.contractRevision).toBe(contract.revision);
	});
});
