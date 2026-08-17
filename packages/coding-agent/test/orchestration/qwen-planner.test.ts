/**
 * Local Qwen orchestration planner adapter tests.
 *
 * Deterministic: the stream function is mocked, no HTTP or provider calls are
 * made, and all state lives in a temp directory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@apholdings/jensen-agent-core";
import { type Context, createAssistantMessageEventStream, type Model } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import {
	buildQwenPlannerPrompt,
	createQwenPlanner,
	DEFAULT_QWEN_PLANNER_PROMPT_BUDGET,
	minQwenPlannerPromptBudget,
	parseQwenPlannerOutput,
} from "../../src/core/orchestration/qwen-planner.js";
import type { OrchestrationProposalInput } from "../../src/core/orchestration/types.js";
import { SessionManager } from "../../src/core/session-manager.js";

const LOCAL_MODEL: Model<"openai-completions"> = {
	id: "qwen3.8-27b",
	name: "Qwen 3.8 27B (local)",
	provider: "llamacpp-qwen38-bucephalus",
	api: "openai-completions",
	baseUrl: "http://bucephalus.local:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 196_608,
	maxTokens: 8_192,
};

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const PROPOSAL_OBJECT = {
	decision: "FANOUT",
	rationale: "independent recon before implementation",
	nodes: [
		{
			nodeId: "recon",
			role: "investigation",
			nodeKind: "CHILD",
			objective: "Trace the failing flow",
			agent: "investigator",
			executionMode: "observe",
			requirement: "REQUIRED",
			workspaceAccess: "READ_ONLY",
			status: "PROPOSED",
			acceptanceCriteria: ["Root cause identified"],
		},
		{
			nodeId: "verify",
			role: "testing",
			nodeKind: "VERIFICATION",
			objective: "Verify the fix",
			agent: "tester",
			executionMode: "observe",
			requirement: "VERIFICATION_GATING",
			workspaceAccess: "READ_ONLY",
			status: "PROPOSED",
			acceptanceCriteria: ["Tests pass"],
		},
	],
	edges: [{ from: "recon", to: "verify", kind: "REQUIRED" }],
};

function proposalInput(overrides: Partial<OrchestrationProposalInput> = {}): OrchestrationProposalInput {
	return {
		parentMissionId: "mission_parent",
		objective: "Ship the bounded fix",
		constraints: ["No force push", "Keep the diff small"],
		maxTotalLogicalAgents: 4,
		...overrides,
	};
}

function textOfUserPrompt(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content))
			return content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join(" ");
	}
	return "";
}

function userMessageTexts(context: Context): string[] {
	return context.messages
		.filter((message) => message?.role === "user")
		.map((message) => {
			const content = message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content))
				return content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join(" ");
			return "";
		});
}

interface StreamCapture {
	model?: Model<any>;
	prompt?: string;
	toolNames?: string[];
	calls: number;
}

function mockStreamFn(finalText: string, capture: StreamCapture): StreamFn {
	return (model, context) => {
		capture.calls += 1;
		capture.model = model as Model<any>;
		capture.prompt = textOfUserPrompt(context as Context);
		capture.toolNames = (context as Context).tools?.map((tool) => tool.name);
		const stream = createAssistantMessageEventStream();
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text: finalText }],
				api: LOCAL_MODEL.api,
				provider: LOCAL_MODEL.provider,
				model: LOCAL_MODEL.id,
				usage: { ...ZERO_USAGE },
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
		stream.end();
		return stream;
	};
}

function errorStreamFn(capture: StreamCapture): StreamFn {
	return (model, _context) => {
		capture.calls += 1;
		capture.model = model as Model<any>;
		const stream = createAssistantMessageEventStream();
		stream.push({
			type: "error",
			reason: "error",
			error: {
				role: "assistant",
				content: [],
				api: LOCAL_MODEL.api,
				provider: LOCAL_MODEL.provider,
				model: LOCAL_MODEL.id,
				usage: { ...ZERO_USAGE },
				stopReason: "error",
				errorMessage: "local backend unavailable",
				timestamp: Date.now(),
			},
		});
		stream.end();
		return stream;
	};
}

let root: string;
let cwd: string;
let agentDir: string;
let originalAgentDirEnv: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jensen-qwen-planner-"));
	cwd = join(root, "repo");
	agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	originalAgentDirEnv = process.env.JENSEN_CODING_AGENT_DIR;
	process.env.JENSEN_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (originalAgentDirEnv === undefined) delete process.env.JENSEN_CODING_AGENT_DIR;
	else process.env.JENSEN_CODING_AGENT_DIR = originalAgentDirEnv;
	rmSync(root, { recursive: true, force: true });
});

function registeredModelRegistry(): ModelRegistry {
	const registry = new ModelRegistry(AuthStorage.inMemory(), join(agentDir, "models.json"));
	registry.registerProvider(LOCAL_MODEL.provider, {
		api: LOCAL_MODEL.api,
		apiKey: "local-qwen-key",
		baseUrl: LOCAL_MODEL.baseUrl,
		models: [
			{
				id: LOCAL_MODEL.id,
				name: LOCAL_MODEL.name,
				api: LOCAL_MODEL.api,
				reasoning: LOCAL_MODEL.reasoning,
				input: LOCAL_MODEL.input,
				cost: LOCAL_MODEL.cost,
				contextWindow: LOCAL_MODEL.contextWindow,
				maxTokens: LOCAL_MODEL.maxTokens,
			},
		],
	});
	return registry;
}

describe("buildQwenPlannerPrompt", () => {
	it("builds a bounded structured JSON prompt", () => {
		const prompt = buildQwenPlannerPrompt({
			parentMissionId: "mission_parent",
			objective: "Ship the bounded fix",
			constraints: ["No force push"],
			maxTotalLogicalAgents: 4,
			allowedAgents: ["investigator", "tester", "synthesizer"],
		});
		expect(prompt).toContain("exactly one JSON object");
		expect(prompt).toContain('"decision": "DIRECT" | "FANOUT"');
		expect(prompt).toContain("at most 4 nodes");
		expect(prompt).toContain("investigator, tester, synthesizer");
		expect(prompt).toContain("Parent mission id: mission_parent");
		expect(prompt).toContain("Ship the bounded fix");
		expect(prompt).toContain("- No force push");
		expect(prompt.length).toBeLessThanOrEqual(DEFAULT_QWEN_PLANNER_PROMPT_BUDGET);
	});

	it("stays within the budget for oversized objectives and constraints", () => {
		const budget = 2_000;
		const prompt = buildQwenPlannerPrompt({
			parentMissionId: "mission_parent",
			objective: "x".repeat(60_000),
			constraints: Array.from({ length: 20 }, (_, i) => `constraint ${i}: ${"y".repeat(500)}`),
			maxTotalLogicalAgents: 4,
			allowedAgents: ["investigator"],
			maxCharacters: budget,
		});
		expect(prompt.length).toBeLessThanOrEqual(budget);
		expect(prompt).toContain("Parent mission id: mission_parent");
	});

	it("keeps the most recent constraint visible when the count cap omits constraints", () => {
		const constraints = Array.from({ length: 8 }, (_, i) => `constraint ${i}`);
		const feedback = "FEEDBACK: previous proposal failed validation; use allowed agents only";
		const prompt = buildQwenPlannerPrompt({
			parentMissionId: "mission_parent",
			objective: "Ship the bounded fix",
			constraints: [...constraints, feedback],
			maxTotalLogicalAgents: 4,
			allowedAgents: ["investigator"],
		});
		expect(prompt).toContain(`- ${feedback}`);
		expect(prompt).toContain("- constraint 0");
		expect(prompt).toContain("- constraint 6");
		expect(prompt).not.toContain("- constraint 7");
		expect(prompt).toContain(
			"1 constraint(s) omitted to fit the prompt budget; the most recent constraint is always shown.",
		);
		expect(prompt.length).toBeLessThanOrEqual(DEFAULT_QWEN_PLANNER_PROMPT_BUDGET);
	});

	it("keeps planner feedback visible under budget pressure at the eight-constraint cap", () => {
		const constraints = Array.from({ length: 8 }, (_, i) => `constraint ${i}: ${"y".repeat(190)}`);
		const feedback = "FEEDBACK: previous proposal failed validation";
		const prompt = buildQwenPlannerPrompt({
			parentMissionId: "mission_parent",
			objective: "Ship the bounded fix",
			constraints: [...constraints, feedback],
			maxTotalLogicalAgents: 4,
			allowedAgents: ["investigator"],
			maxCharacters: 2_000,
		});
		expect(prompt.length).toBeLessThanOrEqual(2_000);
		expect(prompt).toContain(`- ${feedback}`);
		expect(prompt).toContain(
			"constraint(s) omitted to fit the prompt budget; the most recent constraint is always shown.",
		);
	});

	it("shows a visible objective truncation note when the objective is cut to the budget", () => {
		const prompt = buildQwenPlannerPrompt({
			parentMissionId: "mission_parent",
			objective: "x".repeat(60_000),
			constraints: ["No force push"],
			maxTotalLogicalAgents: 4,
			allowedAgents: ["investigator"],
			maxCharacters: 2_000,
		});
		expect(prompt.length).toBeLessThanOrEqual(2_000);
		expect(prompt).toContain("Objective truncated to fit the prompt budget.");
	});

	it("throws ORCHESTRATION_PLANNER_BUDGET_BELOW_FLOOR below the template floor and fits at the floor", () => {
		const input = {
			parentMissionId: "mission_parent",
			objective: "Ship the bounded fix",
			constraints: ["No force push"],
			maxTotalLogicalAgents: 4,
			allowedAgents: ["investigator", "tester", "synthesizer"],
		};
		const floor = minQwenPlannerPromptBudget(input);
		expect(() => buildQwenPlannerPrompt({ ...input, maxCharacters: floor - 1 })).toThrow(
			"ORCHESTRATION_PLANNER_BUDGET_BELOW_FLOOR",
		);
		const atFloor = buildQwenPlannerPrompt({ ...input, maxCharacters: floor });
		expect(atFloor.length).toBeLessThanOrEqual(floor);
	});
});

describe("parseQwenPlannerOutput", () => {
	it("parses bare JSON, fenced JSON, and JSON embedded in prose", () => {
		const bare = JSON.stringify(PROPOSAL_OBJECT);
		expect(parseQwenPlannerOutput(bare)).toEqual(PROPOSAL_OBJECT);
		expect(parseQwenPlannerOutput(`\`\`\`json\n${bare}\n\`\`\``)).toEqual(PROPOSAL_OBJECT);
		expect(parseQwenPlannerOutput(`Here is the plan:\n${bare}\nDone.`)).toEqual(PROPOSAL_OBJECT);
	});

	it("rejects prose without a JSON object and non-object JSON", () => {
		expect(() => parseQwenPlannerOutput("I cannot produce JSON.")).toThrow("ORCHESTRATION_PLANNER_OUTPUT_INVALID");
		expect(() => parseQwenPlannerOutput("[1, 2, 3]")).toThrow("ORCHESTRATION_PLANNER_OUTPUT_INVALID");
	});
});

describe("QwenPlannerAdapter", () => {
	it("returns machine JSON through the normal session path with the local Qwen model and read-only tools", async () => {
		const capture: StreamCapture = { calls: 0 };
		const planner = createQwenPlanner({
			cwd,
			agentDir,
			modelRegistry: registeredModelRegistry(),
			streamFn: mockStreamFn(`Here is the plan:\n\`\`\`json\n${JSON.stringify(PROPOSAL_OBJECT)}\n\`\`\``, capture),
			allowedAgents: ["investigator", "tester", "synthesizer"],
		});
		const proposal = await planner.propose(proposalInput());
		expect(capture.calls).toBe(1);
		expect(proposal).toEqual(PROPOSAL_OBJECT);
		expect(capture.model?.provider).toBe("llamacpp-qwen38-bucephalus");
		expect(capture.model?.id).toBe("qwen3.8-27b");
		expect(capture.prompt).toContain("Ship the bounded fix");
		expect(capture.prompt).toContain("No force push");
		expect(capture.prompt).toContain("investigator, tester, synthesizer");
		expect(capture.prompt?.length).toBeLessThanOrEqual(DEFAULT_QWEN_PLANNER_PROMPT_BUDGET);
		expect(capture.toolNames).toContain("read");
		expect(capture.toolNames).not.toContain("edit");
		expect(capture.toolNames).not.toContain("write");
		expect(capture.toolNames).not.toContain("bash");
	});

	it("derives allowed agents from the operator roster by default", async () => {
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "custom.md"),
			["---", "name: custom-op", "description: Custom operator.", "model: qwen3.8-27b", "---"].join("\n"),
		);
		const capture: StreamCapture = { calls: 0 };
		const planner = createQwenPlanner({
			cwd,
			agentDir,
			modelRegistry: registeredModelRegistry(),
			streamFn: mockStreamFn(JSON.stringify(PROPOSAL_OBJECT), capture),
		});
		await planner.propose(proposalInput());
		expect(capture.prompt).toContain("custom-op, investigator, synthesizer, tester");
	});

	it("exposes roster definitions and allowed names for the validation hook", () => {
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "custom.md"),
			["---", "name: custom-op", "description: Custom operator.", "model: qwen3.8-27b", "---"].join("\n"),
		);
		const planner = createQwenPlanner({ cwd, agentDir, modelRegistry: registeredModelRegistry() });
		const allowed = planner.allowedAgents();
		expect(allowed).toContain("custom-op");
		for (const name of ["investigator", "tester", "synthesizer"]) expect(allowed).toContain(name);
		const roster = planner.roster();
		expect(roster.agents.find((agent) => agent.name === "custom-op")?.source).toBe("file");
		expect(roster.diagnostics).toEqual([]);
		// An explicit option wins over the roster.
		const pinned = createQwenPlanner({
			cwd,
			agentDir,
			modelRegistry: registeredModelRegistry(),
			allowedAgents: ["custom-op"],
		});
		expect(pinned.allowedAgents()).toEqual(["custom-op"]);
	});

	it("uses a fresh in-memory session per propose when no session manager is supplied", async () => {
		const userTexts: string[][] = [];
		const planner = createQwenPlanner({
			cwd,
			agentDir,
			modelRegistry: registeredModelRegistry(),
			streamFn: ((_model, context) => {
				userTexts.push(userMessageTexts(context as Context));
				const stream = createAssistantMessageEventStream();
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: JSON.stringify(PROPOSAL_OBJECT) }],
						api: LOCAL_MODEL.api,
						provider: LOCAL_MODEL.provider,
						model: LOCAL_MODEL.id,
						usage: { ...ZERO_USAGE },
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
				stream.end();
				return stream;
			}) as StreamFn,
		});
		await planner.propose(proposalInput({ objective: "Ship the bounded fix, round one" }));
		await planner.propose(proposalInput({ objective: "Ship the bounded fix, round two" }));
		expect(userTexts).toHaveLength(2);
		// The first proposal's prompt must not leak into the second call's context.
		const firstPrompt = userTexts[0].find((text) => text.includes("round one"));
		expect(firstPrompt).toBeDefined();
		expect(userTexts[1].some((text) => text.includes("round one"))).toBe(false);
		expect(userTexts[1].some((text) => text.includes("round two"))).toBe(true);
	});

	it("reuses the supplied session manager across proposes", async () => {
		const userTexts: string[][] = [];
		const planner = createQwenPlanner({
			cwd,
			agentDir,
			modelRegistry: registeredModelRegistry(),
			sessionManager: SessionManager.inMemory(cwd),
			streamFn: ((_model, context) => {
				userTexts.push(userMessageTexts(context as Context));
				const stream = createAssistantMessageEventStream();
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: JSON.stringify(PROPOSAL_OBJECT) }],
						api: LOCAL_MODEL.api,
						provider: LOCAL_MODEL.provider,
						model: LOCAL_MODEL.id,
						usage: { ...ZERO_USAGE },
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
				stream.end();
				return stream;
			}) as StreamFn,
		});
		await planner.propose(proposalInput({ objective: "Ship the bounded fix, round one" }));
		await planner.propose(proposalInput({ objective: "Ship the bounded fix, round two" }));
		expect(userTexts).toHaveLength(2);
		// With an explicitly supplied manager, history carries across proposals.
		expect(userTexts[1].some((text) => text.includes("round one"))).toBe(true);
		expect(userTexts[1].some((text) => text.includes("round two"))).toBe(true);
	});

	it("throws ORCHESTRATION_PLANNER_MODEL_UNAVAILABLE when the local model is unregistered", async () => {
		const capture: StreamCapture = { calls: 0 };
		const planner = createQwenPlanner({
			cwd,
			agentDir,
			modelRegistry: new ModelRegistry(AuthStorage.inMemory(), join(agentDir, "models.json")),
			streamFn: mockStreamFn(JSON.stringify(PROPOSAL_OBJECT), capture),
		});
		await expect(planner.propose(proposalInput())).rejects.toThrow("ORCHESTRATION_PLANNER_MODEL_UNAVAILABLE");
		expect(capture.calls).toBe(0);
	});

	it("throws ORCHESTRATION_PLANNER_INFERENCE_FAILED when the stream reports an error", async () => {
		const capture: StreamCapture = { calls: 0 };
		const planner = createQwenPlanner({
			cwd,
			agentDir,
			modelRegistry: registeredModelRegistry(),
			streamFn: errorStreamFn(capture),
			allowedAgents: ["investigator"],
		});
		await expect(planner.propose(proposalInput())).rejects.toThrow("ORCHESTRATION_PLANNER_INFERENCE_FAILED");
	});

	it("throws ORCHESTRATION_PLANNER_OUTPUT_INVALID when the final message is not machine JSON", async () => {
		const capture: StreamCapture = { calls: 0 };
		const planner = createQwenPlanner({
			cwd,
			agentDir,
			modelRegistry: registeredModelRegistry(),
			streamFn: mockStreamFn("I cannot produce a JSON plan.", capture),
			allowedAgents: ["investigator"],
		});
		await expect(planner.propose(proposalInput())).rejects.toThrow("ORCHESTRATION_PLANNER_OUTPUT_INVALID");
	});
});
