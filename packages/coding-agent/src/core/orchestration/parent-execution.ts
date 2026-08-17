/**
 * Parent orchestration execution wiring (2.17.0).
 *
 * The safe production factory for the parent side of the orchestration
 * boundary. It composes the EXISTING parts — nothing is re-implemented:
 *
 *   - `SchedulerWorkerChildExecutionPort` (or an injected
 *     `OrchestrationChildExecutionPort`) — the child execution authority.
 *     It verifies the parent's durable contract and enqueues scheduling
 *     intents; it never launches.
 *   - `OrchestrationLifecycleExecutor` — resolves the parent's named
 *     authority (verified, never defaulted) and drives one launch pass per
 *     materialized node through the port.
 *   - `OrchestrationMissionExecutor` — the durable parent `MissionExecutor`:
 *     it owns no lease and writes no parent state itself; it drives the plan
 *     through the lifecycle/port seams and reports a terminal MissionResult.
 *   - `DurableMissionCoordinator` — owns the parent execution lease, every
 *     authoritative parent lifecycle transition, and the terminal commit.
 *
 * Nothing here bypasses Scheduler -> Assignment -> Worker: the parent
 * executor only enqueues durable scheduling intents through the port; actual
 * child execution remains owned by the scheduler tick and the worker daemon.
 */

import type { AssignmentControlService } from "../assignment/assignment-control-service.js";
import {
	DurableMissionCoordinator,
	type DurableMissionCoordinatorOptions,
} from "../mission-domain/durable-coordinator.js";
import type { DurableMissionStore } from "../mission-domain/durable-store.js";
import type { MissionRequest } from "../mission-domain/mission-request.js";
import type { SchedulerControlService } from "../scheduler/scheduler-control-service.js";
import type { WorkerControlService } from "../worker-daemon/worker-control-service.js";
import { SchedulerWorkerChildExecutionPort } from "./child-execution-port.js";
import { OrchestrationLifecycleExecutor } from "./lifecycle-executor.js";
import { OrchestrationMissionExecutor } from "./orchestration-mission-executor.js";
import type { OrchestratorService } from "./orchestrator.js";
import {
	SchedulerWorkerDriver,
	type SchedulerWorkerDriverOptions,
	SchedulerWorkerTerminalCleanup,
} from "./scheduler-worker-driver.js";
import type { OrchestrationChildExecutionPort, OrchestrationStore } from "./types.js";

/**
 * Default stable identity of the scheduler/worker child execution authority.
 * A parent's durable contract
 * (`MissionRequest.orchestrationExecution.childExecutionAuthority`) must name
 * exactly this identity for the default port to accept the orchestration.
 */
export const DEFAULT_ORCHESTRATION_CHILD_AUTHORITY = "scheduler-worker" as const;

export interface ParentOrchestrationExecutionOptions {
	/** Durable mission store (parent contract + child records). */
	missions: DurableMissionStore;
	/** Orchestration plan store. */
	store: OrchestrationStore;
	/** Reconciliation/materialization service for the parent's plan. */
	orchestrator: OrchestratorService;
	/** Scheduler used by the default child execution authority port. */
	scheduler?: SchedulerControlService;
	/**
	 * Child execution authority port. When omitted, a
	 * `SchedulerWorkerChildExecutionPort` is built over `scheduler` with
	 * `authority` and `workers`. When present, `authority` and `workers` are
	 * ignored (the port's own `authority` identity is used).
	 */
	port?: OrchestrationChildExecutionPort;
	/**
	 * Stable identity of the child execution authority for the default port.
	 * Default: `DEFAULT_ORCHESTRATION_CHILD_AUTHORITY`.
	 */
	authority?: string;
	/** Workers consulted for child status/terminal polling (read-only). */
	workers?: readonly WorkerControlService[];
	/** Worker started by the optional bounded local Scheduler -> Worker pump. */
	worker?: WorkerControlService;
	/** Optional bounded local Scheduler -> Worker pump for application composition. */
	driver?: Omit<SchedulerWorkerDriverOptions, "scheduler" | "worker" | "terminalCleanup">;
	/** Existing Assignment authority used for mandatory bounded parent-terminal cleanup. */
	assignments?: AssignmentControlService;
	/** Executor id for the parent orchestration executor (default "orchestration"). */
	executorId?: string;
	/** Child status poll cadence for the parent executor (default 250ms). */
	pollMs?: number;
	/** Parent execution wall-time deadline (default 30 minutes). */
	maxWallTimeMs?: number;
	/** Clock for deterministic construction (tests). */
	now?: () => number;
	/** Executor-scoped execution id factory (tests). */
	executionIdFactory?: (request: MissionRequest) => string;
	/** Coordinator options for the parent (lease duration, heartbeat, owner). */
	coordinator?: DurableMissionCoordinatorOptions;
}

