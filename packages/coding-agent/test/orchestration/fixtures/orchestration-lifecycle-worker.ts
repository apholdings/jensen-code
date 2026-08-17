import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@apholdings/jensen-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@apholdings/jensen-ai";
import { AssignmentControlService, FileAssignmentStore } from "../../../src/core/assignment/index.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { buildChildResumePrompt } from "../../../src/core/durable-child-session/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../../src/core/executor-registry/index.js";
import {
	createDurableMissionRecord,
	createInProcessMissionExecutor,
	createMissionRequest,
} from "../../../src/core/mission-domain/index.js";
import { FileDurableMissionStore } from "../../../src/core/mission-durable/index.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import {
	createFileOrchestrationStore,
	OrchestratorService,
	SchedulerWorkerChildExecutionPort,
} from "../../../src/core/orchestration/index.js";
import type { OrchestrationPlanProposal } from "../../../src/core/orchestration/types.js";
import { FileSchedulerStore, SchedulerControlService } from "../../../src/core/scheduler/index.js";
import { WorkerControlService } from "../../../src/core/worker-daemon/index.js";

const ORCHESTRATION_ID = "orch_acceptance";
const PARENT_MISSION_ID = "mission_parent";
const CHILD_MISSION_ID = "mission_orch_orch_acceptance_write-result";
const CHILD_SESSION_ID = "child_orch_orch_acceptance_write-result";
const EXECUTOR_ID = "acceptance-worker";

