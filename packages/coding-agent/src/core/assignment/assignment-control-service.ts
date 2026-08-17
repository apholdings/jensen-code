/**
 * Assignment Control Service (2.11.0).
 *
 * The authoritative application/operator boundary over the durable mission ↔
 * executor assignment domain. It never schedules, never auto-selects executors,
 * and never starts mission work merely by creating an assignment.
 *
 *   - `assignMission`            designates a mission for an executor.
 *   - `reassignMission`          explicitly supersedes the current designation.
 *   - `releaseAssignment`        removes a designation without cancelling work.
 *   - `acceptAssignment`         a current runtime claims the assignment.
 *   - `beginAssignedExecution`   persists the EXECUTING intent + owner correlation.
 *   - `startAssignedMission`     drives the existing fenced child-resume path.
 *
 * Execution ownership (`ExecutionLease`/`fencingToken`) and executor runtime
 * incarnation (`runtimeInstanceId`/`runtimeEpoch`) remain separate authority
 * domains; the assignment only records logical designation and audit metadata.
 */

import {
	type BuiltChildResume,
	buildChildResumeExecutor,
	resolveChildSessionForResume,
} from "../durable-child-session/child-session-restore.js";
import { ExecutorRegistryError } from "../executor-registry/executor-registry-types.js";
import type { ExecutorControlService, ExecutorDetail, ExecutorRuntimeProof } from "../executor-registry/index.js";
import {
	DurableMissionCoordinator,
	type DurableMissionCoordinatorOptions,
} from "../mission-domain/durable-coordinator.js";
import type { DurableMissionRecord, DurableMissionStore } from "../mission-domain/durable-store.js";
import { isExecutionLeaseActive, newExecutorOwnerId } from "../mission-domain/execution-lease.js";
import { isTerminalMissionState } from "../mission-domain/mission-state.js";
import type { ProcessMissionVerifier } from "../mission-domain/process-mission-executor.js";
import type { SessionManager } from "../session-manager.js";
import type { AssignmentStore } from "./assignment-store.js";
import { createAssignmentRecord } from "./assignment-store.js";
import {
	type AcceptAssignmentOutcome,
	type AssignabilityResult,
	type AssignMissionInput,
	type AssignMissionOutcome,
	type AssignmentDetail,
	AssignmentError,
	type AssignmentListOptions,
	type AssignmentListResult,
	type AssignmentRecord,
	type AssignmentState,
	type AssignmentSummary,
	type BeginAssignedExecutionOutcome,
	type CompleteAssignmentInput,
	type CompleteAssignmentOutcome,
	type ExecutionOwnerIdentity,
	isSafeAssignmentId,
	type MissionRequirements,
	newAssignmentId,
	type ReassignMissionInput,
	type StartAssignedMissionOutcome,
} from "./assignment-types.js";
import { evaluateAssignability, mergeExecutorCapabilities } from "./compatibility.js";

/** Maps a resume to the concrete child CLI launch (mirrors Mission Control). */
export type BuildAssignedResumeLaunch = (input: {
	request: DurableMissionRecord["request"];
	resumePrompt: string;
	childSessionId: string;
}) => {
	command: string;
	args: readonly string[];
	cwd: string;
	env?: Record<string, string | undefined>;
};

/**
 * Builds the executor for a resolved durable child session. Defaults to the
 * local `ProcessMissionExecutor`; a remote worker injects a builder that
 * constructs a `RemoteMissionExecutor` bound to the same resolved session.
 */
export type BuildAssignedExecutor = (input: {
	record: DurableMissionRecord;
	sessionManager: SessionManager;
	childSessionId: string;
}) => BuiltChildResume;

export interface AssignmentControlServiceOptions {
	store: AssignmentStore;
	missions: DurableMissionStore;
	executors: ExecutorControlService;
	now?: () => number;
	assignmentIdFactory?: () => string;
	ownerIdFactory?: () => string;
	sessionDir?: string;
	leaseDurationMs?: number;
	heartbeatIntervalMs?: number;
	renewalSafetyMarginMs?: number;
	attemptIdFactory?: () => string;
	leaseIdFactory?: () => string;
}

export class AssignmentControlService {
	private readonly _store: AssignmentStore;
	private readonly _missions: DurableMissionStore;
	private readonly _executors: ExecutorControlService;
	private readonly _now: () => number;
	private readonly _assignmentIdFactory: () => string;
	private readonly _ownerIdFactory: () => string;
	private readonly _sessionDir?: string;
	private readonly _coordinatorOptions: DurableMissionCoordinatorOptions;

