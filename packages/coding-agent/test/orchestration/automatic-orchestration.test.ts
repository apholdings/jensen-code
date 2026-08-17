/**
 * Automatic Qwen orchestration planning — service and CLI integration tests.
 *
 * Wires plain mocked planners and the reviewed QwenPlannerAdapter (with a
 * deterministic mocked stream function) into
 * `OrchestratorService.startAutomatic` / `previewAutomatic` and the
 * `jensen orchestrator preview|start` commands without `--proposal`.
 * Deterministic: no real Qwen inference, no HTTP or provider calls, and all
 * state lives in temp directories.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { StreamFn } from "@apholdings/jensen-agent-core";
import { type Context, createAssistantMessageEventStream, type Model } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { createDurableMissionRecord, createMissionRequest } from "../../src/core/mission-domain/index.js";
import { createFileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { handleOrchestratorCommand } from "../../src/core/orchestration/cli.js";
import {
	type AutomaticStartResult,
	createFileOrchestrationStore,
	createParentOrchestrationExecution,
	createQwenPlanner,
	OrchestratorService,
} from "../../src/core/orchestration/index.js";
import type {
	OrchestrationChildExecutionPort,
	OrchestrationPlanner,
	OrchestrationPlanProposal,
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

/** Operator roster names: not in the canonical subagent registry. */
const ROSTER_AGENTS = ["investigator", "tester", "synthesizer"];

