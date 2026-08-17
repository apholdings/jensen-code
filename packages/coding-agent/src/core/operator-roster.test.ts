import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isLocalOperatorModel,
	loadOperatorRoster,
	OPERATOR_LOCAL_MODEL_REFERENCE,
	OPERATOR_ROSTER_NAMES,
} from "./operator-roster.js";

const roots: string[] = [];

function agentDirWith(files: Record<string, string>): string {
	const base = mkdtempSync(join(tmpdir(), "jensen-operator-roster-"));
	roots.push(base);
	mkdirSync(join(base, "agents"), { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(base, "agents", name), content);
	return base;
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("operator roster loading", () => {
	it("loads file agents from getAgentDir()/agents/*.md frontmatter", () => {
		const agentDir = agentDirWith({
			"custom-op.md": [
				"---",
				"name: custom-op",
				"description: A custom operator.",
				"tools: read, grep",
				"model: qwen3.8-27b",
				"---",
				"Body content is ignored by the loader.",
			].join("\n"),
		});
		const roster = loadOperatorRoster({ agentDir });
		const custom = roster.agents.find((agent) => agent.name === "custom-op");
		expect(custom).toMatchObject({
			description: "A custom operator.",
			tools: ["read", "grep"],
			model: OPERATOR_LOCAL_MODEL_REFERENCE,
			source: "file",
			filePath: "custom-op.md",
		});
		expect(roster.diagnostics).toEqual([]);
	});

	it("normalizes the full provider/model local reference and accepts array tools", () => {
		const agentDir = agentDirWith({
			"full-ref.md": [
				"---",
				"name: full-ref",
				"tools:",
				"  - read",
				"  - ls",
				`  - ${OPERATOR_LOCAL_MODEL_REFERENCE}`,
				"---",
			].join("\n"),
			"array-tools.md": ["---", "name: array-tools", "tools: [read, find]", "---"].join("\n"),
		});
		const roster = loadOperatorRoster({ agentDir });
		const fullRef = roster.agents.find((agent) => agent.name === "full-ref");
		expect(fullRef?.model).toBe(OPERATOR_LOCAL_MODEL_REFERENCE);
		expect(fullRef?.tools).toEqual(["read", "ls", OPERATOR_LOCAL_MODEL_REFERENCE]);
		expect(roster.agents.find((agent) => agent.name === "array-tools")?.tools).toEqual(["read", "find"]);
	});

	it("defaults to the local model when frontmatter omits it", () => {
		const agentDir = agentDirWith({
			"no-model.md": ["---", "name: no-model", "description: No model declared.", "---"].join("\n"),
		});
		const roster = loadOperatorRoster({ agentDir });
		expect(roster.agents.find((agent) => agent.name === "no-model")?.model).toBe(OPERATOR_LOCAL_MODEL_REFERENCE);
		expect(roster.diagnostics).toEqual([]);
	});

	it("skips files without a frontmatter name", () => {
		const agentDir = agentDirWith({
			"anonymous.md": ["---", "description: Missing name.", "---", "body"].join("\n"),
			"not-frontmatter.md": ["plain body without frontmatter"].join("\n"),
		});
		const roster = loadOperatorRoster({ agentDir });
		expect(roster.agents.filter((agent) => agent.source === "file")).toEqual([]);
		expect(roster.diagnostics.map((d) => d.code)).toEqual([
			"OPERATOR_ROSTER_NAME_MISSING",
			"OPERATOR_ROSTER_NAME_MISSING",
		]);
	});

	it("emits a per-file diagnostic for malformed frontmatter and keeps loading the rest", () => {
		const agentDir = agentDirWith({
			"broken.md": ["---", "name: [unclosed", "description: malformed yaml", "---"].join("\n"),
			"good.md": ["---", "name: good-op", "description: Fine.", "---"].join("\n"),
		});
		const roster = loadOperatorRoster({ agentDir });
		expect(roster.agents.find((agent) => agent.name === "good-op")?.source).toBe("file");
		const broken = roster.diagnostics.find((diagnostic) => diagnostic.code === "OPERATOR_ROSTER_FRONTMATTER_INVALID");
		expect(broken).toMatchObject({ path: "broken.md" });
		expect(broken?.message).toContain("broken.md");
		expect(roster.agents.find((agent) => agent.name === "broken")).toBeUndefined();
		// Canonical roles are still guaranteed next to the diagnostic.
		for (const name of OPERATOR_ROSTER_NAMES) expect(roster.agents.some((agent) => agent.name === name)).toBe(true);
	});

	it("keeps the first of duplicate names", () => {
		const agentDir = agentDirWith({
			"a.md": ["---", "name: dup", "description: first", "---"].join("\n"),
			"b.md": ["---", "name: dup", "description: second", "---"].join("\n"),
		});
		const roster = loadOperatorRoster({ agentDir });
		const duplicates = roster.agents.filter((agent) => agent.name === "dup");
		expect(duplicates).toHaveLength(1);
		expect(duplicates[0].description).toBe("first");
		expect(roster.diagnostics.map((d) => d.code)).toEqual(["OPERATOR_ROSTER_NAME_DUPLICATE"]);
	});

	it("rejects non-local models in strict mode", () => {
		const agentDir = agentDirWith({
			"cloud.md": ["---", "name: cloud-op", "model: openai/gpt-5.6-luna", "---"].join("\n"),
		});
		const roster = loadOperatorRoster({ agentDir });
		expect(roster.agents.find((agent) => agent.name === "cloud-op")).toBeUndefined();
		expect(roster.diagnostics).toEqual([
			{
				code: "OPERATOR_ROSTER_MODEL_NON_LOCAL",
				message: "Operator cloud-op declares non-local model openai/gpt-5.6-luna",
				path: "cloud.md",
			},
		]);
		// Synthesized roles are still present and strictly local.
		for (const name of OPERATOR_ROSTER_NAMES)
			expect(roster.agents.find((agent) => agent.name === name)?.model).toBe(OPERATOR_LOCAL_MODEL_REFERENCE);
	});

	it("keeps non-local models with a diagnostic in non-strict mode", () => {
		const agentDir = agentDirWith({
			"cloud.md": ["---", "name: cloud-op", "model: openai/gpt-5.6-luna", "---"].join("\n"),
		});
		const roster = loadOperatorRoster({ agentDir, strict: false });
		expect(roster.agents.find((agent) => agent.name === "cloud-op")?.model).toBe("openai/gpt-5.6-luna");
		expect(roster.diagnostics.map((d) => d.code)).toEqual(["OPERATOR_ROSTER_MODEL_NON_LOCAL"]);
	});

	it("synthesizes only the missing canonical operator roles", () => {
		const agentDir = agentDirWith({
			"investigator.md": ["---", "name: investigator", "description: File-provided investigator.", "---"].join("\n"),
		});
		const roster = loadOperatorRoster({ agentDir });
		expect(roster.agents.find((agent) => agent.name === "investigator")?.source).toBe("file");
		for (const name of ["tester", "synthesizer"]) {
			const agent = roster.agents.find((candidate) => candidate.name === name);
			expect(agent?.source).toBe("synthesized");
			expect(agent?.model).toBe(OPERATOR_LOCAL_MODEL_REFERENCE);
			expect(agent?.tools).toEqual(["read", "grep", "find", "ls"]);
			expect(agent?.description.length).toBeGreaterThan(0);
		}
	});

	it("returns exactly the three synthesized roles when the agents directory is absent", () => {
		const base = mkdtempSync(join(tmpdir(), "jensen-operator-roster-empty-"));
		roots.push(base);
		const roster = loadOperatorRoster({ agentDir: base });
		expect(roster.agents.map((agent) => agent.name)).toEqual([...OPERATOR_ROSTER_NAMES].sort());
		expect(roster.agents.every((agent) => agent.model === OPERATOR_LOCAL_MODEL_REFERENCE)).toBe(true);
		expect(roster.diagnostics).toEqual([]);
	});

	it("orders the roster deterministically by name", () => {
		const agentDir = agentDirWith({
			"zeta.md": ["---", "name: zeta", "---"].join("\n"),
			"alpha.md": ["---", "name: alpha", "---"].join("\n"),
			"mid.md": ["---", "name: mid", "---"].join("\n"),
		});
		const roster = loadOperatorRoster({ agentDir });
		expect(roster.agents.map((agent) => agent.name)).toEqual([
			"alpha",
			"investigator",
			"mid",
			"synthesizer",
			"tester",
			"zeta",
		]);
	});

	it("recognizes the local model as bare id or full reference", () => {
		expect(isLocalOperatorModel("qwen3.8-27b")).toBe(true);
		expect(isLocalOperatorModel(OPERATOR_LOCAL_MODEL_REFERENCE)).toBe(true);
		expect(isLocalOperatorModel("openai/gpt-5.6-luna")).toBe(false);
		expect(isLocalOperatorModel("")).toBe(false);
	});
});
