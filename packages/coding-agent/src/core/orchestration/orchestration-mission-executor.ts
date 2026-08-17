/**
 * Durable parent orchestration MissionExecutor.
 *
 * This adapter is deliberately subordinate to the Mission domain: the
 * DurableMissionCoordinator owns the parent lease and terminal commit, while
 * this executor drives the orchestration plan through the existing lifecycle
 * and child-execution authority ports. It never launches a process, opens SSH,
 * calls a provider, or writes parent mission state directly.
 */

import { randomUUID } from "node:crypto";
import type { DurableMissionStore } from "../mission-domain/durable-store.js";
import type { MissionExecutor, MissionLaunchOptions } from "../mission-domain/mission-executor.js";
import { createMissionHandle, type MissionHandle } from "../mission-domain/mission-handle.js";
import type { MissionRequest } from "../mission-domain/mission-request.js";
import { createMissionResult, type MissionResult, type StructuredFailure } from "../mission-domain/mission-result.js";
import type { OrchestrationLifecycleExecutor } from "./lifecycle-executor.js";
import type { OrchestratorService } from "./orchestrator.js";
import { SchedulerWorkerDriverFailure } from "./scheduler-worker-driver.js";
import type { OrchestrationPlan, OrchestrationStore } from "./types.js";

export interface OrchestrationMissionExecutorOptions {
	missions: DurableMissionStore;
	store: OrchestrationStore;
	/** Existing lifecycle authority; no child execution is implemented here. */
	lifecycle: OrchestrationLifecycleExecutor;
	/** Reconciliation service used to unblock/materialize dependent nodes. */
	orchestrator: OrchestratorService;
	executorId?: string;
	pollMs?: number;
	maxWallTimeMs?: number;
	now?: () => number;
	executionIdFactory?: (request: MissionRequest) => string;
}

interface ActiveExecution {
	request: MissionRequest;
	executionId: string;
	startedAtMs: number;
	controller: AbortController;
	launched: boolean;
	cancelled: boolean;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

export class OrchestrationMissionExecutor implements MissionExecutor {
	readonly executorId: string;
	private readonly _store: OrchestrationStore;
	private readonly _lifecycle: OrchestrationLifecycleExecutor;
	private readonly _orchestrator: OrchestratorService;
	private readonly _pollMs: number;
	private readonly _maxWallTimeMs: number;
	private readonly _now: () => number;
	private readonly _executionIdFactory: (request: MissionRequest) => string;
	private readonly _active = new Map<string, ActiveExecution>();

	constructor(options: OrchestrationMissionExecutorOptions) {
		this.executorId = options.executorId ?? "orchestration";
		this._store = options.store;
		this._lifecycle = options.lifecycle;
		this._orchestrator = options.orchestrator;
		this._pollMs = options.pollMs ?? 250;
		this._maxWallTimeMs = options.maxWallTimeMs ?? 30 * 60_000;
		this._now = options.now ?? (() => Date.now());
		this._executionIdFactory = options.executionIdFactory ?? (() => `exec_${randomUUID()}`);
	}

	async launch(request: MissionRequest, options: MissionLaunchOptions = {}): Promise<MissionHandle> {
		const contract = request.orchestrationExecution;
		if (!contract) throw new Error(`ORCHESTRATION_EXECUTION_REQUIRED: mission ${request.missionId}`);
		const plan = await this.loadPlan(contract.orchestrationId);
		if (plan.parentMissionId !== request.missionId)
			throw new Error(
				`ORCHESTRATION_PARENT_MISMATCH: ${contract.orchestrationId} belongs to ${plan.parentMissionId}`,
			);

		const controller = new AbortController();
		if (options.signal) {
			if (options.signal.aborted) controller.abort(options.signal.reason);
			else options.signal.addEventListener("abort", () => controller.abort(options.signal!.reason), { once: true });
		}
		const active: ActiveExecution = {
			request,
			executionId: this._executionIdFactory(request),
			startedAtMs: this._now(),
			controller,
			launched: false,
			cancelled: false,
		};
		this._active.set(request.missionId, active);
		try {
			await this._orchestrator.reconcile(contract.orchestrationId);
			await this._lifecycle.launchChildren(request.missionId);
			active.launched = true;
		} catch (error) {
			this._active.delete(request.missionId);
			throw error;
		}
		return createMissionHandle({
			missionId: request.missionId,
			parentMissionId: request.parentMissionId,
			depth: request.depth,
			executionId: active.executionId,
			state: "RUNNING",
			createdAtMs: request.createdAtMs,
			startedAtMs: active.startedAtMs,
			cancel: (reason) =>
				this.cancel(
					{
						missionId: request.missionId,
						parentMissionId: request.parentMissionId,
						depth: request.depth,
						executionId: active.executionId,
						state: "RUNNING",
						createdAtMs: request.createdAtMs,
						startedAtMs: active.startedAtMs,
						cancel: async () => undefined,
					},
					reason,
				),
		});
	}