/** A FANOUT proposal that only the explicit operatorAgents hook can validate. */
function fanoutProposal(): unknown {
	return {
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
}

interface MockPlannerCapture {
	calls: number;
	inputs: OrchestrationProposalInput[];
}

function mockPlanner(
	capture: MockPlannerCapture,
	respond: (input: OrchestrationProposalInput) => unknown = () => fanoutProposal(),
	allowedAgents?: readonly string[],
): OrchestrationPlanner {
	const planner: OrchestrationPlanner = {
		async propose(input) {
			capture.calls += 1;
			capture.inputs.push(input);
			return respond(input);
		},
	};
	if (allowedAgents) planner.allowedAgents = () => allowedAgents;
	return planner;
}

async function parentFixture(base: string) {
	const missions = createFileDurableMissionStore(path.join(base, "missions"));
	await missions.create(
		createDurableMissionRecord({
			request: createMissionRequest({
				missionId: "mission_parent",
				objective: "Ship the bounded fix",
				agent: "worker",
				executionMode: "execute",
				acceptanceCriteria: [],
				workspaceScope: { cwd: base },
				childSessionId: "parent_session",
				constraints: ["No force push", "Keep the diff small"],
			}),
			now: 1,
		}),
	);
	return missions;
}

function proposalInput(overrides: Partial<OrchestrationProposalInput> = {}): OrchestrationProposalInput {
	return {
		parentMissionId: "mission_parent",
		objective: "Ship the bounded fix",
		constraints: ["No force push", "Keep the diff small"],
		maxTotalLogicalAgents: 20,
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

interface QwenCapture {
	model?: Model<any>;
	prompt?: string;
	calls: number;
}

function mockStreamFn(finalText: string, capture: QwenCapture): StreamFn {
	return (model, context) => {
		capture.calls += 1;
		capture.model = model as Model<any>;
		capture.prompt = textOfUserPrompt(context as Context);
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

function registeredModelRegistry(agentDir: string): ModelRegistry {
	const registry = new ModelRegistry(AuthStorage.inMemory(), path.join(agentDir, "models.json"));
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

describe("automatic orchestration planning (service)", () => {
	let base: string;

	beforeEach(() => {
		base = mkdtempSync(path.join(tmpdir(), "jensen-orch-auto-"));
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("createFromPlanner accepts roster agents through the planner's allowedAgents hook", async () => {
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_roster",
		});
		const capture: MockPlannerCapture = { calls: 0, inputs: [] };
		const plan = await orchestrator.createFromPlanner(
			proposalInput(),
			mockPlanner(capture, () => fanoutProposal(), ROSTER_AGENTS),
		);
		expect(capture.calls).toBe(1);
		expect(plan.decision).toBe("FANOUT");
		expect(plan.nodes.map((node) => node.agent)).toEqual(["investigator", "tester"]);
	});

	it("keeps the canonical registry primary when no operator set is supplied", async () => {
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_canonical",
		});
		const proposal = fanoutProposal() as OrchestrationPlanProposal;
		await expect(orchestrator.create({ parentMissionId: "mission_parent", proposal })).rejects.toThrow(
			/Unknown agent investigator/,
		);
	});

	it("service-level operatorAgents option unlocks roster validation for createFromPlanner", async () => {
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_op",
			operatorAgents: ["investigator", "tester"],
		});
		const planner: OrchestrationPlanner = { propose: async () => fanoutProposal() };
		const plan = await orchestrator.createFromPlanner(proposalInput(), planner);
		expect(plan.nodes.map((node) => node.agent)).toEqual(["investigator", "tester"]);
	});

	it("exports and constructs the parent execution factory without launching or writing state", async () => {
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const orchestrator = new OrchestratorService({ store, missions });
		const port = {
			authority: "authority",
			executeChild: async () => ({ accepted: true, authority: "authority" }),
		};
		const execution = createParentOrchestrationExecution({ missions, store, orchestrator, port });
		expect(execution.port).toBe(port);
		expect(execution.coordinator.executor).toBe(execution.executor);
		const parent = await missions.load("mission_parent");
		if (parent.status !== "ok") throw new Error(`expected parent mission to load, got ${parent.status}`);
		expect(parent.record.state).toBe("CREATED");
	});

	it("startAutomatic persists the named durable parent execution contract before materialization", async () => {
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_auto_contract",
			planner: mockPlanner({ calls: 0, inputs: [] }, () => fanoutProposal(), ROSTER_AGENTS),
		});
		const result = await orchestrator.startAutomatic("mission_parent", {
			childExecutionAuthority: "authority",
		});
		const parent = await missions.load("mission_parent");
		if (parent.status !== "ok") throw new Error(`expected parent mission to load, got ${parent.status}`);
		expect(parent.record.request.orchestrationExecution).toEqual({
			orchestrationId: result.plan.orchestrationId,
			childExecutionAuthority: "authority",
		});
	});

	it("startAutomaticAndExecute reuses the existing parent orchestration contract", async () => {
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const capture: MockPlannerCapture = { calls: 0, inputs: [] };
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_retry",
			planner: mockPlanner(capture, () => fanoutProposal(), ROSTER_AGENTS),
		});
		const port = {
			authority: "authority",
			executeChild: async () => ({ accepted: true, authority: "authority" }),
			childStatus: async () => ({
				orchestrationId: "orch_retry",
				nodeId: "recon",
				childMissionId: "mission_orch_orch_retry_recon",
				childSessionId: "child_orch_orch_retry_recon",
				missionState: "SUCCEEDED" as const,
				terminal: true,
				success: true,
				verificationStatus: "verified" as const,
				completionDecision: "accepted" as const,
				workers: [],
			}),
		};
		const execution = createParentOrchestrationExecution({ missions, store, orchestrator, port });
		await orchestrator.startAutomatic("mission_parent", { childExecutionAuthority: "authority" });
		const retried = await orchestrator.startAutomaticAndExecute("mission_parent", { execution });
		expect(capture.calls).toBe(1);
		expect(retried.state).toBe("SUCCEEDED");
		expect(await store.list()).toEqual(["orch_retry"]);
	});

	it("startAutomatic loads the parent contract, proposes, creates, and materializes ready nodes", async () => {
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const capture: MockPlannerCapture = { calls: 0, inputs: [] };
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_auto_start",
			planner: mockPlanner(capture, () => fanoutProposal(), ROSTER_AGENTS),
		});
		const result = await orchestrator.startAutomatic("mission_parent");
		// The returned plan is the persisted post-materialization document.
		expect(result.plan.nodes.find((node) => node.nodeId === "recon")?.status).toBe("MATERIALIZED");
		// The parent mission's durable work contract drives the planner input.
		expect(capture.calls).toBe(1);
		expect(capture.inputs[0]).toEqual({
			parentMissionId: "mission_parent",
			objective: "Ship the bounded fix",
			constraints: ["No force push", "Keep the diff small"],
			maxTotalLogicalAgents: 20,
		});
		expect(result.plan.orchestrationId).toBe("orch_auto_start");
		expect(result.plan.decision).toBe("FANOUT");
		// The ready node is materialized; the dependent node stays blocked.
		expect(result.materializedMissionIds).toHaveLength(1);
		expect(result.status.childrenMaterialized).toBe(1);
		expect(result.status.childrenBlocked).toBe(1);
		expect(result.status.state).toBe("ACTIVE");
		const children = await missions.listChildren("mission_parent");
		expect(children).toHaveLength(1);
		const child = await missions.load(children[0]);
		if (child.status !== "ok") throw new Error(`expected child mission to load, got ${child.status}`);
		// Materialized as a durable child mission, never launched by the orchestrator.
		expect(child.record.state).toBe("CREATED");
	});

	it("startAutomatic uses the configured child port for automatic execution when no explicit port is supplied", async () => {
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const requests: string[] = [];
		const port: OrchestrationChildExecutionPort = {
			authority: "authority",
			async executeChild(request) {
				requests.push(request.nodeId);
				return { accepted: true, authority: "authority" };
			},
			async childStatus(request) {
				return {
					orchestrationId: "orch_auto_port",
					nodeId: request.nodeId,
					childMissionId: "mission_orch_orch_auto_port_recon",
					childSessionId: "child_orch_orch_auto_port_recon",
					missionState: "SUCCEEDED" as const,
					terminal: true,
					success: true,
					verificationStatus: "verified" as const,
					completionDecision: "accepted" as const,
					workers: [],
				};
			},
		};
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			childExecutionPort: port,
			orchestrationIdFactory: () => "orch_auto_port",
			planner: mockPlanner({ calls: 0, inputs: [] }, () => fanoutProposal(), ROSTER_AGENTS),
		});
		const result = await orchestrator.startAutomaticAndExecute("mission_parent", {
			executionOptions: {},
			childExecutionAuthority: "authority",
		});
		expect(result.state).toBe("SUCCEEDED");
		expect(requests).toEqual(["recon", "recon"]);
	});

	it("startAutomatic drives the QwenPlannerAdapter through a deterministic stream seam", async () => {
		const agentDir = path.join(base, "agent");
		mkdirSync(agentDir, { recursive: true });
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const capture: QwenCapture = { calls: 0 };
		const planner = createQwenPlanner({
			cwd: base,
			agentDir,
			modelRegistry: registeredModelRegistry(agentDir),
			streamFn: mockStreamFn(JSON.stringify(fanoutProposal()), capture),
			allowedAgents: ROSTER_AGENTS,
		});
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_qwen",
			planner,
		});
		const result = await orchestrator.startAutomatic("mission_parent");
		expect(capture.calls).toBe(1);
		expect(capture.model?.provider).toBe("llamacpp-qwen38-bucephalus");
		expect(capture.model?.id).toBe("qwen3.8-27b");
		expect(capture.prompt).toContain("Ship the bounded fix");
		expect(capture.prompt).toContain("- No force push");
		expect(capture.prompt).toContain("- Keep the diff small");
		expect(capture.prompt).toContain("investigator, tester, synthesizer");
		expect(result.plan.orchestrationId).toBe("orch_qwen");
		expect(result.plan.decision).toBe("FANOUT");
		expect(result.materializedMissionIds).toHaveLength(1);
	});

	it("previewAutomatic probes the planner once and persists nothing", async () => {
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const capture: MockPlannerCapture = { calls: 0, inputs: [] };
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_auto_preview",
			planner: mockPlanner(capture, () => fanoutProposal(), ROSTER_AGENTS),
		});
		const preview = await orchestrator.previewAutomatic("mission_parent");
		expect(capture.calls).toBe(1);
		expect(preview.validation.valid).toBe(true);
		expect(preview.plan?.decision).toBe("FANOUT");
		expect(preview.plan?.nodes.map((node) => node.agent)).toEqual(["investigator", "tester"]);
		expect(await store.list()).toHaveLength(0);
		expect(await missions.listChildren("mission_parent")).toHaveLength(0);
	});

	it("previewAutomatic reports invalid proposals without persisting", async () => {
		const missions = await parentFixture(base);
		const store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		const planner: OrchestrationPlanner = { propose: async () => "I cannot produce a JSON plan." };
		const orchestrator = new OrchestratorService({
			store,
			missions,
			sessionDir: path.join(base, "sessions"),
			orchestrationIdFactory: () => "orch_auto_bad",
			planner,
		});
		const preview = await orchestrator.previewAutomatic("mission_parent");
		expect(preview.validation.valid).toBe(false);
		expect(preview.plan).toBeUndefined();
		expect(preview.validation.issues[0]?.code).toBe("ORCHESTRATION_PLAN_INVALID");
		expect(await store.list()).toHaveLength(0);
		expect(await missions.listChildren("mission_parent")).toHaveLength(0);
	});
});

