/**
 * Scheduler/Worker child execution authority port (2.14.0).
 *
 * Adapter implementation of `OrchestrationChildExecutionPort`. It wraps the
 * existing control services and never launches anything itself:
 *
 *   - `SchedulerControlService` — durable scheduling intent. `executeChild`
 *     enqueues at most one intent per child mission (the scheduler's intent id
 *     is deterministic per mission, so repeated requests reuse the entry).
 *   - `WorkerControlService` — status/terminal polling only. The port calls
 *     the worker read model (`status`) and nothing else: never `start`, never
 *     `runOnce`, never a launch path.
 *
 * Actual execution remains owned by Scheduler -> Assignment -> Worker
 * (`SchedulerControlService.runTick` -> `AssignmentControlService` ->
 * `WorkerControlService.runOnce`).
 *
 * Authority is verified, never defaulted: the durable parent mission names the
 * child execution authority (`MissionRequest.orchestrationExecution.childExecutionAuthority`)
 * and this port accepts a child only when that named authority — and the named
 * orchestration — match this port's `authority` exactly.
 *
 * `childStatus` is the port's read-only polling half of the
 * `OrchestrationChildExecutionPort` contract: it reports mission state,
 * terminal outcome, scheduling intent, and worker read-model snapshots, and
 * is the only method the parent lifecycle executor may use to observe a
 * child without requesting execution.
 */
import type { DurableMissionRecord, DurableMissionStore } from "../mission-domain/durable-store.js";
import { isTerminalMissionState, type MissionState } from "../mission-domain/mission-state.js";
import type { SchedulerControlService } from "../scheduler/scheduler-control-service.js";
import { SchedulingError } from "../scheduler/scheduler-types.js";
import type { WorkerControlService } from "../worker-daemon/worker-control-service.js";
import type {
	OrchestrationChildExecutionPort,
	OrchestrationChildExecutionReceipt,
	OrchestrationChildExecutionRequest,
	OrchestrationChildExecutionStatus,
	OrchestrationChildWorkerStatus,
	OrchestrationPlanDocument,
	OrchestrationStore,
} from "./types.js";

export interface SchedulerWorkerChildExecutionPortOptions {
	/** Stable identity of this child execution authority (matched against the parent's durable contract). */
	authority: string;
	/** Durable mission store for child/parent verification and terminal polling. */
	missions: DurableMissionStore;
	/** Orchestration plan store for node verification and scheduling input. */
	store: OrchestrationStore;
	/** Scheduler used to enqueue (and idempotently reuse) the scheduling intent. */
	scheduler: SchedulerControlService;
	/**
	 * Workers consulted for status/terminal polling only. The port never
	 * starts a worker or triggers execution through it.
	 */
	workers?: readonly WorkerControlService[];
	/** Clock for deterministic enqueue timestamps. */
	now?: () => number;
}

export class SchedulerWorkerChildExecutionPort implements OrchestrationChildExecutionPort {
	private readonly _missions: DurableMissionStore;
	private readonly _store: OrchestrationStore;
	private readonly _scheduler: SchedulerControlService;
	private readonly _workers: readonly WorkerControlService[];
	private readonly _now: () => number;
	readonly authority: string;

	constructor(options: SchedulerWorkerChildExecutionPortOptions) {
		this.authority = options.authority;
		this._missions = options.missions;
		this._store = options.store;
		this._scheduler = options.scheduler;
		this._workers = options.workers ?? [];
		this._now = options.now ?? (() => Date.now());
	}