	async awaitResult(handle: MissionHandle, options: { signal?: AbortSignal } = {}): Promise<MissionResult> {
		const active = this._active.get(handle.missionId);
		if (!active) throw new Error(`Unknown mission: ${handle.missionId}`);
		const signal = active.controller.signal;
		if (options.signal) {
			if (options.signal.aborted) active.controller.abort(options.signal.reason);
			else
				options.signal.addEventListener("abort", () => active.controller.abort(options.signal!.reason), {
					once: true,
				});
		}
		const deadline = this._now() + this._maxWallTimeMs;
		try {
			for (;;) {
				if (signal.reason instanceof SchedulerWorkerDriverFailure)
					return this.result(active, "FAILED", signal.reason.message);
				if (signal.aborted || active.cancelled) return this.result(active, "CANCELLED", "orchestration cancelled");
				if (this._now() >= deadline) {
					await this._orchestrator
						.cancel(active.request.orchestrationExecution!.orchestrationId)
						.catch(() => undefined);
					return this.result(active, "TIMED_OUT", "orchestration deadline exceeded");
				}
				const contract = active.request.orchestrationExecution!;
				await this._orchestrator.reconcile(contract.orchestrationId);
				await this._lifecycle.launchChildren(active.request.missionId);
				const plan = await this.loadPlan(contract.orchestrationId);
				const statuses = [] as Array<{
					requirement: string;
					status: Awaited<ReturnType<OrchestrationLifecycleExecutor["childStatus"]>>;
				}>;
				for (const node of plan.nodes) {
					if (!node.childMissionId || !node.childSessionId) continue;
					statuses.push({
						requirement: node.requirement,
						status: await this._lifecycle.childStatus(active.request.missionId, node.nodeId),
					});
				}
				if (plan.decision === "DIRECT" && plan.nodes.length === 0)
					return this.result(active, "SUCCEEDED", "direct orchestration completed", "accepted");
				const required = statuses.filter((entry) => entry.requirement !== "OPTIONAL");
				const requiredFailure = required.find(
					(entry) =>
						entry.status.terminal &&
						entry.status.missionState !== "PARTIAL" &&
						(!entry.status.success ||
							entry.status.verificationStatus === "failed" ||
							entry.status.completionDecision === "rejected"),
				);
				if (requiredFailure)
					return this.result(active, "FAILED", `required child failed: ${requiredFailure.status.missionState}`);
				const allRequiredTerminal = required.every((entry) => entry.status.terminal);

				const allTerminal = statuses.length > 0 && statuses.every((entry) => entry.status.terminal);
				if (required.length === 0) {
					if (allTerminal)
						return this.result(
							active,
							statuses.some((entry) => !entry.status.success) ? "PARTIAL" : "SUCCEEDED",
							"all optional orchestration children reached terminal state",
						);
					await sleep(this._pollMs, signal);
					continue;
				}
				if (allRequiredTerminal && allTerminal) {
					const optionalFailure = statuses.some(
						(entry) => entry.requirement === "OPTIONAL" && !entry.status.success,
					);
					const unverifiedRequired = required.some(
						(entry) => entry.status.missionState === "PARTIAL" || entry.status.completionDecision !== "accepted",
					);
					return this.result(
						active,
						optionalFailure || unverifiedRequired ? "PARTIAL" : "SUCCEEDED",
						optionalFailure
							? "required gates accepted; optional child failed"
							: unverifiedRequired
								? "orchestration completed but required child verification was not accepted"
								: "all required orchestration gates accepted",
					);
				}
				await sleep(this._pollMs, signal);
			}
		} finally {
			this._active.delete(handle.missionId);
		}
	}

	async cancel(handle: MissionHandle, reason = "orchestration cancelled"): Promise<void> {
		const active = this._active.get(handle.missionId);
		if (!active) return;
		active.cancelled = true;
		active.controller.abort(reason);
		const orchestrationId = active.request.orchestrationExecution?.orchestrationId;
		if (orchestrationId) await this._orchestrator.cancel(orchestrationId).catch(() => undefined);
	}

	private async loadPlan(orchestrationId: string): Promise<OrchestrationPlan> {
		const loaded = await this._store.load(orchestrationId);
		if (loaded.status === "missing") throw new Error(`ORCHESTRATION_NOT_FOUND: ${orchestrationId}`);
		if (loaded.status === "corrupt") throw new Error(`ORCHESTRATION_PLAN_CORRUPT: ${loaded.diagnostic}`);
		return loaded.document.plan;
	}

	private result(
		active: ActiveExecution,
		state: MissionResult["state"],
		summary: string,
		completionDecision: MissionResult["completionDecision"] = state === "SUCCEEDED"
			? "accepted"
			: state === "PARTIAL"
				? "rejected"
				: "unavailable",
	): MissionResult {
		const finishedAtMs = this._now();
		const executionOutcome =
			state === "SUCCEEDED" || state === "PARTIAL"
				? "COMPLETED"
				: state === "CANCELLED"
					? "CANCELLED"
					: state === "TIMED_OUT"
						? "TIMED_OUT"
						: "FAILED";
		const verification =
			state === "SUCCEEDED" ? { status: "verified" as const, summary } : { status: "unverified" as const, summary };
		const failures: StructuredFailure[] =
			state === "SUCCEEDED" || state === "PARTIAL"
				? []
				: [
						{
							category: state === "CANCELLED" ? "CANCELLED" : state === "TIMED_OUT" ? "TIMED_OUT" : "EXECUTION",
							message: summary,
						},
					];
		return createMissionResult({
			missionId: active.request.missionId,
			parentMissionId: active.request.parentMissionId,
			depth: active.request.depth,
			state,
			executionOutcome,
			verification,
			completionDecision,
			failures,
			executorDiagnostics: { executorId: this.executorId },
			startedAtMs: active.startedAtMs,
			finishedAtMs,
		});
	}
}

export function createOrchestrationMissionExecutor(
	options: OrchestrationMissionExecutorOptions,
): OrchestrationMissionExecutor {
	return new OrchestrationMissionExecutor(options);
}