/** The composed parent execution stack, ready for `coordinator.resume()`. */
export interface ParentOrchestrationExecution {
	/** The child execution authority in use (injected or built). */
	port: OrchestrationChildExecutionPort;
	/** Parent lifecycle executor bound to the port. */
	lifecycle: OrchestrationLifecycleExecutor;
	/** Durable parent orchestration MissionExecutor. */
	executor: OrchestrationMissionExecutor;
	/** Coordinator that owns the parent lease and terminal commit. */
	coordinator: DurableMissionCoordinator;
	/** Optional bounded Scheduler -> Worker application driver. */
	driver?: SchedulerWorkerDriver;
}

/**
 * Build the parent orchestration execution stack over the existing
 * stores/services. Construction verifies the port set (a duplicate authority
 * identity is an error) but performs no launches and writes no state: the
 * parent is driven only when `coordinator.resume(parentMissionId)` is called.
 */
export function createParentOrchestrationExecution(
	options: ParentOrchestrationExecutionOptions,
): ParentOrchestrationExecution {
	if (!options.port && !options.scheduler)
		throw new Error("SCHEDULER_REQUIRED: a scheduler is required when no child execution port is provided");
	const port =
		options.port ??
		new SchedulerWorkerChildExecutionPort({
			authority: options.authority ?? DEFAULT_ORCHESTRATION_CHILD_AUTHORITY,
			missions: options.missions,
			store: options.store,
			scheduler: options.scheduler!,
			workers: options.workers ?? (options.worker ? [options.worker] : undefined),
			now: options.now,
		});
	const lifecycle = new OrchestrationLifecycleExecutor({
		missions: options.missions,
		store: options.store,
		ports: [port],
	});
	const executor = new OrchestrationMissionExecutor({
		missions: options.missions,
		store: options.store,
		lifecycle,
		orchestrator: options.orchestrator,
		executorId: options.executorId,
		pollMs: options.pollMs,
		maxWallTimeMs: options.maxWallTimeMs,
		now: options.now,
		executionIdFactory: options.executionIdFactory,
	});
	const coordinator = new DurableMissionCoordinator(options.missions, executor, options.coordinator);
	if (options.driver && (!options.scheduler || !options.worker))
		throw new Error("SCHEDULER_WORKER_DRIVER_INVALID: scheduler and worker are required when driver is configured");
	if (options.driver && (!options.assignments || !options.scheduler))
		throw new Error("SCHEDULER_WORKER_DRIVER_INVALID: assignments and scheduler are required for terminal cleanup");
	const terminalCleanup = options.assignments
		? new SchedulerWorkerTerminalCleanup({
				missions: options.missions,
				scheduler: options.scheduler!,
				assignments: options.assignments,
			})
		: undefined;
	const driver = options.driver
		? new SchedulerWorkerDriver({
				scheduler: options.scheduler!,
				worker: options.worker!,
				terminalCleanup: terminalCleanup!,
				...options.driver,
			})
		: undefined;
	return { port, lifecycle, executor, coordinator, driver };
}