	/**
	 * Authorize execution of a materialized orchestration child.
	 *
	 * Verifies, in order: the plan exists and names the node; the node is
	 * materialized and its durable identity matches the request; the child
	 * mission's orchestration metadata matches; the parent's durable contract
	 * names exactly this authority for this orchestration; the child is not
	 * terminal. Only then does it enqueue the scheduling intent. It never
	 * launches: execution proceeds through Scheduler -> Assignment -> Worker.
	 */
	async executeChild(request: OrchestrationChildExecutionRequest): Promise<OrchestrationChildExecutionReceipt> {
		const planDocument = await this._loadPlan(request.orchestrationId);
		if (!planDocument) return this.decline(`ORCHESTRATION_NOT_FOUND: no plan for ${request.orchestrationId}`);
		const plan = planDocument.plan;
		const node = plan.nodes.find((candidate) => candidate.nodeId === request.nodeId);
		if (!node) return this.decline(`NODE_NOT_FOUND: ${request.orchestrationId} has no node ${request.nodeId}`);
		if (!node.childMissionId)
			return this.decline(`CHILD_NOT_MATERIALIZED: node ${request.nodeId} has no materialized child mission`);
		if (
			node.childMissionId !== request.childMissionId ||
			node.childSessionId !== request.childSessionId ||
			node.workspaceAccess !== request.workspaceAccess
		)
			return this.decline(
				`CHILD_IDENTITY_MISMATCH: node ${request.nodeId} is materialized as ` +
					`${node.childMissionId}/${node.childSessionId ?? "-"}/${node.workspaceAccess}, ` +
					`request is ${request.childMissionId}/${request.childSessionId}/${request.workspaceAccess}`,
			);

		const child = await this._loadMission(request.childMissionId);
		if (!child) return this.decline(`CHILD_NOT_MATERIALIZED: mission ${request.childMissionId} is missing`);
		const metadata = child.request.orchestration;
		if (!metadata || metadata.orchestrationId !== request.orchestrationId || metadata.nodeId !== request.nodeId)
			return this.decline(
				`CHILD_METADATA_MISMATCH: mission ${request.childMissionId} carries orchestration metadata ` +
					`${metadata ? `${metadata.orchestrationId}/${metadata.nodeId}` : "none"}`,
			);

		const parent = await this._loadMission(plan.parentMissionId);
		if (!parent) return this.decline(`PARENT_MISSION_MISSING: ${plan.parentMissionId} required to verify authority`);
		const execution = parent.request.orchestrationExecution;
		if (!execution)
			return this.decline(
				`AUTHORITY_MISMATCH: parent mission ${plan.parentMissionId} names no child execution authority`,
			);
		if (execution.orchestrationId !== request.orchestrationId)
			return this.decline(
				`AUTHORITY_MISMATCH: parent mission ${plan.parentMissionId} names orchestration ` +
					`'${execution.orchestrationId}', not '${request.orchestrationId}'`,
			);
		if (execution.childExecutionAuthority !== this.authority)
			return this.decline(
				`AUTHORITY_MISMATCH: parent mission ${plan.parentMissionId} names authority ` +
					`'${execution.childExecutionAuthority}', not '${this.authority}'`,
			);
		if (isTerminalMissionState(child.state))
			return this.decline(`MISSION_TERMINAL: child ${request.childMissionId} is ${child.state}`);

		try {
			await this._scheduler.enqueueIntent(request.childMissionId, {
				requirements: node.requirements,
				priority: node.priority ?? 0,
				now: this._now(),
			});
		} catch (error) {
			if (error instanceof SchedulingError)
				return this.decline(`SCHEDULER_DECLINED: ${error.code}: ${error.message}`);
			throw error;
		}
		return { accepted: true, authority: this.authority };
	}

	/**
	 * Status/terminal polling for a materialized child, read from the existing
	 * stores (durable mission store, scheduling intent store) and the worker
	 * read model. Read-only: this never enqueues, assigns, or launches.
	 */
	async childStatus(request: OrchestrationChildExecutionRequest): Promise<OrchestrationChildExecutionStatus> {
		const child = await this._loadMission(request.childMissionId);
		const missionState: MissionState | "MISSING" = child ? child.state : "MISSING";
		const terminal = child ? isTerminalMissionState(child.state) : false;
		const success = terminal && child?.result?.success === true;
		const verificationStatus = child?.result?.verification.status;
		const completionDecision = child?.result?.completionDecision;
		const verificationSummary = child?.result?.verification.summary;

		let intent: OrchestrationChildExecutionStatus["intent"];
		try {
			const detail = await this._scheduler.getIntentForMission(request.childMissionId);
			intent = {
				intentId: detail.intentId,
				state: detail.state,
				assignmentId: detail.assignmentId,
				unschedulableReason: detail.unschedulableReason,
			};
		} catch (error) {
			if (!(error instanceof SchedulingError)) throw error;
			intent = undefined;
		}

		const workers: OrchestrationChildWorkerStatus[] = [];
		for (const worker of this._workers) {
			const status = await worker.status();
			const executing = status.currentAssignment?.missionId === request.childMissionId;
			workers.push({
				workerId: status.identity.workerId,
				daemonState: status.daemonState,
				activity: status.activity,
				...(executing ? { executingChildMissionId: request.childMissionId } : {}),
			});
		}

		return {
			orchestrationId: request.orchestrationId,
			nodeId: request.nodeId,
			childMissionId: request.childMissionId,
			childSessionId: request.childSessionId,
			missionState,
			terminal,
			success,
			...(verificationStatus ? { verificationStatus } : {}),
			...(completionDecision ? { completionDecision } : {}),
			...(verificationSummary ? { verificationSummary } : {}),
			...(intent ? { intent } : {}),
			workers,
		};
	}

	private decline(reason: string): OrchestrationChildExecutionReceipt {
		return { accepted: false, authority: this.authority, reason };
	}

	private async _loadPlan(orchestrationId: string): Promise<OrchestrationPlanDocument | undefined> {
		const loaded = await this._store.load(orchestrationId);
		return loaded.status === "ok" ? loaded.document : undefined;
	}

	private async _loadMission(missionId: string): Promise<DurableMissionRecord | undefined> {
		const loaded = await this._missions.load(missionId);
		if (loaded.status === "corrupt")
			throw new Error(`CHILD_MISSION_CORRUPT: mission ${missionId} is corrupt: ${loaded.diagnostic}`);
		return loaded.status === "ok" ? loaded.record : undefined;
	}
}