describe("automatic orchestration planning (CLI)", () => {
	let root: string;
	let captured: string[];
	let savedEnv: Record<string, string | undefined>;
	const ENV_KEYS = [
		"JENSEN_DURABLE_MISSION_STORE",
		"JENSEN_ORCHESTRATION_DIR",
		"JENSEN_CODING_AGENT_DIR",
		"JENSEN_EXECUTOR_REGISTRY_DIR",
		"JENSEN_ASSIGNMENT_REGISTRY_DIR",
		"JENSEN_SCHEDULER_REGISTRY_DIR",
	];

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "jensen-orch-auto-cli-"));
		savedEnv = {};
		const env: Record<string, string> = {
			JENSEN_DURABLE_MISSION_STORE: path.join(root, "missions"),
			JENSEN_ORCHESTRATION_DIR: path.join(root, "orchestrations"),
			JENSEN_CODING_AGENT_DIR: path.join(root, "agent"),
			JENSEN_EXECUTOR_REGISTRY_DIR: path.join(root, "executors"),
			JENSEN_ASSIGNMENT_REGISTRY_DIR: path.join(root, "assignments"),
			JENSEN_SCHEDULER_REGISTRY_DIR: path.join(root, "scheduler"),
		};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			process.env[key] = env[key];
		}
		captured = [];
		process.exitCode = 0;
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			captured.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		process.exitCode = 0;
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	function text(): string {
		return captured.join("");
	}

	async function seedParentMission(): Promise<void> {
		const missions = createFileDurableMissionStore();
		await missions.create(
			createDurableMissionRecord({
				request: createMissionRequest({
					missionId: "mission_parent",
					objective: "Ship the bounded fix",
					agent: "worker",
					executionMode: "execute",
					acceptanceCriteria: [],
					workspaceScope: { cwd: root },
					childSessionId: "parent_session",
					constraints: ["No force push", "Keep the diff small"],
				}),
				now: 1,
			}),
		);
	}

	it("orchestrator start without --proposal uses the automatic planner path", async () => {
		await seedParentMission();
		const capture: MockPlannerCapture = { calls: 0, inputs: [] };
		const ok = await handleOrchestratorCommand(["orchestrator", "start", "mission_parent"], {
			planner: mockPlanner(capture, () => fanoutProposal(), ROSTER_AGENTS),
		});
		expect(ok).toBe(true);
		expect(process.exitCode).toBe(0);
		expect(text()).toMatch(/^started orch_[^\s]+ materialized=1\n$/u);
		expect(capture.calls).toBe(1);
		expect(capture.inputs[0].objective).toBe("Ship the bounded fix");
		expect(capture.inputs[0].constraints).toEqual(["No force push", "Keep the diff small"]);
	});

	it("orchestrator preview without --proposal probes the planner and persists nothing", async () => {
		await seedParentMission();
		const capture: MockPlannerCapture = { calls: 0, inputs: [] };
		const ok = await handleOrchestratorCommand(["orchestrator", "preview", "mission_parent"], {
			planner: mockPlanner(capture, () => fanoutProposal(), ROSTER_AGENTS),
		});
		expect(ok).toBe(true);
		expect(process.exitCode).toBe(0);
		expect(text()).toBe("valid FANOUT\n");
		expect(capture.calls).toBe(1);
		const orchestrationFiles = existsSync(path.join(root, "orchestrations"))
			? readdirSync(path.join(root, "orchestrations")).filter((entry) => entry.endsWith(".orchestration.json"))
			: [];
		expect(orchestrationFiles).toHaveLength(0);
	});

	it("orchestrator start --json returns the created plan and materialization", async () => {
		await seedParentMission();
		const capture: MockPlannerCapture = { calls: 0, inputs: [] };
		const ok = await handleOrchestratorCommand(["orchestrator", "start", "mission_parent", "--json"], {
			planner: mockPlanner(capture, () => fanoutProposal(), ROSTER_AGENTS),
		});
		expect(ok).toBe(true);
		expect(process.exitCode).toBe(0);
		const result = JSON.parse(text()) as AutomaticStartResult;
		expect(result.plan.decision).toBe("FANOUT");
		expect(result.status.state).toBe("ACTIVE");
		expect(result.status.childrenMaterialized).toBe(1);
		expect(result.materializedMissionIds).toHaveLength(1);
	});

	it("keeps --proposal as the explicit debug override and bypasses the planner", async () => {
		await seedParentMission();
		const capture: MockPlannerCapture = { calls: 0, inputs: [] };
		const direct = { decision: "DIRECT", rationale: "trivial parent work", nodes: [], edges: [] };
		const ok = await handleOrchestratorCommand(
			["orchestrator", "start", "mission_parent", "--proposal", JSON.stringify(direct)],
			{ planner: mockPlanner(capture, () => fanoutProposal(), ROSTER_AGENTS) },
		);
		expect(ok).toBe(true);
		expect(process.exitCode).toBe(0);
		expect(capture.calls).toBe(0);
		expect(text()).toMatch(/materialized=0/);
	});
});