	constructor(options: AssignmentControlServiceOptions) {
		this._store = options.store;
		this._missions = options.missions;
		this._executors = options.executors;
		this._now = options.now ?? (() => Date.now());
		this._assignmentIdFactory = options.assignmentIdFactory ?? (() => newAssignmentId());
		this._ownerIdFactory = options.ownerIdFactory ?? (() => newExecutorOwnerId());
		this._sessionDir = options.sessionDir;
		this._coordinatorOptions = {
			now: options.now,
			leaseDurationMs: options.leaseDurationMs,
			heartbeatIntervalMs: options.heartbeatIntervalMs,
			renewalSafetyMarginMs: options.renewalSafetyMarginMs,
			attemptIdFactory: options.attemptIdFactory,
			leaseIdFactory: options.leaseIdFactory,
		};
	}

	get store(): AssignmentStore {
		return this._store;
	}

	// =========================================================================
	// Read model
	// =========================================================================

	async listAssignments(options: AssignmentListOptions = {}): Promise<AssignmentListResult> {
		const { records, corrupt } = await this._store.listRecords();

		let entries = records.map((record) => this._toSummary(record));
		const filter = options.filter;
		if (filter) {
			entries = entries.filter((entry) => {
				if (filter.missionId !== undefined && entry.missionId !== filter.missionId) return false;
				if (filter.executorId !== undefined && entry.executorId !== filter.executorId) return false;
				if (filter.state !== undefined && entry.state !== filter.state) return false;
				if (filter.current !== undefined && entry.current !== filter.current) return false;
				return true;
			});
		}

		const sort = options.sort ?? "createdAtMs";
		const direction = options.direction ?? "asc";
		entries.sort((a, b) => {
			let cmp: number;
			if (sort === "assignmentId")
				cmp = a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0;
			else if (sort === "createdAtMs") {
				cmp = a.createdAtMs - b.createdAtMs || (a.assignmentId < b.assignmentId ? -1 : 1);
			} else cmp = a.updatedAtMs - b.updatedAtMs || (a.assignmentId < b.assignmentId ? -1 : 1);
			return direction === "desc" ? -cmp : cmp;
		});

		const offset = options.offset ?? 0;
		if (offset > 0) entries = entries.slice(offset);
		if (options.limit !== undefined) entries = entries.slice(0, options.limit);

		return { entries, corrupt };
	}

	async getAssignment(assignmentId: string): Promise<AssignmentDetail> {
		const record = await this._requireAssignment(assignmentId);
		return this._toDetail(record);
	}

	async getCurrentForMission(missionId: string): Promise<AssignmentDetail | undefined> {
		const { records } = await this._store.listRecords();
		const current = records.filter((record) => record.missionId === missionId && record.current);
		if (current.length > 1) {
			throw new AssignmentError("ASSIGNMENT_CORRUPT", `Mission ${missionId} has multiple current assignments`, {
				missionId,
				assignmentIds: current.map((record) => record.assignmentId),
			});
		}
		return current.length === 1 ? this._toDetail(current[0]) : undefined;
	}

