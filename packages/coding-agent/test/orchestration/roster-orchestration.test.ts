/**
 * Roster/operator orchestration integration tests.
 *
 * Proves that roster-only operator roles are legally usable by orchestration
 * when the operator set is explicitly supplied to plan validation (through
 * the names exposed by the Qwen planner), while the canonical subagent
 * registry remains the default authority. Also covers the malformed
 * frontmatter and planner feedback visibility cases end to end.
 *
 * Deterministic: the stream function is mocked, no HTTP or provider calls
 * are made, and all state lives in a temp directory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@apholdings/jensen-agent-core";
import { type Context, createAssistantMessageEventStream, type Model } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { loadOperatorRoster } from "../../src/core/operator-roster.js";
import { validateOrchestrationPlan, validatePlanProposal } from "../../src/core/orchestration/index.js";
import { createQwenPlanner } from "../../src/core/orchestration/qwen-planner.js";
import type {
	OrchestrationNode,
	OrchestrationPlan,
	OrchestrationProposalInput,
} from "../../src/core/orchestration/types.js";

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

let root: string;
let cwd: string;
let agentDir: string;
let originalAgentDirEnv: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jensen-roster-orch-"));
	cwd = join(root, "repo");
	agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(agentDir, "agents"), { recursive: true });
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

interface StreamCapture {
	prompt?: string;
	calls: number;
}

function mockStreamFn(finalText: string, capture: StreamCapture): StreamFn {
	return (_model, context) => {
		capture.calls += 1;
		const lastUser = [...(context as Context).messages].reverse().find((message) => message?.role === "user");
		const content = lastUser?.content;
		capture.prompt =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map((block) => block.text)
							.join(" ")
					: "";
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

function writeOperatorFile(fileName: string, lines: string[]): void {
	writeFileSync(join(agentDir, "agents", fileName), lines.join("\n"));
}

function node(overrides: Partial<OrchestrationNode> = {}): OrchestrationNode {
	return {
		nodeId: overrides.nodeId ?? "recon",
		role: overrides.role ?? "investigation",
		nodeKind: overrides.nodeKind ?? "CHILD",
		objective: overrides.objective ?? "Trace the failing flow",
		agent: overrides.agent ?? "custom-op",
		executionMode: overrides.executionMode ?? "observe",
		requirement: overrides.requirement ?? "REQUIRED",
		workspaceAccess: overrides.workspaceAccess ?? "READ_ONLY",
		acceptanceCriteria: overrides.acceptanceCriteria ?? [],
		dependencyCriticality: 0,
		status: overrides.status ?? "PROPOSED",
		...overrides,
	};
}

function plan(overrides: Partial<OrchestrationPlan> = {}): OrchestrationPlan {
	return {
		schemaVersion: 1,
		orchestrationId: "orch_roster",
		parentMissionId: "mission_parent",
		decision: "FANOUT",
		rationale: "roster fanout",
		nodes: [],
		edges: [],
		revision: 1,
		state: "DRAFT",
		maxDepth: 2,
		maxChildrenPerNode: 20,
		maxTotalLogicalAgents: 20,
		maxReplans: 2,
		replanCount: 0,
		createdAtMs: 1,
		updatedAtMs: 1,
		...overrides,
	};
}

const PROPOSAL_OBJECT = {
	decision: "FANOUT",
	rationale: "independent recon before implementation",
	nodes: [
		{
			nodeId: "recon",
			role: "investigation",
			nodeKind: "CHILD",
			objective: "Trace the failing flow",
			agent: "custom-op",
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
		constraints: ["No force push"],
		maxTotalLogicalAgents: 4,
		...overrides,
	};
}

describe("roster FANOUT validation", () => {
	it("accepts a roster FANOUT proposal only when the operator set is supplied", async () => {
		writeOperatorFile("custom.md", [
			"---",
			"name: custom-op",
			"description: Custom operator.",
			"model: qwen3.8-27b",
			"---",
		]);
		const capture: StreamCapture = { calls: 0 };
		const planner = createQwenPlanner({
			cwd,
			agentDir,
			modelRegistry: registeredModelRegistry(),
			streamFn: mockStreamFn(JSON.stringify(PROPOSAL_OBJECT), capture),
		});
		const proposed = await planner.propose(proposalInput());
		expect(capture.calls).toBe(1);

		const parsed = validatePlanProposal(proposed);
		expect(parsed.valid).toBe(true);
		if (!parsed.valid) return;

		const rosterPlan = plan({
			nodes: parsed.proposal.nodes.map((item) => ({ ...item })),
			edges: parsed.proposal.edges,
		});

		// Without the explicit operator set, roster-only agents are rejected:
		// the canonical subagent registry stays the default authority.
		const withoutHook = validateOrchestrationPlan(rosterPlan);
		expect(withoutHook.valid).toBe(false);
		expect(withoutHook.issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining(["ORCHESTRATION_INVALID_ROLE"]),
		);
		expect(withoutHook.issues.filter((issue) => issue.code === "ORCHESTRATION_INVALID_ROLE")).toHaveLength(2);

		// With the operator set exposed by the planner, the same plan validates.
		const withHook = validateOrchestrationPlan(rosterPlan, { operatorAgents: planner.allowedAgents() });
		expect(withHook.issues).toEqual([]);
		expect(withHook.valid).toBe(true);
	});

	it("keeps the canonical registry authoritative for names outside the supplied set", () => {
		writeOperatorFile("custom.md", ["---", "name: custom-op", "description: Custom operator.", "---"]);
		const planner = createQwenPlanner({ cwd, agentDir, modelRegistry: registeredModelRegistry() });
		const operatorAgents = planner.allowedAgents();

		// A canonical-registry agent validates with or without the hook.
		const canonicalPlan = plan({ nodes: [node({ nodeId: "research", agent: "librarian" })] });
		expect(validateOrchestrationPlan(canonicalPlan).valid).toBe(true);
		expect(validateOrchestrationPlan(canonicalPlan, { operatorAgents }).valid).toBe(true);

		// A name in neither the registry nor the supplied set is still rejected.
		const unknownPlan = plan({ nodes: [node({ nodeId: "rogue", agent: "not-a-real-agent" })] });
		expect(validateOrchestrationPlan(unknownPlan, { operatorAgents }).valid).toBe(false);
	});

	it("excludes a malformed-frontmatter operator from the supplied set", () => {
		writeOperatorFile("broken.md", ["---", "name: [broken", "description: malformed yaml", "---"]);
		writeOperatorFile("custom.md", ["---", "name: custom-op", "description: Custom operator.", "---"]);

		const roster = loadOperatorRoster({ agentDir });
		const malformed = roster.diagnostics.find(
			(diagnostic) => diagnostic.code === "OPERATOR_ROSTER_FRONTMATTER_INVALID",
		);
		expect(malformed?.path).toBe("broken.md");
		expect(malformed?.message).toContain("broken.md");

		const planner = createQwenPlanner({ cwd, agentDir, modelRegistry: registeredModelRegistry() });
		const operatorAgents = planner.allowedAgents();
		expect(operatorAgents).toContain("custom-op");
		expect(operatorAgents).not.toContain("broken");

		// The broken name is rejected even with the supplied operator set.
		const brokenPlan = plan({ nodes: [node({ nodeId: "broken-node", agent: "broken" })] });
		const result = validateOrchestrationPlan(brokenPlan, { operatorAgents });
		expect(result.valid).toBe(false);
		expect(result.issues.map((issue) => issue.code)).toContain("ORCHESTRATION_INVALID_ROLE");
	});
});

describe("planner feedback visibility through the adapter", () => {
	it("shows the most recent constraint and an omission note at the eight-constraint cap", async () => {
		writeOperatorFile("custom.md", ["---", "name: custom-op", "description: Custom operator.", "---"]);
		const feedback = "FEEDBACK: previous proposal failed validation; use allowed agents only";
		const constraints = [
			"No force push",
			"Keep the diff small",
			"No new dependencies",
			"Update tests",
			"No refactors",
			"Stay in the package",
			"Document the change",
			"Run the checks",
			feedback,
		];
		const capture: StreamCapture = { calls: 0 };
		const planner = createQwenPlanner({
			cwd,
			agentDir,
			modelRegistry: registeredModelRegistry(),
			streamFn: mockStreamFn(JSON.stringify(PROPOSAL_OBJECT), capture),
			allowedAgents: ["custom-op"],
		});
		await planner.propose(proposalInput({ constraints }));
		expect(capture.calls).toBe(1);
		expect(capture.prompt).toContain(`- ${feedback}`);
		expect(capture.prompt).toContain("- No force push");
		expect(capture.prompt).not.toContain("- Run the checks");
		expect(capture.prompt).toContain(
			"1 constraint(s) omitted to fit the prompt budget; the most recent constraint is always shown.",
		);
	});
});