const GPT_LUNA_MODEL: Model<"openai-completions"> = {
	id: "gpt-5.6-luna",
	name: "GPT-5.6 Luna deterministic acceptance seam",
	provider: "openrouter",
	api: "openai-completions",
	baseUrl: "https://example.invalid/v1",
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

async function waitFor<T>(condition: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await condition();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timeout waiting for ${label}`);
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: "toolUse" | "stop" | "length",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: GPT_LUNA_MODEL.api,
		provider: GPT_LUNA_MODEL.provider,
		model: GPT_LUNA_MODEL.id,
		usage: ZERO_USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

function deterministicLunaStream(): StreamFn {
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
								arguments: {
									path: "result.txt",
									content: "expected content\n",
								},
							},
						],
						"toolUse",
					)
				: assistantMessage([{ type: "text", text: "Created result.txt" }], "stop");
		queueMicrotask(() => {
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else {
				stream.push({ type: "done", reason: message.stopReason, message });
			}
			stream.end();
		});
		return stream;
	};
}

function proposal(): OrchestrationPlanProposal {
	return {
		decision: "FANOUT",
		rationale: "one deterministic child for lifecycle acceptance",
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
				acceptanceCriteria: [
					{
						id: "file-created",
						description: "result.txt contains the expected content",
					},
				],
				dependencyCriticality: 0,
			},
		],
		edges: [],
	};
}

function paths(root: string) {
	return {
		workspace: join(root, "workspace"),
		missions: join(root, "missions"),
		assignments: join(root, "assignments"),
		executors: join(root, "executors"),
		scheduler: join(root, "scheduler"),
		orchestrations: join(root, "orchestrations"),
		sessions: join(root, "sessions"),
		agent: join(root, "agent"),
	};
}

function buildServices(root: string) {
	const locations = paths(root);
	mkdirSync(locations.workspace, { recursive: true });
	const missions = new FileDurableMissionStore({ root: locations.missions });
	const assignmentStore = new FileAssignmentStore({
		root: locations.assignments,
	});
	const executorStore = new FileExecutorRegistry({ root: locations.executors });
	const schedulerStore = new FileSchedulerStore({ root: locations.scheduler });
	const orchestrationStore = createFileOrchestrationStore(locations.orchestrations);
	const executors = new ExecutorControlService({
		store: executorStore,
		assignmentStore,
		expiryMs: 500,
	});
	const assignments = new AssignmentControlService({
		store: assignmentStore,
		missions,
		executors,
		sessionDir: locations.sessions,
	});
	const scheduler = new SchedulerControlService({
		store: schedulerStore,
		missions,
		executors,
		assignments,
		tickIdFactory: () => "tick_acceptance",
	});
	const childExecutionPort = new SchedulerWorkerChildExecutionPort({
		authority: "scheduler-worker",
		missions,
		store: orchestrationStore,
		scheduler,
		now: () => Date.now(),
	});
	const orchestrator = new OrchestratorService({
		store: orchestrationStore,
		missions,
		childExecutionPort,
		sessionDir: locations.sessions,
		orchestrationIdFactory: () => ORCHESTRATION_ID,
		planner: { propose: async () => proposal() },
	});
	return {
		locations,
		missions,
		assignments,
		scheduler,
		orchestrationStore,
		executors,
		assignmentStore,
		orchestrator,
	};
}

async function ensureParent(root: string): Promise<void> {
	const { locations, missions } = buildServices(root);
	if ((await missions.load(PARENT_MISSION_ID)).status !== "missing") return;
	await missions.create(
		createDurableMissionRecord({
			request: createMissionRequest({
				missionId: PARENT_MISSION_ID,
				objective: "Drive the orchestration lifecycle acceptance",
				agent: "worker",
				executionMode: "execute",
				acceptanceCriteria: [],
				workspaceScope: { cwd: locations.workspace },
				modelPolicy: {
					provider: GPT_LUNA_MODEL.provider,
					model: GPT_LUNA_MODEL.id,
				},
				childSessionId: "parent-session",
			}),
			now: 1,
		}),
	);
}

function buildWorker(root: string, services: ReturnType<typeof buildServices>, hanging: boolean): WorkerControlService {
	const locations = paths(root);
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = new ModelRegistry(authStorage, join(locations.agent, "models.json"));
	modelRegistry.registerProvider(GPT_LUNA_MODEL.provider, {
		api: GPT_LUNA_MODEL.api,
		apiKey: "deterministic-gpt-luna-key",
		baseUrl: GPT_LUNA_MODEL.baseUrl,
		models: [GPT_LUNA_MODEL],
	});
	return new WorkerControlService({
		executorId: EXECUTOR_ID,
		executors: services.executors,
		assignments: services.assignments,
		missions: services.missions,
		buildResumeLaunch: () => ({
			command: process.execPath,
			args: ["-e", "process.exit(0)"],
			cwd: locations.workspace,
		}),
		buildExecutor: ({ record, sessionManager, childSessionId }) => ({
			childSessionId,
			resumePrompt: buildChildResumePrompt(record, sessionManager),
			executor: createInProcessMissionExecutor({
				executorId: EXECUTOR_ID,
				cwd: locations.workspace,
				agentDir: locations.agent,
				authStorage,
				modelRegistry,
				sessionDir: locations.sessions,
				streamFn: hanging ? () => createAssistantMessageEventStream() : deterministicLunaStream(),
				executionIdFactory: () => "exec_gpt_luna_acceptance",
				verifier: async ({ request }) => {
					const resultPath = join(request.workspaceScope?.cwd ?? locations.workspace, "result.txt");
					return {
						verified: existsSync(resultPath) && readFileSync(resultPath, "utf8") === "expected content\n",
						summary: "result.txt was created by the deterministic GPT-5.6 Luna seam",
						criterionIds: ["file-created"],
					};
				},
			}),
		}),
		pollMs: 3_600_000,
		heartbeatMs: 3_600_000,
		expiryMs: 500,
	});
}

async function seed(root: string): Promise<void> {
	await ensureParent(root);
	const services = buildServices(root);
	const plan = await services.orchestrator.create({
		parentMissionId: PARENT_MISSION_ID,
		proposal: proposal(),
	});
	await services.orchestrator.attachOrchestrationExecution(
		PARENT_MISSION_ID,
		plan.orchestrationId,
		"scheduler-worker",
	);
	process.stdout.write(
		`${JSON.stringify({
			operation: "seed",
			orchestrationId: plan.orchestrationId,
		})}\n`,
	);
}

async function start(root: string): Promise<void> {
	await ensureParent(root);
	const services = buildServices(root);
	const result = await services.orchestrator.startAutomatic(PARENT_MISSION_ID, {
		childExecutionAuthority: "scheduler-worker",
	});
	process.stdout.write(
		`${JSON.stringify({
			operation: "start",
			orchestrationId: result.plan.orchestrationId,
			childMissionId: CHILD_MISSION_ID,
		})}\n`,
	);
}

async function crash(root: string): Promise<void> {
	await ensureParent(root);
	const services = buildServices(root);
	await services.orchestrator.startAutomatic(PARENT_MISSION_ID, {
		childExecutionAuthority: "scheduler-worker",
	});
	const worker = buildWorker(root, services, true);
	await worker.start({ reconcile: false, polling: false });
	const port = new SchedulerWorkerChildExecutionPort({
		authority: "scheduler-worker",
		missions: services.missions,
		store: services.orchestrationStore,
		scheduler: services.scheduler,
	});
	await port.executeChild({
		orchestrationId: ORCHESTRATION_ID,
		nodeId: "write-result",
		childMissionId: CHILD_MISSION_ID,
		childSessionId: CHILD_SESSION_ID,
		workspaceAccess: "WRITE",
	});
	await services.scheduler.runTick();
	void worker.runOnce();
	await waitFor(
		async () => {
			const assignment = await services.assignments.getCurrentForMission(CHILD_MISSION_ID);
			return assignment?.state === "EXECUTING" ? assignment : undefined;
		},
		30_000,
		"child assignment EXECUTING",
	);
	await waitFor(
		async () => {
			const child = await services.missions.load(CHILD_MISSION_ID);
			return child.status === "ok" &&
				child.record.state === "RUNNING" &&
				child.record.currentExecutionId === "exec_gpt_luna_acceptance"
				? child
				: undefined;
		},
		30_000,
		"durable child mission RUNNING with acceptance execution",
	);
	writeFileSync(join(root, "crash-started"), "execution in flight\n");
	await new Promise(() => undefined);
}

async function recover(root: string): Promise<void> {
	const services = buildServices(root);
	const worker = buildWorker(root, services, false);
	try {
		await worker.start({ reconcile: true, polling: false });
		const child = await services.missions.load(CHILD_MISSION_ID);
		const assignment = await services.assignments.getCurrentForMission(CHILD_MISSION_ID);
		process.stdout.write(
			`${JSON.stringify({
				operation: "recover",
				orchestrationId: ORCHESTRATION_ID,
				childMissionId: CHILD_MISSION_ID,
				childSessionId: child.status === "ok" ? child.record.request.childSessionId : undefined,
				missionState: child.status === "ok" ? child.record.state : child.status,
				assignmentState: assignment?.state,
			})}\n`,
		);
	} finally {
		await worker.stop("recovery inspected");
	}
}

async function coldReconcile(root: string, role: string): Promise<void> {
	const barrier = join(root, `cold-reconcile-${role}-ready`);
	writeFileSync(barrier, "ready\n");
	await waitFor(
		async () => {
			const otherRole = role === "a" ? "b" : "a";
			return existsSync(join(root, `cold-reconcile-${otherRole}-ready`)) ? true : undefined;
		},
		30_000,
		"concurrent cold reconcile barrier",
	);
	const services = buildServices(root);
	const result = await services.orchestrator.reconcile(ORCHESTRATION_ID);
	process.stdout.write(
		`${JSON.stringify({
			operation: "cold-reconcile",
			role,
			materializedMissionIds: result.materializedMissionIds,
		})}\n`,
	);
}

async function execute(root: string): Promise<void> {
	const services = buildServices(root);
	const worker = buildWorker(root, services, false);
	try {
		const port = new SchedulerWorkerChildExecutionPort({
			authority: "scheduler-worker",
			missions: services.missions,
			store: services.orchestrationStore,
			scheduler: services.scheduler,
		});
		await port.executeChild({
			orchestrationId: ORCHESTRATION_ID,
			nodeId: "write-result",
			childMissionId: CHILD_MISSION_ID,
			childSessionId: CHILD_SESSION_ID,
			workspaceAccess: "WRITE",
		});
		await worker.start({ reconcile: false, polling: false });
		await services.scheduler.runTick();
		const outcome = await worker.runOnce();
		const child = await services.missions.load(CHILD_MISSION_ID);
		process.stdout.write(
			`${JSON.stringify({
				operation: "execute",
				childMissionId: CHILD_MISSION_ID,
				executionId: outcome.kind === "executed" ? outcome.executionId : undefined,
				missionState: outcome.kind === "executed" ? outcome.missionState : undefined,
				result: child.status === "ok" ? (child.record.result ?? null) : null,
			})}\n`,
		);
	} finally {
		await worker.stop("acceptance complete");
	}
}

async function main(): Promise<void> {
	const [operation, root, role] = process.argv.slice(2);
	if (!operation || !root) throw new Error("usage: <operation> <root>");
	switch (operation) {
		case "seed":
			await seed(root);
			return;
		case "start":
			await start(root);
			return;
		case "crash":
			await crash(root);
			return;
		case "recover":
			await recover(root);
			return;
		case "cold-reconcile":
			if (!role) throw new Error("cold-reconcile requires a role");
			await coldReconcile(root, role);
			return;
		case "execute":
			await execute(root);
			return;
		default:
			throw new Error(`unknown operation: ${operation}`);
	}
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
});

export { CHILD_MISSION_ID, CHILD_SESSION_ID, ORCHESTRATION_ID, PARENT_MISSION_ID };
