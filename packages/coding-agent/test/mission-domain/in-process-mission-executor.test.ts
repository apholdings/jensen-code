/**
 * InProcessMissionExecutor — the real, in-process MissionExecutor.
 *
 * Deterministic: executor mechanics are tested through the `runner` seam, and
 * the real session path is tested through the normal `createAgentSession()`
 * path with a mocked `streamFn` (no HTTP or provider calls; all state lives in
 * a temp directory).
 *
 * Covers:
 *   - the clean-completion invariant: exit 0 without a verifier is PARTIAL
 *     (unverified), never SUCCEEDED,
 *   - verifier promotion to SUCCEEDED and verifier rejection to FAILED,
 *   - crash (launch error), execution failure, and cancellation (mid-run,
 *     pre-aborted launch signal, idempotent cancel),
 *   - request validation and unknown-handle rejection,
 *   - MissionExecutionService integration,
 *   - the real session path: model policy resolution (verified, never
 *     defaulted), execution-mode tool selection, capability narrowing,
 *     durable child session binding, and inference-error mapping.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@apholdings/jensen-agent-core";
import { type Context, createAssistantMessageEventStream, type Model } from "@apholdings/jensen-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.js";
import {
	buildInProcessMissionPrompt,
	createInProcessMissionExecutor,
	InProcessMissionExecutor,
	type InProcessMissionOutcome,
	type InProcessMissionRunner,
} from "../../src/core/mission-domain/in-process-mission-executor.js";
import { MissionExecutionService, type MissionExecutor } from "../../src/core/mission-domain/mission-executor.js";
import {
	type CreateMissionRequestInput,
	createMissionRequest,
	type MissionRequest,
} from "../../src/core/mission-domain/mission-request.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
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

let root: string;
let cwd: string;
let agentDir: string;
let sessionDir: string;
let originalAgentDirEnv: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jensen-in-process-executor-"));
	cwd = join(root, "repo");
	agentDir = join(root, "agent");
	sessionDir = join(root, "child-sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	originalAgentDirEnv = process.env.JENSEN_CODING_AGENT_DIR;
	process.env.JENSEN_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (originalAgentDirEnv === undefined) delete process.env.JENSEN_CODING_AGENT_DIR;
	else process.env.JENSEN_CODING_AGENT_DIR = originalAgentDirEnv;
	rmSync(root, { recursive: true, force: true });
});

function missionRequest(overrides: Partial<CreateMissionRequestInput> = {}): MissionRequest {
	return createMissionRequest({
		missionId: "mission_child",
		parent: { missionId: "mission_parent", depth: 0 },
		objective: "Ship the bounded fix",
		agent: "worker",
		executionMode: "execute",
		acceptanceCriteria: [{ id: "c1", description: "Tests pass" }],
		constraints: ["No force push"],
		modelPolicy: { provider: LOCAL_MODEL.provider, model: LOCAL_MODEL.id },
		childSessionId: "child_orch_test",
		...overrides,
	});
}

// =============================================================================
// Prompt builder
// =============================================================================

describe("buildInProcessMissionPrompt", () => {
	it("carries identity, objective, constraints, and acceptance criteria", () => {
		const prompt = buildInProcessMissionPrompt(
			missionRequest({ acceptanceCriteria: [{ id: "c1", description: "Tests pass" }] }),
		);
		expect(prompt).toContain("mission mission_child");
		expect(prompt).toContain('agent "worker"');
		expect(prompt).toContain("execution mode: execute");
		expect(prompt).toContain("Parent mission: mission_parent (depth 1).");
		expect(prompt).toContain("Ship the bounded fix");
		expect(prompt).toContain("- No force push");
		expect(prompt).toContain("- [c1] Tests pass");
	});

	it("omits parent and empty sections for a root mission", () => {
		const prompt = buildInProcessMissionPrompt(
			createMissionRequest({
				missionId: "mission_root",
				objective: "Only objective",
				agent: "worker",
				executionMode: "observe",
				acceptanceCriteria: [],
			}),
		);
		expect(prompt).not.toContain("Parent mission");
		expect(prompt).not.toContain("Constraints:");
		expect(prompt).not.toContain("Acceptance criteria:");
		expect(prompt).toContain("Only objective");
	});
});

// =============================================================================
// Executor mechanics (runner seam)
// =============================================================================

function immediateRunner(outcome: InProcessMissionOutcome): InProcessMissionRunner {
	return async () => outcome;
}

function abortAwareRunner(): InProcessMissionRunner {
	return (_request, signal) =>
		new Promise<InProcessMissionOutcome>((resolve) => {
			const settle = () => resolve({ exitCode: null, cancelled: true });
			if (signal?.aborted) {
				settle();
				return;
			}
			signal?.addEventListener("abort", settle, { once: true });
		});
}

function throwingRunner(message: string): InProcessMissionRunner {
	return async () => {
		throw new Error(message);
	};
}

describe("InProcessMissionExecutor (runner seam)", () => {
	it("classifies a clean completion without a verifier as PARTIAL, never SUCCEEDED", async () => {
		const executor = new InProcessMissionExecutor({ runner: immediateRunner({ exitCode: 0, outputText: "done" }) });
		expect(executor.executorId).toBe("in-process");
		const handle = await executor.launch(missionRequest());
		expect(handle.missionId).toBe("mission_child");
		expect(handle.parentMissionId).toBe("mission_parent");
		expect(handle.depth).toBe(1);
		expect(handle.state).toBe("RUNNING");
		expect(handle.executionId).toMatch(/^exec_/);

		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("PARTIAL");
		expect(result.executionOutcome).toBe("COMPLETED");
		expect(result.success).toBe(false);
		expect(result.verification.status).toBe("unverified");
		expect(result.outputText).toBe("done");
		expect(result.executorDiagnostics.executorId).toBe("in-process");
		expect(result.executorDiagnostics.processExitCode).toBe(0);
	});

	it("promotes a clean completion to SUCCEEDED when the verifier verifies", async () => {
		const executor = new InProcessMissionExecutor({
			runner: immediateRunner({ exitCode: 0, outputText: "done" }),
			verifier: async ({ request }) => ({
				verified: true,
				summary: `verified ${request.missionId}`,
				criterionIds: ["c1"],
			}),
		});
		const handle = await executor.launch(missionRequest());
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("SUCCEEDED");
		expect(result.executionOutcome).toBe("COMPLETED");
		expect(result.success).toBe(true);
		expect(result.verification.status).toBe("verified");
		expect(result.verification.criterionIds).toEqual(["c1"]);
		expect(result.completionDecision).toBe("accepted");
	});

	it("fails a clean completion with a VERIFICATION failure when the verifier rejects", async () => {
		const executor = new InProcessMissionExecutor({
			runner: immediateRunner({ exitCode: 0, outputText: "done" }),
			verifier: async () => ({ verified: false, summary: "tests did not pass" }),
		});
		const handle = await executor.launch(missionRequest());
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("FAILED");
		expect(result.executionOutcome).toBe("COMPLETED");
		expect(result.success).toBe(false);
		expect(result.verification.status).toBe("failed");
		expect(result.completionDecision).toBe("rejected");
		expect(result.failures).toEqual([{ category: "VERIFICATION", message: "tests did not pass" }]);
	});

	it("classifies a runner failure as CRASHED with a LAUNCH failure", async () => {
		const executor = new InProcessMissionExecutor({ runner: throwingRunner("session exploded") });
		const handle = await executor.launch(missionRequest());
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("CRASHED");
		expect(result.executionOutcome).toBe("CRASHED");
		expect(result.failures).toEqual([{ category: "LAUNCH", message: "session exploded" }]);
		expect(result.executorDiagnostics.launchError).toBe("session exploded");
	});

	it("classifies a non-zero completion as FAILED with an EXECUTION failure", async () => {
		const executor = new InProcessMissionExecutor({
			runner: immediateRunner({ exitCode: 2, sessionError: "boom" }),
		});
		const handle = await executor.launch(missionRequest());
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("FAILED");
		expect(result.executionOutcome).toBe("FAILED");
		expect(result.failures[0]?.category).toBe("EXECUTION");
		expect(result.executorDiagnostics.processExitCode).toBe(2);
		expect(result.executorDiagnostics.stderr).toBe("boom");
	});

	it("cancels a running mission and reports CANCELLED (idempotent cancel)", async () => {
		const executor = new InProcessMissionExecutor({ runner: abortAwareRunner() });
		const handle = await executor.launch(missionRequest());
		await executor.cancel(handle, "operator");
		await executor.cancel(handle, "operator again"); // idempotent, no throw
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("CANCELLED");
		expect(result.executionOutcome).toBe("CANCELLED");
		expect(result.success).toBe(false);
		expect(result.failures[0]?.category).toBe("CANCELLED");
	});

	it("supports the handle-owned cancel control", async () => {
		const executor = new InProcessMissionExecutor({ runner: abortAwareRunner() });
		const handle = await executor.launch(missionRequest());
		await handle.cancel("operator");
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("CANCELLED");
	});

	it("reports CANCELLED when the launch signal is already aborted", async () => {
		const executor = new InProcessMissionExecutor({ runner: abortAwareRunner() });
		const controller = new AbortController();
		controller.abort();
		const handle = await executor.launch(missionRequest(), { signal: controller.signal });
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("CANCELLED");
	});

	it("rejects an invalid MissionRequest at launch", async () => {
		const executor = new InProcessMissionExecutor({ runner: immediateRunner({ exitCode: 0 }) });
		const invalid = {
			missionId: "",
			depth: 0,
			objective: "",
			agent: "",
			executionMode: "nope",
		} as unknown as MissionRequest;
		await expect(executor.launch(invalid)).rejects.toThrow("Invalid MissionRequest");
	});

	it("rejects awaitResult for an unknown handle", async () => {
		const executor = new InProcessMissionExecutor({ runner: immediateRunner({ exitCode: 0 }) });
		const handle = await executor.launch(missionRequest({ missionId: "mission_known" }));
		await executor.awaitResult(handle);
		await expect(executor.cancel({ ...handle, missionId: "mission_unknown" })).resolves.toBeUndefined();
		const foreign = { ...handle, missionId: "mission_unknown" };
		await expect(executor.awaitResult(foreign)).rejects.toThrow("Unknown mission: mission_unknown");
	});

	it("honors an explicit executorId", async () => {
		const executor = new InProcessMissionExecutor({
			executorId: "in-process-test",
			runner: immediateRunner({ exitCode: 0 }),
		});
		expect(executor.executorId).toBe("in-process-test");
		const handle = await executor.launch(missionRequest());
		const result = await executor.awaitResult(handle);
		expect(result.executorDiagnostics.executorId).toBe("in-process-test");
	});

	it("integrates with MissionExecutionService (register + execute)", async () => {
		const service = new MissionExecutionService();
		const executor = new InProcessMissionExecutor({
			executorId: "in-process",
			runner: immediateRunner({ exitCode: 0, outputText: "done" }),
		});
		const executorRef: MissionExecutor = executor;
		service.register(executorRef);
		const result = await service.execute(missionRequest(), { executorId: "in-process" });
		expect(result.state).toBe("PARTIAL");
		expect(result.success).toBe(false);
	});
});

// =============================================================================
// Real session path (createAgentSession with a mocked stream)
// =============================================================================

interface StreamCapture {
	model?: Model<any>;
	prompt?: string;
	toolNames?: string[];
	calls: number;
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

function realPathOptions(streamFn: StreamFn) {
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
	modelRegistry.registerProvider(LOCAL_MODEL.provider, {
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
	return { cwd, agentDir, authStorage, modelRegistry, sessionDir, streamFn };
}

describe("InProcessMissionExecutor (real session path)", () => {
	it("runs the mission through a real agent session with the mission's model policy", async () => {
		const capture: StreamCapture = { calls: 0 };
		const executor = createInProcessMissionExecutor({
			...realPathOptions(mockStreamFn("Mission complete: fix shipped", capture)),
		});
		const handle = await executor.launch(missionRequest({ executionMode: "observe" }));
		const result = await executor.awaitResult(handle);

		expect(capture.calls).toBe(1);
		expect(capture.model?.provider).toBe(LOCAL_MODEL.provider);
		expect(capture.model?.id).toBe(LOCAL_MODEL.id);
		expect(capture.prompt).toContain("Ship the bounded fix");
		expect(capture.prompt).toContain("- No force push");
		expect(capture.prompt).toContain("- [c1] Tests pass");
		// Observe mode: read-only tools only.
		expect(capture.toolNames).toContain("read");
		expect(capture.toolNames).not.toContain("bash");
		expect(capture.toolNames).not.toContain("edit");
		expect(capture.toolNames).not.toContain("write");

		expect(result.state).toBe("PARTIAL");
		expect(result.success).toBe(false);
		expect(result.verification.status).toBe("unverified");
		expect(result.outputText).toBe("Mission complete: fix shipped");
		expect(result.executorDiagnostics.executorId).toBe("in-process");
	});

	it("narrows execute-mode tools by declared capabilities", async () => {
		const capture: StreamCapture = { calls: 0 };
		const executor = createInProcessMissionExecutor({
			...realPathOptions(mockStreamFn("done", capture)),
		});
		const handle = await executor.launch(
			missionRequest({ executionMode: "execute", capabilities: ["read", "bash"] }),
		);
		await executor.awaitResult(handle);
		// The session layer adds its guaranteed todo runtime tool on top of the
		// executor's capability-narrowed set; the narrowing itself is exact.
		expect(capture.toolNames).toContain("read");
		expect(capture.toolNames).toContain("bash");
		expect(capture.toolNames).not.toContain("edit");
		expect(capture.toolNames).not.toContain("write");
		expect(capture.toolNames).not.toContain("powershell");
		expect(capture.toolNames).not.toContain("memory_write");
	});

	it("binds the durable child session in the session dir", async () => {
		const capture: StreamCapture = { calls: 0 };
		const executor = createInProcessMissionExecutor({
			...realPathOptions(mockStreamFn("done", capture)),
		});
		const handle = await executor.launch(missionRequest());
		await executor.awaitResult(handle);
		expect(readdirSync(sessionDir).length).toBeGreaterThan(0);
	});

	it("uses the worker-resolved durable session manager instead of replacing it", async () => {
		const capture: StreamCapture = { calls: 0 };
		const resolved = SessionManager.createWithId(cwd, sessionDir, "child_orch_test");
		resolved.appendChildBinding({ sessionId: "child_orch_test", missionId: "mission_child" });
		const executor = createInProcessMissionExecutor({
			...realPathOptions(mockStreamFn("done", capture)),
			sessionManager: resolved,
		});
		const handle = await executor.launch(missionRequest());
		await executor.awaitResult(handle);
		expect(resolved.getEntries().some((entry) => entry.type === "message")).toBe(true);
		expect(SessionManager.open(resolved.getSessionFile()!, sessionDir).getLatestChildBinding()?.missionId).toBe(
			"mission_child",
		);
	});

	it("maps a session inference error to FAILED with the session error in diagnostics", async () => {
		const capture: StreamCapture = { calls: 0 };
		const executor = createInProcessMissionExecutor({
			...realPathOptions(errorStreamFn(capture)),
		});
		const handle = await executor.launch(missionRequest());
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("FAILED");
		expect(result.executionOutcome).toBe("FAILED");
		expect(result.success).toBe(false);
		expect(result.executorDiagnostics.stderr).toBe("local backend unavailable");
	});

	it("rejects a mission without a model policy (verified, never defaulted)", async () => {
		const capture: StreamCapture = { calls: 0 };
		const executor = createInProcessMissionExecutor({
			...realPathOptions(mockStreamFn("should never run", capture)),
		});
		const handle = await executor.launch(missionRequest({ modelPolicy: undefined }));
		const result = await executor.awaitResult(handle);
		expect(capture.calls).toBe(0);
		expect(result.state).toBe("CRASHED");
		expect(result.executorDiagnostics.launchError).toContain("MISSION_MODEL_POLICY_REQUIRED");
	});

	it("rejects a model policy that is not registered", async () => {
		const capture: StreamCapture = { calls: 0 };
		const executor = createInProcessMissionExecutor({
			...realPathOptions(mockStreamFn("should never run", capture)),
		});
		const handle = await executor.launch(
			missionRequest({ modelPolicy: { provider: "unregistered", model: "nope" } }),
		);
		const result = await executor.awaitResult(handle);
		expect(capture.calls).toBe(0);
		expect(result.state).toBe("CRASHED");
		expect(result.executorDiagnostics.launchError).toContain("MISSION_MODEL_UNAVAILABLE");
	});
});
