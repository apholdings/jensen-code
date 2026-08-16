/**
 * Worker Daemon Foundation — public API (2.13.0).
 *
 * The durable runtime boundary between a durable Assignment and a proven
 * terminal Mission result. This module composes existing authority domains
 * (Executor Registry, Assignment, Durable Mission, Reliability verification)
 * into a long-lived worker loop; it introduces no new persistence authority.
 */

export { handleWorkerCommand, printWorkerUsage } from "./cli.js";
export {
	listWorkers,
	WorkerControlService,
	type WorkerControlServiceOptions,
} from "./worker-control-service.js";
export {
	isSafeWorkerId,
	newWorkerOwnerId,
	type WorkerActivity,
	type WorkerCurrentAssignment,
	type WorkerCurrentExecution,
	type WorkerDaemonState,
	WorkerError,
	type WorkerErrorCode,
	type WorkerIdentity,
	type WorkerListResult,
	type WorkerRecoveryReport,
	type WorkerRunOutcome,
	type WorkerStartOutcome,
	type WorkerStatus,
	type WorkerSummary,
	type WorkerWaitReason,
	workerIdForExecutor,
} from "./worker-types.js";
export { buildAcceptanceCriteriaVerifier } from "./worker-verification.js";