	async listForMission(missionId: string): Promise<AssignmentSummary[]> {
		const { records } = await this._store.listRecords();
		return records
			.filter((record) => record.missionId === missionId)
			.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.assignmentId < b.assignmentId ? -1 : 1))
			.map((record) => this._toSummary(record));
	}

	async listForExecutor(executorId: string): Promise<AssignmentSummary[]> {
		const { records } = await this._store.listRecords();
		return records
			.filter((record) => record.executorId === executorId)
			.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.assignmentId < b.assignmentId ? -1 : 1))
			.map((record) => this._toSummary(record));
	}

	/** Current designation per mission (for Mission Control / Executor Control views). */
	async listCurrentAssignments(): Promise<Map<string, AssignmentRecord>> {
		const { records } = await this._store.listRecords();
		const map = new Map<string, AssignmentRecord>();
		for (const record of records) {
			if (!record.current) continue;
			map.set(record.missionId, record);
		}
		return map;
	}

	/** Read-only deterministic compatibility/assignability for a mission↔executor pair. */
	async evaluateCompatibility(
		missionId: string,
		executorId: string,
		requirements?: MissionRequirements,
	): Promise<{
		missionId: string;
		executorId: string;
		requirements: MissionRequirements | undefined;
		assignability: AssignabilityResult;
	}> {
		await this._requireMission(missionId);
		const detail = await this._executorDetail(executorId);
		let effectiveRequirements = requirements;
		if (effectiveRequirements === undefined) {
			const current = await this.getCurrentForMission(missionId);
			effectiveRequirements = current?.requirementsSnapshot;
		}
		const assignability = this._evaluateAssignability(detail, effectiveRequirements);
		return { missionId, executorId, requirements: effectiveRequirements, assignability };
	}

	// =========================================================================
	// Explicit designation mutations
	// =========================================================================

	async assignMission(input: AssignMissionInput): Promise<AssignMissionOutcome> {
		const mission = await this._requireMission(input.missionId);
		if (isTerminalMissionState(mission.state)) {
			throw new AssignmentError(
				"MISSION_NOT_ASSIGNABLE",
				`Mission ${input.missionId} is terminal (${mission.state})`,
				{
					missionId: input.missionId,
					state: mission.state,
				},
			);
		}

		const assignmentId = input.assignmentId ?? this._assignmentIdFactory();
		if (!isSafeAssignmentId(assignmentId)) {
			throw new AssignmentError("INVALID_ASSIGNMENT_ID", `Unsafe assignment id: ${assignmentId}`, { assignmentId });
		}

		const detail = await this._executorDetail(input.executorId);
		const assignability = this._evaluateAssignability(detail, input.requirements);
		this._assertAssignable(input.executorId, assignability);

		const now = this._now();
		const record = createAssignmentRecord({
			assignmentId,
			missionId: input.missionId,
			executorId: input.executorId,
			now,
			assignedBy: input.assignedBy,
			requirementsSnapshot: input.requirements,
			compatibilitySnapshot: assignability.compatibility,
			executionMode: input.executionMode,
			remoteTargetId: input.remoteTargetId,
			executorRuntimeAtAssignment: {
				runtimeInstanceId: detail.runtime?.runtimeInstanceId,
				runtimeEpoch: detail.runtimeEpoch,
				status: detail.status,
				observedAtMs: now,
			},
		});

		const result = await this._store.mutate<AssignMissionOutcome>(input.missionId, (index) => {
			if (index.current) {
				throw new AssignmentError(
					"MISSION_ALREADY_ASSIGNED",
					`Mission ${input.missionId} already has a current assignment`,
					{
						missionId: input.missionId,
						currentAssignmentId: index.current.assignmentId,
						currentExecutorId: index.current.executorId,
					},
				);
			}
			return {
				kind: "write",
				records: [...index.records, record],
				value: {
					assignmentId,
					missionId: input.missionId,
					executorId: input.executorId,
					state: "ASSIGNED" as AssignmentState,
					record,
				},
			};
		});

		return this._unwrap(result, input.missionId);
	}

	async reassignMission(
		missionId: string,
		newExecutorId: string,
		input: Omit<ReassignMissionInput, "missionId" | "executorId"> = {},
	): Promise<AssignMissionOutcome> {
		const mission = await this._requireMission(missionId);
		if (isTerminalMissionState(mission.state)) {
			throw new AssignmentError("MISSION_NOT_ASSIGNABLE", `Mission ${missionId} is terminal (${mission.state})`, {
				missionId,
				state: mission.state,
			});
		}
		if (mission.lease && isExecutionLeaseActive(mission.lease, this._now())) {
			throw new AssignmentError("MISSION_ACTIVE", `Mission ${missionId} has an active execution owner`, {
				missionId,
				ownerId: mission.lease.ownerId,
			});
		}

		const detail = await this._executorDetail(newExecutorId);
		const assignability = this._evaluateAssignability(detail, input.requirements);
		this._assertAssignable(newExecutorId, assignability);

		const assignmentId = input.assignmentId ?? this._assignmentIdFactory();
		if (!isSafeAssignmentId(assignmentId)) {
			throw new AssignmentError("INVALID_ASSIGNMENT_ID", `Unsafe assignment id: ${assignmentId}`, { assignmentId });
		}

		const now = this._now();
		const next = createAssignmentRecord({
			assignmentId,
			missionId,
			executorId: newExecutorId,
			now,
			assignedBy: input.assignedBy,
			requirementsSnapshot: input.requirements,
			compatibilitySnapshot: assignability.compatibility,
			executionMode: input.executionMode,
			remoteTargetId: input.remoteTargetId,
			executorRuntimeAtAssignment: {
				runtimeInstanceId: detail.runtime?.runtimeInstanceId,
				runtimeEpoch: detail.runtimeEpoch,
				status: detail.status,
				observedAtMs: now,
			},
		});
		next.supersedesAssignmentId = undefined;

		const result = await this._store.mutate<AssignMissionOutcome>(missionId, (index) => {
			const current = index.current;
			if (!current) {
				throw new AssignmentError(
					"ASSIGNMENT_NOT_CURRENT",
					`Mission ${missionId} has no current assignment to reassign`,
					{ missionId },
				);
			}
			if (current.state === "EXECUTING") {
				throw new AssignmentError("MISSION_ACTIVE", `Mission ${missionId} is executing under its assignment`, {
					missionId,
					assignmentId: current.assignmentId,
				});
			}
			if (current.executorId === newExecutorId) {
				throw new AssignmentError(
					"MISSION_ALREADY_ASSIGNED",
					`Mission ${missionId} is already assigned to executor ${newExecutorId}`,
					{ missionId, assignmentId: current.assignmentId, executorId: newExecutorId },
				);
			}

			const superseded: AssignmentRecord = {
				...current,
				state: "SUPERSEDED",
				current: false,
				updatedAtMs: now,
				supersededByAssignmentId: assignmentId,
				reason: `superseded by reassignment to ${newExecutorId}`,
				revision: current.revision + 1,
			};
			const withSupersedes: AssignmentRecord = { ...next, supersedesAssignmentId: current.assignmentId };

			return {
				kind: "write",
				records: [
					...index.records.map((r) => (r.assignmentId === current.assignmentId ? superseded : r)),
					withSupersedes,
				],
				value: {
					assignmentId,
					missionId,
					executorId: newExecutorId,
					state: "ASSIGNED" as AssignmentState,
					record: withSupersedes,
				},
			};
		});

		return this._unwrap(result, missionId);
	}

	async releaseAssignment(assignmentId: string): Promise<AssignmentRecord> {
		const record = await this._requireAssignment(assignmentId);
		const mission = await this._requireMission(record.missionId);
		if (mission.lease && isExecutionLeaseActive(mission.lease, this._now())) {
			throw new AssignmentError("MISSION_ACTIVE", `Mission ${record.missionId} has an active execution owner`, {
				missionId: record.missionId,
				assignmentId,
				ownerId: mission.lease.ownerId,
			});
		}

		const now = this._now();
		const result = await this._store.mutate<AssignmentRecord>(record.missionId, (index) => {
			if (index.current?.assignmentId !== assignmentId) {
				throw new AssignmentError(
					"ASSIGNMENT_NOT_CURRENT",
					`Assignment ${assignmentId} is not the current assignment for mission ${record.missionId}`,
					{ assignmentId, missionId: record.missionId },
				);
			}
			const current = index.current;
			if (current.state === "EXECUTING") {
				throw new AssignmentError("MISSION_ACTIVE", `Assignment ${assignmentId} is executing`, {
					assignmentId,
					missionId: record.missionId,
				});
			}
			const released: AssignmentRecord = {
				...current,
				state: "RELEASED",
				current: false,
				releasedAtMs: now,
				updatedAtMs: now,
				reason: "assignment released",
				revision: current.revision + 1,
			};
			return {
				kind: "write",
				records: index.records.map((r) => (r.assignmentId === assignmentId ? released : r)),
				value: released,
			};
		});

		return this._unwrap(result, record.missionId);
	}

	// =========================================================================
	// Acceptance + execution boundary
	// =========================================================================

	async acceptAssignment(assignmentId: string, proof: ExecutorRuntimeProof): Promise<AcceptAssignmentOutcome> {
		const record = await this._requireAssignment(assignmentId);
		if (record.state !== "ASSIGNED") {
			throw new AssignmentError(
				"ASSIGNMENT_NOT_CURRENT",
				`Assignment ${assignmentId} is ${record.state}; only ASSIGNED can be accepted`,
				{ assignmentId, state: record.state },
			);
		}
		await this._assertCurrentRuntime(record, proof);
		await this._requireAcceptableMission(record.missionId);

		const now = this._now();
		const result = await this._store.mutate<AcceptAssignmentOutcome>(record.missionId, (index) => {
			if (index.current?.assignmentId !== assignmentId) {
				throw new AssignmentError("ASSIGNMENT_NOT_CURRENT", `Assignment ${assignmentId} is no longer current`, {
					assignmentId,
					missionId: record.missionId,
				});
			}
			const current = index.current;
			const accepted: AssignmentRecord = {
				...current,
				state: "ACCEPTED",
				acceptedAtMs: now,
				updatedAtMs: now,
				reason: `accepted by runtime ${proof.runtimeInstanceId} (epoch ${proof.runtimeEpoch})`,
				revision: current.revision + 1,
			};
			return {
				kind: "write",
				records: index.records.map((r) => (r.assignmentId === assignmentId ? accepted : r)),
				value: { assignmentId, state: "ACCEPTED" as AssignmentState, record: accepted },
			};
		});

		return this._unwrap(result, record.missionId);
	}

	async beginAssignedExecution(
		assignmentId: string,
		proof: ExecutorRuntimeProof,
	): Promise<BeginAssignedExecutionOutcome> {
		const record = await this._requireAssignment(assignmentId);
		if (record.state !== "ASSIGNED" && record.state !== "ACCEPTED") {
			throw new AssignmentError(
				"ASSIGNMENT_NOT_CURRENT",
				`Assignment ${assignmentId} is ${record.state}; cannot begin execution`,
				{ assignmentId, state: record.state },
			);
		}
		await this._assertCurrentRuntime(record, proof);
		await this._requireExecutableMission(record.missionId);

		const detail = await this._executorDetail(record.executorId);
		const assignability = this._evaluateAssignability(detail, record.requirementsSnapshot);
		this._assertAssignable(record.executorId, assignability);

		const ownerId = this._ownerIdFactory();
		const executionOwnerIdentity: ExecutionOwnerIdentity = {
			executorId: record.executorId,
			runtimeInstanceId: proof.runtimeInstanceId,
			runtimeEpoch: proof.runtimeEpoch,
			ownerId,
		};
		const now = this._now();

		const result = await this._store.mutate<BeginAssignedExecutionOutcome>(record.missionId, (index) => {
			if (index.current?.assignmentId !== assignmentId) {
				throw new AssignmentError("ASSIGNMENT_NOT_CURRENT", `Assignment ${assignmentId} is no longer current`, {
					assignmentId,
					missionId: record.missionId,
				});
			}
			const current = index.current;
			const executing: AssignmentRecord = {
				...current,
				state: "EXECUTING",
				executionStartedAtMs: now,
				executionOwnerIdentity,
				updatedAtMs: now,
				reason: `execution started by runtime ${proof.runtimeInstanceId} (epoch ${proof.runtimeEpoch})`,
				revision: current.revision + 1,
			};
			return {
				kind: "write",
				records: index.records.map((r) => (r.assignmentId === assignmentId ? executing : r)),
				value: {
					assignmentId,
					missionId: record.missionId,
					executorId: record.executorId,
					state: "EXECUTING" as AssignmentState,
					executionOwnerIdentity,
					record: executing,
				},
			};
		});

		return this._unwrap(result, record.missionId);
	}

	async startAssignedMission(
		assignmentId: string,
		proof: ExecutorRuntimeProof,
		options: {
			buildResumeLaunch: BuildAssignedResumeLaunch;
			signal?: AbortSignal;
			verifier?: ProcessMissionVerifier;
			/** Optional executor builder (remote); defaults to local ProcessMissionExecutor. */
			buildExecutor?: BuildAssignedExecutor;
		},
	): Promise<StartAssignedMissionOutcome> {
		// Preflight without mutating: resolve the durable child session BEFORE the
		// assignment is marked EXECUTING, so a non-child/unresolvable mission is
		// surfaced structurally instead of leaving a stale EXECUTING assignment.
		const record = await this._requireAssignment(assignmentId);
		await this._assertCurrentRuntime(record, proof);
		await this._requireExecutableMission(record.missionId);
		const resolved = await resolveChildSessionForResume({
			store: this._missions,
			missionId: record.missionId,
			sessionDir: this._sessionDir,
		});

		const built = options.buildExecutor
			? options.buildExecutor({
					record: resolved.record,
					sessionManager: resolved.sessionManager,
					childSessionId: resolved.childSessionId,
				})
			: buildChildResumeExecutor({
					record: resolved.record,
					sessionManager: resolved.sessionManager,
					childSessionId: resolved.childSessionId,
					buildResumeLaunch: options.buildResumeLaunch,
					executorId: record.executorId,
					verifier: options.verifier,
				});

		const begun = await this.beginAssignedExecution(assignmentId, proof);
		const coordinator = new DurableMissionCoordinator(this._missions, built.executor, {
			...this._coordinatorOptions,
			ownerId: begun.executionOwnerIdentity.ownerId,
		});

		try {
			const terminal = await coordinator.resume(begun.missionId, { signal: options.signal });
			const lastAttempt = terminal.attempts[terminal.attempts.length - 1];
			const completed = await this.completeAssignment(assignmentId, {
				resultState: terminal.state,
				attemptId: lastAttempt?.attemptId,
				executionId: terminal.resultExecutionId ?? lastAttempt?.executionId,
			});
			return {
				assignmentId,
				missionId: begun.missionId,
				assignmentState: completed.state,
				missionState: terminal.state,
				attemptId: completed.record.consumedByAttemptId,
				executionId: completed.record.consumedByExecutionId,
				success: terminal.state === "SUCCEEDED",
				assignment: completed.record,
			};
		} catch (error) {
			await this._failAssignment(assignmentId, error).catch(() => undefined);
			throw error;
		}
	}

	async completeAssignment(assignmentId: string, input: CompleteAssignmentInput): Promise<CompleteAssignmentOutcome> {
		const record = await this._requireAssignment(assignmentId);
		const now = this._now();

		const result = await this._store.mutate<CompleteAssignmentOutcome>(record.missionId, (index) => {
			if (index.current?.assignmentId !== assignmentId) {
				throw new AssignmentError("ASSIGNMENT_NOT_CURRENT", `Assignment ${assignmentId} is no longer current`, {
					assignmentId,
					missionId: record.missionId,
				});
			}
			const current = index.current;
			if (current.state !== "EXECUTING") {
				throw new AssignmentError(
					"ASSIGNMENT_NOT_CURRENT",
					`Assignment ${assignmentId} is ${current.state}; only EXECUTING can be completed`,
					{ assignmentId, state: current.state },
				);
			}
			const completed: AssignmentRecord = {
				...current,
				state: "COMPLETED",
				current: false,
				completedAtMs: now,
				updatedAtMs: now,
				terminalMissionState: input.resultState,
				consumedByAttemptId: input.attemptId ?? current.consumedByAttemptId,
				consumedByExecutionId: input.executionId ?? current.consumedByExecutionId,
				reason: input.reason ?? `mission terminal ${input.resultState}`,
				revision: current.revision + 1,
			};
			return {
				kind: "write",
				records: index.records.map((r) => (r.assignmentId === assignmentId ? completed : r)),
				value: {
					assignmentId,
					state: "COMPLETED" as AssignmentState,
					terminalMissionState: input.resultState,
					record: completed,
				},
			};
		});

		return this._unwrap(result, record.missionId);
	}

	/**
	 * Honest interruption of a previously-EXECUTING assignment after a worker
	 * restart reconciliation. The mission (owned by the mission domain) is
	 * reconciled separately to INTERRUPTED; this marks the assignment's
	 * execution attempt FAILED so it is never silently re-executed and never
	 * reported as a fabricated completion.
	 */
	async interruptExecution(assignmentId: string, reason: string): Promise<AssignmentRecord> {
		const record = await this._requireAssignment(assignmentId);
		const now = this._now();

		const result = await this._store.mutate<AssignmentRecord>(record.missionId, (index) => {
			if (index.current?.assignmentId !== assignmentId) {
				throw new AssignmentError("ASSIGNMENT_NOT_CURRENT", `Assignment ${assignmentId} is no longer current`, {
					assignmentId,
					missionId: record.missionId,
				});
			}
			const current = index.current;
			if (current.state !== "EXECUTING") {
				throw new AssignmentError(
					"ASSIGNMENT_NOT_CURRENT",
					`Assignment ${assignmentId} is ${current.state}; only EXECUTING can be interrupted`,
					{ assignmentId, state: current.state },
				);
			}
			const failed: AssignmentRecord = {
				...current,
				state: "FAILED",
				current: false,
				updatedAtMs: now,
				reason,
				revision: current.revision + 1,
			};
			return {
				kind: "write",
				records: index.records.map((r) => (r.assignmentId === assignmentId ? failed : r)),
				value: failed,
			};
		});

		return this._unwrap(result, record.missionId);
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private _toSummary(record: AssignmentRecord): AssignmentSummary {
		return {
			assignmentId: record.assignmentId,
			missionId: record.missionId,
			executorId: record.executorId,
			state: record.state,
			current: record.current,
			createdAtMs: record.createdAtMs,
			updatedAtMs: record.updatedAtMs,
			assignedBy: record.assignedBy,
			acceptedAtMs: record.acceptedAtMs,
			executionStartedAtMs: record.executionStartedAtMs,
			completedAtMs: record.completedAtMs,
			releasedAtMs: record.releasedAtMs,
			supersededByAssignmentId: record.supersededByAssignmentId,
			consumedByAttemptId: record.consumedByAttemptId,
			consumedByExecutionId: record.consumedByExecutionId,
			terminalMissionState: record.terminalMissionState,
			reason: record.reason,
			executionMode: record.executionMode,
			remoteTargetId: record.remoteTargetId,
		};
	}

	private _toDetail(record: AssignmentRecord): AssignmentDetail {
		return {
			...this._toSummary(record),
			requirementsSnapshot: record.requirementsSnapshot,
			compatibilitySnapshot: record.compatibilitySnapshot,
			executorRuntimeAtAssignment: record.executorRuntimeAtAssignment,
			executionOwnerIdentity: record.executionOwnerIdentity,
		};
	}

	private _unwrap<T>(
		result: { status: "ok"; value: T } | { status: "corrupt"; diagnostic: string },
		missionId: string,
	): T {
		if (result.status === "corrupt") {
			throw new AssignmentError("ASSIGNMENT_CORRUPT", `Assignment store is corrupt for mission ${missionId}`, {
				missionId,
				diagnostic: result.diagnostic,
			});
		}
		return result.value;
	}

	private async _requireAssignment(assignmentId: string): Promise<AssignmentRecord> {
		if (!isSafeAssignmentId(assignmentId)) {
			throw new AssignmentError("INVALID_ASSIGNMENT_ID", `Unsafe assignment id: ${assignmentId}`, { assignmentId });
		}
		const loaded = await this._store.load(assignmentId);
		if (loaded.status === "missing") {
			throw new AssignmentError("ASSIGNMENT_NOT_FOUND", `Assignment not found: ${assignmentId}`, { assignmentId });
		}
		if (loaded.status === "corrupt") {
			throw new AssignmentError(
				"ASSIGNMENT_CORRUPT",
				`Assignment ${assignmentId} is corrupt: ${loaded.diagnostic}`,
				{ assignmentId, diagnostic: loaded.diagnostic },
			);
		}
		return loaded.record;
	}

	private async _requireMission(missionId: string): Promise<DurableMissionRecord> {
		const loaded = await this._missions.load(missionId);
		if (loaded.status === "missing") {
			throw new AssignmentError("MISSION_NOT_FOUND", `Mission not found: ${missionId}`, { missionId });
		}
		if (loaded.status === "corrupt") {
			throw new AssignmentError("MISSION_NOT_ASSIGNABLE", `Mission ${missionId} is corrupt: ${loaded.diagnostic}`, {
				missionId,
				diagnostic: loaded.diagnostic,
			});
		}
		return loaded.record;
	}

	private async _executorDetail(executorId: string): Promise<ExecutorDetail> {
		try {
			return await this._executors.getExecutor(executorId);
		} catch (error) {
			if (error instanceof ExecutorRegistryError && error.code === "EXECUTOR_NOT_FOUND") {
				throw new AssignmentError("EXECUTOR_NOT_FOUND", `Executor not found: ${executorId}`, { executorId });
			}
			if (error instanceof ExecutorRegistryError && error.code === "EXECUTOR_CORRUPT") {
				throw new AssignmentError("EXECUTOR_NOT_ASSIGNABLE", `Executor ${executorId} is corrupt`, { executorId });
			}
			throw error;
		}
	}

	private _evaluateAssignability(
		detail: ExecutorDetail,
		requirements: MissionRequirements | undefined,
	): AssignabilityResult {
		const capabilities = mergeExecutorCapabilities(
			detail.configuredCapabilities,
			detail.runtime?.advertisedCapabilities,
		);
		return evaluateAssignability({
			requirements,
			capabilities,
			status: detail.status,
			retired: detail.retired,
		});
	}

	private _assertAssignable(executorId: string, assignability: AssignabilityResult): void {
		if (assignability.assignable) return;
		if (!assignability.compatible) {
			throw new AssignmentError(
				"EXECUTOR_INCOMPATIBLE",
				`Executor ${executorId} is incompatible with mission requirements`,
				{ executorId, unsatisfied: assignability.compatibility.unsatisfied },
			);
		}
		if (assignability.status === "RETIRED") {
			throw new AssignmentError("EXECUTOR_RETIRED", `Executor ${executorId} is retired`, { executorId });
		}
		throw new AssignmentError(
			"EXECUTOR_OFFLINE",
			`Executor ${executorId} is not presently assignable (${assignability.status})`,
			{ executorId, status: assignability.status },
		);
	}

	private async _assertCurrentRuntime(assignment: AssignmentRecord, proof: ExecutorRuntimeProof): Promise<void> {
		if (proof.executorId !== assignment.executorId) {
			throw new AssignmentError(
				"ASSIGNMENT_RUNTIME_MISMATCH",
				`Runtime proof executor ${proof.executorId} does not match assignment executor ${assignment.executorId}`,
				{
					assignmentId: assignment.assignmentId,
					proofExecutorId: proof.executorId,
					executorId: assignment.executorId,
				},
			);
		}
		if (typeof proof.runtimeInstanceId !== "string" || proof.runtimeInstanceId.length === 0) {
			throw new AssignmentError("ASSIGNMENT_RUNTIME_MISMATCH", "runtimeInstanceId is required", {
				assignmentId: assignment.assignmentId,
			});
		}
		if (!Number.isSafeInteger(proof.runtimeEpoch) || proof.runtimeEpoch < 1) {
			throw new AssignmentError("ASSIGNMENT_RUNTIME_MISMATCH", "runtimeEpoch must be a positive integer", {
				assignmentId: assignment.assignmentId,
			});
		}

		const detail = await this._executorDetail(proof.executorId);
		if (detail.retired) {
			throw new AssignmentError("EXECUTOR_RETIRED", `Executor ${proof.executorId} is retired`, {
				executorId: proof.executorId,
			});
		}
		if (!detail.runtime) {
			throw new AssignmentError("EXECUTOR_OFFLINE", `Executor ${proof.executorId} has no active runtime`, {
				executorId: proof.executorId,
			});
		}
		if (detail.runtime.runtimeInstanceId !== proof.runtimeInstanceId || detail.runtimeEpoch !== proof.runtimeEpoch) {
			throw new AssignmentError(
				"STALE_EXECUTOR_INSTANCE",
				`Runtime proof is not authoritative for executor ${proof.executorId}`,
				{
					executorId: proof.executorId,
					authoritativeInstanceId: detail.runtime.runtimeInstanceId,
					authoritativeEpoch: detail.runtimeEpoch,
					staleInstanceId: proof.runtimeInstanceId,
					staleEpoch: proof.runtimeEpoch,
				},
			);
		}
		if (detail.status !== "ONLINE") {
			throw new AssignmentError("EXECUTOR_OFFLINE", `Executor ${proof.executorId} is not ONLINE`, {
				executorId: proof.executorId,
				status: detail.status,
			});
		}
	}

	private async _requireNonTerminalMission(missionId: string): Promise<DurableMissionRecord> {
		const record = await this._requireMission(missionId);
		if (isTerminalMissionState(record.state)) {
			throw new AssignmentError("MISSION_NOT_ASSIGNABLE", `Mission ${missionId} is terminal (${record.state})`, {
				missionId,
				state: record.state,
			});
		}
		return record;
	}

	private async _requireAcceptableMission(missionId: string): Promise<DurableMissionRecord> {
		const record = await this._requireNonTerminalMission(missionId);
		if (record.lease && isExecutionLeaseActive(record.lease, this._now())) {
			throw new AssignmentError("MISSION_ACTIVE", `Mission ${missionId} has an active execution owner`, {
				missionId,
				ownerId: record.lease.ownerId,
			});
		}
		return record;
	}

	private async _requireExecutableMission(missionId: string): Promise<DurableMissionRecord> {
		const record = await this._requireAcceptableMission(missionId);
		if (record.state !== "CREATED" && record.state !== "INTERRUPTED") {
			throw new AssignmentError(
				"MISSION_NOT_ASSIGNABLE",
				`Mission ${missionId} is ${record.state}; reconcile first`,
				{
					missionId,
					state: record.state,
				},
			);
		}
		return record;
	}

	private async _failAssignment(assignmentId: string, error: unknown): Promise<void> {
		const loaded = await this._store.load(assignmentId);
		if (loaded.status !== "ok") return;
		const record = loaded.record;
		const now = this._now();
		await this._store.mutate<void>(record.missionId, (index) => {
			if (index.current?.assignmentId !== assignmentId) return { kind: "noop", value: undefined };
			const current = index.current;
			if (current.state !== "EXECUTING") return { kind: "noop", value: undefined };
			const failed: AssignmentRecord = {
				...current,
				state: "FAILED",
				current: false,
				updatedAtMs: now,
				reason: `assigned execution failed: ${error instanceof Error ? error.message : String(error)}`,
				revision: current.revision + 1,
			};
			return {
				kind: "write",
				records: index.records.map((r) => (r.assignmentId === assignmentId ? failed : r)),
				value: undefined,
			};
		});
	}
}
