import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCavecrew } from "./cavecrew-runtime.js";

const investigation = (assignment: string) => ({
	objective: assignment,
	summary: "fixture",
	flow: ["discover"],
	rootCauses: [],
	relevantFiles: ["one.txt"],
	unknowns: [],
	recommendedNextAgent: "planner",
});

const plan = {
	scope: ["one.txt", "two.txt"],
	nonGoals: [],
	implementationSteps: ["write fixture files"],
	invariants: ["bounded"],
	focusedTests: ["fixture"],
	acceptanceCriteria: ["files exist"],
	rollbackExpectations: ["restore checkpoint"],
};

const builder = {
	objective: "fixture",
	status: "implemented" as const,
	filesChanged: ["one.txt", "two.txt"],
	validations: ["fixture-pass"],
	rollbackState: "confirmed" as const,
	remainingRisks: [],
};

const review = { verdict: "pass" as const, findings: [], missingTests: [], acceptanceGaps: [] };

async function fixture(overrides: Partial<Parameters<typeof runCavecrew>[0]["fixtures"]> = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "jensen-cavecrew-"));
	const storageDir = join(cwd, ".state");
	const fixtures = {
		investigator: async (assignment: string) => investigation(assignment),
		planner: async () => plan,
		builder: async () => ({
			edits: [
				{ kind: "create_file" as const, path: "one.txt", content: "one" },
				{ kind: "create_file" as const, path: "two.txt", content: "two" },
			],
			output: builder,
		}),
		reviewer: async () => review,
		...overrides,
	};
	return { cwd, storageDir, fixtures };
}

describe("deterministic Cavecrew runtime", () => {
	it("runs parallel investigators, planner, transactional builder, and reviewer", async () => {
		const context = await fixture();
		try {
			const result = await runCavecrew({ objective: "fixture", assignments: ["a", "b"], ...context });
			expect(result.state).toBe("completed");
			expect(result.investigations.map((item) => item.objective)).toEqual(["a", "b"]);
			expect(result.builder?.rollbackState).toBe("confirmed");
			expect(await readFile(join(context.cwd, "one.txt"), "utf8")).toBe("one");
		} finally {
			await rm(context.cwd, { recursive: true, force: true });
		}
	});

	it("rejects a plan beyond the builder scope before mutation", async () => {
		const context = await fixture({ planner: async () => ({ ...plan, scope: ["a", "b", "c"] }) });
		try {
			const result = await runCavecrew({ objective: "fixture", assignments: ["a"], ...context });
			expect(result.state).toBe("plan_invalid");
			expect(await readFile(join(context.cwd, "one.txt"), "utf8").catch(() => null)).toBeNull();
		} finally {
			await rm(context.cwd, { recursive: true, force: true });
		}
	});

	it("cancels before starting the mutation barrier", async () => {
		const controller = new AbortController();
		controller.abort();
		const context = await fixture();
		try {
			const result = await runCavecrew({
				objective: "fixture",
				assignments: ["a"],
				signal: controller.signal,
				...context,
			});
			expect(result.state).toBe("cancelled");
		} finally {
			await rm(context.cwd, { recursive: true, force: true });
		}
	});
});
