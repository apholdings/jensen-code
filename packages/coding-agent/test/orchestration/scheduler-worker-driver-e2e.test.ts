/**
 * Real file-backed Scheduler -> Assignment -> Worker orchestration proof.
 *
 * The control services and durable stores are real. The in-process mission
 * executor uses the normal AgentSession path with a deterministic local stream
 * and filesystem verifier, so completion is never written directly to a
 * mission record and no MissionExecutor mock bypasses the worker boundary.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@apholdings/jensen-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@apholdings/jensen-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AssignmentControlService, FileAssignmentStore } from "../../src/core/assignment/index.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { buildChildResumePrompt } from "../../src/core/durable-child-session/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../src/core/executor-registry/index.js";
import {
	createDurableMissionRecord,
	createInProcessMissionExecutor,
	createMissionRequest,
} from "../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import {
	createFileOrchestrationStore,
	createParentOrchestrationExecution,
	OrchestratorService,
} from "../../src/core/orchestration/index.js";
import type { OrchestrationPlanProposal } from "../../src/core/orchestration/types.js";
import { FileSchedulerStore, SchedulerControlService } from "../../src/core/scheduler/index.js";
import { WorkerControlService } from "../../src/core/worker-daemon/index.js";

const LOCAL_MODEL: Model<"openai-completions"> = {
	id: "gpt-5.6-luna",
	name: "GPT-5.6 Luna (local deterministic seam)",
	provider: "openrouter",
	api: "openai-completions",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 196_608,
	maxTokens: 8_192,
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"], stopReason: "toolUse" | "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: LOCAL_MODEL.api,
		provider: LOCAL_MODEL.provider,
		model: LOCAL_MODEL.id,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function deterministicWriteStream(): StreamFn {
	let calls = 0;
	return () => {
		const stream = createAssistantMessageEventStream();
		calls++;
		const message =
			calls === 1
				? assistantMessage(
						[
							{
								type: "toolCall",
								id: "write-result",
								name: "write",
								arguments: { path: "result.txt", content: "expected content\n" },
							},
						],
						"toolUse",
					)
				: assistantMessage([{ type: "text", text: "Created result.txt" }], "stop");
		queueMicrotask(() => {
			stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			stream.end();
		});
		return stream;
	};
}

function proposal(): OrchestrationPlanProposal {
	return {
		decision: "FANOUT",
		rationale: "one bounded implementation child",
		nodes: [
			{
				nodeId: "write-result",
				role: "implementation",
				nodeKind: "CHILD",
				objective: "Write result.txt with the expected content",
				agent: "worker",
				executionMode: "execute",
				requirement: "REQUIRED",
				workspaceAccess: "WRITE",
				status: "PROPOSED",
				acceptanceCriteria: [{ id: "file-created", description: "result.txt exists with the expected content" }],
				dependencyCriticality: 0,
			},
		],
		edges: [],
	};
}

type LifecycleScenario =
	| "required-failure"
	| "verification-gate-rejection"
	| "optional-failure"
	| "cancellation"
	| "cancellation-two-children";

function userPrompt(context: Context): string {
	return context.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((block) => (block.type === "text" ? block.text : "")).join(" "),
		)
		.join(" ");
}

function errorAssistant(message: string, stopReason: "error" | "aborted"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: LOCAL_MODEL.api,
		provider: LOCAL_MODEL.provider,
		model: LOCAL_MODEL.id,
		usage,
		stopReason,
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function scenarioStream(onCancellationReady?: () => void): StreamFn {
	return (_model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const prompt = userPrompt(context);
		const toolResultSeen = context.messages.some((message) => message.role === "toolResult");
		const emitError = (message: string, reason: "error" | "aborted" = "error") => {
			queueMicrotask(() => {
				stream.push({ type: "error", reason, error: errorAssistant(message, reason) });
				stream.end();
			});
		};

		if (prompt.includes("Wait for cancellation") || prompt.includes("Wait for required failure cleanup")) {
			onCancellationReady?.();
			const abort = () => emitError("cancelled by parent", "aborted");
			if (options?.signal?.aborted) abort();
			else options?.signal?.addEventListener("abort", abort, { once: true });
			return stream;
		}
		if (prompt.includes("Fail required child") || prompt.includes("Fail optional child")) {
			emitError("deterministic child failure");
			return stream;
		}
		if (prompt.includes("verification-gated")) {
			if (toolResultSeen) {
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "Wrote the verification-gated fixture" }], "stop"),
					});
					stream.end();
				});
			} else {
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: "write-verification-gated",
									name: "write",
									arguments: { path: "verification-gated.txt", content: "present\n" },
								},
							],
							"toolUse",
						),
					});
					stream.end();
				});
			}
			return stream;
		}
		if (toolResultSeen) {
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "Created the required fixture" }], "stop"),
				});
				stream.end();
			});
		} else {
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[
							{
								type: "toolCall",
								id: "write-required",
								name: "write",
								arguments: { path: "required-success.txt", content: "expected content\n" },
							},
						],
						"toolUse",
					),
				});
				stream.end();
			});
		}
		return stream;
	};
}

function scenarioNode(
	nodeId: string,
	overrides: Partial<OrchestrationPlanProposal["nodes"][number]> = {},
): OrchestrationPlanProposal["nodes"][number] {
	return {
		nodeId,
		role: "worker",
		nodeKind: "CHILD",
		objective: "Create the required fixture",
		agent: "worker",
		executionMode: "execute",
		requirement: "REQUIRED",
		workspaceAccess: "WRITE",
		status: "PROPOSED",
		acceptanceCriteria: [{ id: "fixture", description: "The deterministic fixture is present" }],
		dependencyCriticality: 0,
		...overrides,
	};
}

function scenarioProposal(scenario: LifecycleScenario): OrchestrationPlanProposal {
	if (scenario === "required-failure")
		return {
			decision: "FANOUT",
			rationale: "required child failure",
			nodes: [scenarioNode("required-failure", { objective: "Fail required child deterministically" })],
			edges: [],
		};
	if (scenario === "verification-gate-rejection")
		return {
			decision: "FANOUT",
			rationale: "verification gate must reject unproven work",
			nodes: [
				scenarioNode("verification-gated", {
					nodeKind: "VERIFICATION",
					objective: "Create the verification-gated fixture",
					requirement: "VERIFICATION_GATING",
				}),
			],
			edges: [],
		};
	if (scenario === "optional-failure")
		return {
			decision: "FANOUT",
			rationale: "required success plus optional failure",
			nodes: [
				scenarioNode("required-success", { objective: "Create the required fixture" }),
				scenarioNode("optional-failure", {
					role: "optional-review",
					objective: "Fail optional child deterministically",
					requirement: "OPTIONAL",
				}),
			],
			edges: [],
		};
	if (scenario === "cancellation-two-children")
		return {
			decision: "FANOUT",
			rationale: "parent cancellation with active and waiting children",
			nodes: [
				scenarioNode("active-cancellation", { objective: "Wait for cancellation" }),
				scenarioNode("waiting-cancellation", {
					objective: "Wait for cancellation in the waiting child",
					independenceReason: "independent_review",
				}),
			],
			edges: [],
		};
	return {
		decision: "FANOUT",
		rationale: "parent cancellation",
		nodes: [scenarioNode("cancellation", { objective: "Wait for cancellation" })],
		edges: [],
	};
}

async function scenarioHarness(scenario: LifecycleScenario, onCancellationReady?: () => void) {
	const root = mkdtempSync(join(tmpdir(), `jensen-orchestration-${scenario}-e2e-`));
	const workspace = join(root, "workspace");
	const sessionDir = join(root, "sessions");
	const agentDir = join(root, "agent");
	mkdirSync(workspace, { recursive: true });
	const missions = new FileDurableMissionStore({ root: join(root, "missions") });
	const assignmentStore = new FileAssignmentStore({ root: join(root, "assignments") });
	const executorStore = new FileExecutorRegistry({ root: join(root, "executors") });
	const schedulerStore = new FileSchedulerStore({ root: join(root, "scheduler") });
	const orchestrationStore = createFileOrchestrationStore(join(root, "orchestrations"));
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
	modelRegistry.registerProvider(LOCAL_MODEL.provider, {
		api: LOCAL_MODEL.api,
		apiKey: "deterministic-key",
		baseUrl: LOCAL_MODEL.baseUrl,
		models: [LOCAL_MODEL],
	});
	await missions.create(
		createDurableMissionRecord({
			request: createMissionRequest({
				missionId: "mission_parent",
				objective: "Drive the bounded lifecycle acceptance test",
				agent: "worker",
				executionMode: "execute",
				acceptanceCriteria: [],
				workspaceScope: { cwd: workspace },
				modelPolicy: { provider: LOCAL_MODEL.provider, model: LOCAL_MODEL.id },
				childSessionId: "parent-session",
			}),
			now: 1,
		}),
	);
	const executors = new ExecutorControlService({ store: executorStore, assignmentStore });
	const assignments = new AssignmentControlService({ store: assignmentStore, missions, executors, sessionDir });
	const scheduler = new SchedulerControlService({
		store: schedulerStore,
		missions,
		executors,
		assignments,
		tickIdFactory: () => "tick-e2e",
	});
	const worker = new WorkerControlService({
		executorId: "in-process-worker",
		executors,
		assignments,
		missions,
		buildResumeLaunch: () => ({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd: workspace }),
		buildExecutor: ({ record, sessionManager, childSessionId }) => ({
			childSessionId,
			resumePrompt: buildChildResumePrompt(record, sessionManager),
			executor: createInProcessMissionExecutor({
				executorId: "in-process-worker",
				cwd: workspace,
				agentDir,
				authStorage,
				modelRegistry,
				sessionDir,
				streamFn: scenarioStream(onCancellationReady),
				verifier: async ({ request }) => {
					if (request.objective.includes("verification-gated"))
						return {
							verified: false,
							summary: "verification evidence rejected",
							criterionIds: ["fixture"],
						};
					const file = "required-success.txt";
					return {
						verified:
							existsSync(join(request.workspaceScope?.cwd ?? workspace, file)) &&
							readFileSync(join(request.workspaceScope?.cwd ?? workspace, file), "utf8") ===
								"expected content\n",
						summary: "required fixture has expected content",
						criterionIds: ["fixture"],
					};
				},
			}),
		}),
		pollMs: 3_600_000,
		heartbeatMs: 3_600_000,
	});
	const orchestrator = new OrchestratorService({
		store: orchestrationStore,
		missions,
		sessionDir,
		orchestrationIdFactory: () => `orch-${scenario}`,
		planner: { propose: async () => scenarioProposal(scenario) },
	});
	const execution = createParentOrchestrationExecution({
		missions,
		store: orchestrationStore,
		orchestrator,
		scheduler,
		worker,
		workers: [worker],
		driver: { maxTicks: 10_000 },
		assignments,
		pollMs: 1,
		maxWallTimeMs: 5_000,
	});
	return { root, workspace, missions, assignments, scheduler, orchestrationStore, worker, orchestrator, execution };
}

describe("bounded Scheduler -> Worker orchestration driver", () => {
	let root: string;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("rejects a required child failure through the real worker lifecycle", async () => {
		const harness = await scenarioHarness("required-failure");
		root = harness.root;
		const terminal = await harness.orchestrator.startAutomaticAndExecute("mission_parent", {
			execution: harness.execution,
			childExecutionAuthority: "scheduler-worker",
		});
		expect(terminal.state).toBe("FAILED");
		expect(terminal.result?.completionDecision).toBe("unavailable");
		const children = await harness.missions.listChildren("mission_parent");
		expect(children).toHaveLength(1);
		const child = await harness.missions.load(children[0]!);
		expect(child.status).toBe("ok");
		if (child.status === "ok") {
			expect(child.record.state).toBe("FAILED");
			expect(child.record.result?.verification.status).toBe("unverified");
			expect(child.record.lease).toBeUndefined();
		}
		expect((await harness.assignments.listAssignments()).entries).toMatchObject([
			{ state: "COMPLETED", terminalMissionState: "FAILED", current: false },
		]);
		expect(harness.worker.daemonState).toBe("STOPPED");
	});

	it("rejects verification-gating failure instead of promoting clean execution", async () => {
		const harness = await scenarioHarness("verification-gate-rejection");
		root = harness.root;
		const terminal = await harness.orchestrator.startAutomaticAndExecute("mission_parent", {
			execution: harness.execution,
			childExecutionAuthority: "scheduler-worker",
		});
		expect(terminal.state).toBe("FAILED");
		const children = await harness.missions.listChildren("mission_parent");
		expect(children).toHaveLength(1);
		const child = await harness.missions.load(children[0]!);
		expect(child.status).toBe("ok");
		if (child.status === "ok") {
			expect(child.record.state).toBe("FAILED");
			expect(child.record.result?.verification.status).toBe("failed");
			expect(child.record.result?.completionDecision).toBe("rejected");
			expect(child.record.result?.failures[0]?.category).toBe("VERIFICATION");
		}
	});

	it("returns PARTIAL when an optional child fails after required success", async () => {
		const harness = await scenarioHarness("optional-failure");
		root = harness.root;
		const terminal = await harness.orchestrator.startAutomaticAndExecute("mission_parent", {
			execution: harness.execution,
			childExecutionAuthority: "scheduler-worker",
		});
		expect(terminal.state).toBe("PARTIAL");
		expect(terminal.result?.executionOutcome).toBe("COMPLETED");
		expect(terminal.result?.completionDecision).toBe("rejected");
		const children = await harness.missions.listChildren("mission_parent");
		expect(children).toHaveLength(2);
		const records = await Promise.all(children.map((childId) => harness.missions.load(childId)));
		expect(records.every((loaded) => loaded.status === "ok")).toBe(true);
		const states = records.flatMap((loaded) => (loaded.status === "ok" ? [loaded.record.state] : []));
		expect(states).toEqual(expect.arrayContaining(["SUCCEEDED", "FAILED"]));
		expect(readFileSync(join(harness.workspace, "required-success.txt"), "utf8")).toBe("expected content\n");
		expect((await harness.assignments.listAssignments()).entries).toHaveLength(2);
		expect((await harness.assignments.listAssignments()).entries.every((entry) => entry.state === "COMPLETED")).toBe(
			true,
		);
	});

	it("cancels the parent and child through the real worker path and cleans up ownership", async () => {
		const controller = new AbortController();
		let cancellationReady = false;
		const harness = await scenarioHarness("cancellation", () => {
			if (!cancellationReady) {
				cancellationReady = true;
				controller.abort("acceptance cancellation");
			}
		});
		root = harness.root;
		const terminal = await harness.orchestrator.startAutomaticAndExecute("mission_parent", {
			execution: harness.execution,
			childExecutionAuthority: "scheduler-worker",
			resumeOptions: { signal: controller.signal },
		});
		expect(cancellationReady).toBe(true);
		expect(terminal.state).toBe("CANCELLED");
		expect(terminal.result?.executionOutcome).toBe("CANCELLED");
		const childIds = await harness.missions.listChildren("mission_parent");
		expect(childIds).toHaveLength(1);
		const child = await harness.missions.load(childIds[0]!);
		expect(child.status).toBe("ok");
		if (child.status === "ok") {
			expect(child.record.state).toBe("CANCELLED");
			expect(child.record.lease).toBeUndefined();
			expect(child.record.currentAttemptId).toBeUndefined();
		}
		expect((await harness.assignments.listAssignments()).entries).toMatchObject([
			{ state: "COMPLETED", terminalMissionState: "CANCELLED", current: false },
		]);
		expect(harness.worker.daemonState).toBe("STOPPED");
		expect((await harness.worker.status()).liveness).not.toBe("ONLINE");
	});

	it("cancels active and waiting children without residual executable ownership", async () => {
		const controller = new AbortController();
		let cancellationReady = false;
		let observedActiveChild = false;
		let harness: Awaited<ReturnType<typeof scenarioHarness>>;
		harness = await scenarioHarness("cancellation-two-children", () => {
			if (!cancellationReady) {
				cancellationReady = true;
				void (async () => {
					const assignments = (await harness.assignments.listAssignments()).entries;
					observedActiveChild = assignments.some((entry) => entry.state === "EXECUTING");
					controller.abort("acceptance cancellation");
				})();
			}
		});
		root = harness.root;
		await harness.orchestrator.startAutomatic("mission_parent", { childExecutionAuthority: "scheduler-worker" });
		const materializedChildIds = await harness.missions.listChildren("mission_parent");
		expect(materializedChildIds).toHaveLength(2);
		const terminal = await harness.orchestrator.startAutomaticAndExecute("mission_parent", {
			execution: harness.execution,
			childExecutionAuthority: "scheduler-worker",
			resumeOptions: { signal: controller.signal },
		});
		expect(terminal.state).toBe("CANCELLED");
		expect(cancellationReady).toBe(true);
		expect(observedActiveChild).toBe(true);
		// The cancellation race may occur before the second child is assigned;
		// terminal cleanup is authoritative for either pending or assigned state.
		const childIds = await harness.missions.listChildren("mission_parent");
		expect(childIds).toHaveLength(2);
		for (const childId of childIds) {
			const child = await harness.missions.load(childId);
			expect(child.status).toBe("ok");
			if (child.status === "ok") expect(child.record.lease).toBeUndefined();
		}
		const assignments = (await harness.assignments.listAssignments()).entries;
		expect(assignments.every((entry) => entry.current === false)).toBe(true);
		expect(
			assignments.every(
				(entry) => entry.state !== "ASSIGNED" && entry.state !== "ACCEPTED" && entry.state !== "EXECUTING",
			),
		).toBe(true);
		expect((await harness.scheduler.listIntents()).entries.every((entry) => entry.state !== "PENDING")).toBe(true);
	});

	it("proves child intent to terminal parent completion with durable cleanup and idempotent resume", async () => {
		root = mkdtempSync(join(tmpdir(), "jensen-orchestration-driver-e2e-"));
		const workspace = join(root, "workspace");
		const sessionDir = join(root, "sessions");
		const agentDir = join(root, "agent");
		const missions = new FileDurableMissionStore({ root: join(root, "missions") });
		const assignmentStore = new FileAssignmentStore({ root: join(root, "assignments") });
		const executorStore = new FileExecutorRegistry({ root: join(root, "executors") });
		const schedulerStore = new FileSchedulerStore({ root: join(root, "scheduler") });
		const orchestrationStore = createFileOrchestrationStore(join(root, "orchestrations"));
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider(LOCAL_MODEL.provider, {
			api: LOCAL_MODEL.api,
			apiKey: "deterministic-key",
			baseUrl: LOCAL_MODEL.baseUrl,
			models: [LOCAL_MODEL],
		});

		await missions.create(
			createDurableMissionRecord({
				request: createMissionRequest({
					missionId: "mission_parent",
					objective: "Create result.txt in the workspace",
					agent: "worker",
					executionMode: "execute",
					acceptanceCriteria: [],
					workspaceScope: { cwd: workspace },
					modelPolicy: { provider: LOCAL_MODEL.provider, model: LOCAL_MODEL.id },
					childSessionId: "parent-session",
				}),
				now: 1,
			}),
		);

		const executors = new ExecutorControlService({ store: executorStore, assignmentStore });
		const assignments = new AssignmentControlService({ store: assignmentStore, missions, executors, sessionDir });
		const scheduler = new SchedulerControlService({
			store: schedulerStore,
			missions,
			executors,
			assignments,
			tickIdFactory: () => "tick-e2e",
		});
		const streamFn = deterministicWriteStream();
		const worker = new WorkerControlService({
			executorId: "in-process-worker",
			executors,
			assignments,
			missions,
			buildResumeLaunch: () => ({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd: workspace }),
			buildExecutor: ({ record, sessionManager, childSessionId }) => ({
				childSessionId,
				resumePrompt: buildChildResumePrompt(record, sessionManager),
				executor: createInProcessMissionExecutor({
					executorId: "in-process-worker",
					cwd: workspace,
					agentDir,
					authStorage,
					modelRegistry,
					sessionDir,
					streamFn,
					verifier: async ({ request }) => ({
						verified:
							existsSync(join(request.workspaceScope?.cwd ?? workspace, "result.txt")) &&
							readFileSync(join(request.workspaceScope?.cwd ?? workspace, "result.txt"), "utf8") ===
								"expected content\n",
						summary: "result.txt has expected content",
						criterionIds: ["file-created"],
					}),
				}),
			}),
			pollMs: 3_600_000,
			heartbeatMs: 3_600_000,
		});
		const orchestrator = new OrchestratorService({
			store: orchestrationStore,
			missions,
			sessionDir,
			orchestrationIdFactory: () => "orch-file-e2e",
			planner: { propose: async () => proposal() },
		});
		const execution = createParentOrchestrationExecution({
			missions,
			store: orchestrationStore,
			orchestrator,
			scheduler,
			worker,
			workers: [worker],
			assignments,
			driver: { maxTicks: 10_000 },
			pollMs: 1,
			maxWallTimeMs: 10_000,
		});

		const terminal = await orchestrator.startAutomaticAndExecute("mission_parent", {
			execution,
			childExecutionAuthority: "scheduler-worker",
		});
		expect(terminal.state).toBe("SUCCEEDED");
		expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("expected content\n");

		const children = await missions.listChildren("mission_parent");
		expect(children).toHaveLength(1);
		const child = await missions.load(children[0]!);
		expect(child.status).toBe("ok");
		if (child.status === "ok") {
			expect(child.record.state).toBe("SUCCEEDED");
			expect(child.record.result?.verification.status).toBe("verified");
			expect(child.record.lease).toBeUndefined();
		}
		const parent = await missions.load("mission_parent");
		expect(parent.status).toBe("ok");
		if (parent.status === "ok") expect(parent.record.lease).toBeUndefined();

		expect((await scheduler.listIntents()).entries[0]?.state).toBe("ASSIGNED");
		expect((await assignments.listAssignments()).entries[0]?.state).toBe("COMPLETED");
		expect(worker.daemonState).toBe("STOPPED");
		expect((await worker.status()).liveness).not.toBe("ONLINE");

		const repeated = await orchestrator.startAutomaticAndExecute("mission_parent", { execution });
		expect(repeated.missionId).toBe(terminal.missionId);
		expect(repeated.state).toBe("SUCCEEDED");
		expect((await assignments.listAssignments()).entries).toHaveLength(1);
		expect((await scheduler.listIntents()).entries).toHaveLength(1);

		const reconciles = await Promise.all(Array.from({ length: 4 }, () => orchestrator.reconcile("orch-file-e2e")));
		expect(reconciles.every((result) => result.materializedMissionIds.length === 0)).toBe(true);
		expect(await missions.listChildren("mission_parent")).toHaveLength(1);
	});
});
