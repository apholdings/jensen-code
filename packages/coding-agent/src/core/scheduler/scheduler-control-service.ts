/**
 * Scheduler Control Service (2.12.0).
 *
 * The authoritative application/operator boundary over durable scheduling
 * intent. It consumes the existing primitives — DurableMissionStore for mission
 * lifecycle, ExecutorControlService for executor liveness, and
 * AssignmentControlService for designation — and produces a durable Assignment
 * via a deterministic policy. It never reimplements those primitives.
 *
 *   - `enqueueIntent`  records pending scheduling intent for a mission.
 *   - `cancelIntent`   withdraws a pending/unschedulable intent.
 *   - `previewTick`    read-only deterministic decision preview (no mutation).
 *   - `runTick`        runs one scheduler pass: eligible missions -> assignable
 *                      executors -> deterministic policy -> durable assignment.
 *
 * The output of scheduling is an Assignment. Execution, worker daemons, remote
 * invocation, acceptance, execution start, live migration, and resource
 * reservation are explicitly out of scope and remain separate authority domains.
 */

import type { AssignmentControlService } from "../assignment/assignment-control-service.js";
import type { AssignmentRecord } from "../assignment/assignment-types.js";
import { evaluateAssignability, toAssignabilityStatus } from "../assignment/compatibility.js";
import type { CapabilityRouteEvaluator, RouteCandidate, RoutingEvaluation } from "../capability-routing/route-types.js";
import type { ExecutorControlService, ExecutorSummary } from "../executor-registry/index.js";
import {
	type DurableMissionRecord,
	type DurableMissionStore,
	isSafeMissionId,
} from "../mission-domain/durable-store.js";
import { isExecutionLeaseActive } from "../mission-domain/execution-lease.js";
import { isTerminalMissionState } from "../mission-domain/mission-state.js";
import { chooseExecutor, type ExecutorCandidate, orderPendingIntents } from "./policy.js";
import { createSchedulingIntentRecord, type SchedulingIntentStore } from "./scheduler-store.js";
import {
	DEFAULT_SCHEDULING_POLICY,
	type EnqueueSchedulingIntentInput,
	type EnqueueSchedulingIntentOutcome,
	type EnqueueSchedulingIntentStatus,
	type ExecutorEligibility,
	intentIdForMission,
	isSafeIntentId,
	newSchedulingTickId,
	type SchedulingDecision,
	SchedulingError,
	type SchedulingIntentDetail,
	type SchedulingIntentListOptions,
	type SchedulingIntentListResult,
	type SchedulingIntentRecord,
	type SchedulingIntentSummary,
	type SchedulingPolicy,
	type SchedulingTickResult,
} from "./scheduler-types.js";

export interface SchedulerControlServiceOptions {
	store: SchedulingIntentStore;
	missions: DurableMissionStore;
	executors: ExecutorControlService;
	assignments: AssignmentControlService;
	policy?: SchedulingPolicy;
	now?: () => number;
	/** Intent id factory; default is the deterministic per-mission id. */
	intentIdFactory?: (missionId: string) => string;
	tickIdFactory?: () => string;
	/**
	 * Optional Capability Router. When wired, the scheduler derives executor
	 * eligibility from the router's route candidates (execution mode, remote
	 * target health) instead of bare executor capability+ONLINE matching. The
	 * router reports feasibility; the scheduler still selects among eligible
	 * candidates via policy and creates the durable Assignment.
	 */
	router?: CapabilityRouteEvaluator;
}

export class SchedulerControlService {
	private readonly _store: SchedulingIntentStore;
	private readonly _missions: DurableMissionStore;
	private readonly _executors: ExecutorControlService;
	private readonly _assignments: AssignmentControlService;
	private readonly _policy: SchedulingPolicy;
	private readonly _now: () => number;
	private readonly _intentIdFactory: (missionId: string) => string;
	private readonly _tickIdFactory: () => string;
	private readonly _router?: CapabilityRouteEvaluator;

	constructor(options: SchedulerControlServiceOptions) {
		this._store = options.store;
		this._missions = options.missions;
		this._executors = options.executors;
		this._assignments = options.assignments;
		this._policy = options.policy ?? DEFAULT_SCHEDULING_POLICY;
		this._now = options.now ?? (() => Date.now());
		this._intentIdFactory = options.intentIdFactory ?? ((missionId) => intentIdForMission(missionId));
		this._tickIdFactory = options.tickIdFactory ?? (() => newSchedulingTickId());
		this._router = options.router;
	}

	get store(): SchedulingIntentStore {
		return this._store;
	}

	// =========================================================================
	// Read model
	// =========================================================================

	async listIntents(options: SchedulingIntentListOptions = {}): Promise<SchedulingIntentListResult> {
		const { records, corrupt } = await this._store.listRecords();

		let entries = records.map((record) => this._toSummary(record));
		const filter = options.filter;
		if (filter) {
			entries = entries.filter((entry) => {
				if (filter.missionId !== undefined && entry.missionId !== filter.missionId) return false;
				if (filter.state !== undefined && entry.state !== filter.state) return false;
				return true;
			});
		}

		const sort = options.sort ?? "enqueuedAtMs";
		const direction = options.direction ?? "asc";
		entries.sort((a, b) => {
			let cmp: number;
			if (sort === "intentId") cmp = a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0;
			else cmp = a[sort] - b[sort] || (a.intentId < b.intentId ? -1 : 1);
			return direction === "desc" ? -cmp : cmp;
		});

		const offset = options.offset ?? 0;
		if (offset > 0) entries = entries.slice(offset);
		if (options.limit !== undefined) entries = entries.slice(0, options.limit);

		return { entries, corrupt };
	}

	async getIntent(intentId: string): Promise<SchedulingIntentDetail> {
		const record = await this._requireIntent(intentId);
		return this._toDetail(record);
	}

	async getIntentForMission(missionId: string): Promise<SchedulingIntentDetail> {
		return this.getIntent(this._intentIdFor(missionId));
	}

	// =========================================================================
	// Mutations
	// =========================================================================

	async enqueueIntent(
		missionId: string,
		input: EnqueueSchedulingIntentInput = {},
	): Promise<EnqueueSchedulingIntentOutcome> {
		this._assertMissionId(missionId);
		const intentId = this._intentIdFor(missionId);
		const now = input.now ?? this._now();

		// Fail fast on a terminal mission; scheduling a terminal mission is always
		// unschedulable, so enqueueing it is an operator error rather than a queue
		// entry that would immediately fail on the next tick.
		const mission = await this._requireMission(missionId);
		if (isTerminalMissionState(mission.state)) {
			throw new SchedulingError("MISSION_TERMINAL", `Mission ${missionId} is terminal (${mission.state})`, {
				missionId,
				state: mission.state,
			});
		}

		const record = createSchedulingIntentRecord({
			intentId,
			missionId,
			requirements: input.requirements,
			priority: input.priority ?? 0,
			now,
		});

		const created = await this._store.create(record);
		if (created.status === "created") {
			return { intentId, missionId, state: "PENDING", status: "created", record };
		}

		const reopened = await this._store.mutate<{
			status: EnqueueSchedulingIntentStatus;
			record: SchedulingIntentRecord;
		}>(intentId, (current) => {
			if (current.state === "PENDING") {
				return { kind: "noop", value: { status: "idempotent", record: current } };
			}
			if (current.state === "ASSIGNED") {
				throw new SchedulingError(
					"INTENT_ALREADY_ASSIGNED",
					`Mission ${missionId} is already scheduled (${current.assignmentId ?? "unknown assignment"})`,
					{ missionId, assignmentId: current.assignmentId },
				);
			}
			const next: SchedulingIntentRecord = {
				...current,
				state: "PENDING",
				requirements: input.requirements ?? current.requirements,
				priority: input.priority ?? current.priority,
				enqueuedAtMs: now,
				updatedAtMs: now,
				assignmentId: undefined,
				unschedulableReason: undefined,
				revision: current.revision + 1,
			};
			return { kind: "write", next, value: { status: "reopened", record: next } };
		});
		const outcome = this._unwrapMutation(reopened, intentId);
		return {
			intentId,
			missionId,
			state: outcome.record.state,
			status: outcome.status,
			record: outcome.record,
		};
	}

	async cancelIntent(missionId: string): Promise<SchedulingIntentRecord> {
		this._assertMissionId(missionId);
		const intentId = this._intentIdFor(missionId);
		const now = this._now();

		const assignedCurrent = await this._assignments.getCurrentForMission(missionId);
		const result = await this._store.mutate(intentId, (current) => {
			if (current.state === "CANCELLED") return { kind: "noop", value: current };
			if (current.state === "ASSIGNED" && assignedCurrent?.assignmentId === current.assignmentId) {
				throw new SchedulingError(
					"INTENT_ALREADY_ASSIGNED",
					`Intent ${intentId} is already ASSIGNED; release the assignment instead of cancelling the intent`,
					{ intentId, assignmentId: current.assignmentId },
				);
			}
			const next: SchedulingIntentRecord = {
				...current,
				state: "CANCELLED",
				updatedAtMs: now,
				unschedulableReason: undefined,
				assignmentId: undefined,
				revision: current.revision + 1,
			};
			return { kind: "write", next, value: next };
		});

		return this._unwrapMutation(result, intentId);
	}

	// =========================================================================
	// Scheduler runs
	// =========================================================================

	/** Read-only deterministic decision preview. Never mutates any store. */
	async previewTick(options: { now?: number } = {}): Promise<SchedulingTickResult> {
		return this._tick(true, options);
	}

	/** Run one scheduler pass and persist decisions. */
	async runTick(options: { now?: number } = {}): Promise<SchedulingTickResult> {
		return this._tick(false, options);
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private async _tick(dryRun: boolean, options: { now?: number }): Promise<SchedulingTickResult> {
		const startedAtMs = options.now ?? this._now();
		const runId = this._tickIdFactory();

		const { records: allIntents, corrupt } = await this._store.listRecords();
		const pending = orderPendingIntents(allIntents.filter((intent) => intent.state === "PENDING"));

		const executorList = await this._executors.listExecutors();
		const executors = [...executorList.entries].sort((a, b) =>
			a.executorId < b.executorId ? -1 : a.executorId > b.executorId ? 1 : 0,
		);

		const currentAssignments = await this._assignments.listCurrentAssignments();
		const counts = new Map<string, number>();
		for (const record of currentAssignments.values()) {
			counts.set(record.executorId, (counts.get(record.executorId) ?? 0) + 1);
		}

		const decisions: SchedulingDecision[] = [];
		let assignmentsCreated = 0;
		let intentsAssigned = 0;
		let intentsUnschedulable = 0;

		for (const intent of pending) {
			let decision = await this._decideForIntent(intent, executors, currentAssignments, counts);

			if (decision.decision === "RECONCILE") {
				if (!dryRun) await this._markAssigned(intent.intentId, decision.assignmentId ?? "");
				decisions.push(decision);
				intentsAssigned++;
				continue;
			}

			if (decision.decision === "UNSCHEDULABLE") {
				if (!dryRun) await this._markUnschedulable(intent.intentId, decision.reason ?? "unschedulable");
				decisions.push(decision);
				intentsUnschedulable++;
				continue;
			}

			// ASSIGN
			if (dryRun) {
				if (decision.executorId) {
					counts.set(decision.executorId, (counts.get(decision.executorId) ?? 0) + 1);
				}
				decisions.push(decision);
				intentsAssigned++;
				assignmentsCreated++;
				continue;
			}

			try {
				const outcome = await this._assignments.assignMission({
					missionId: intent.missionId,
					executorId: decision.executorId ?? "",
					requirements: intent.requirements,
					assignedBy: "scheduler",
					executionMode: decision.executionMode,
					remoteTargetId: decision.remoteTargetId,
				});
				if (decision.executorId) {
					counts.set(decision.executorId, (counts.get(decision.executorId) ?? 0) + 1);
				}
				await this._markAssigned(intent.intentId, outcome.assignmentId);
				decisions.push({ ...decision, assignmentId: outcome.assignmentId });
				intentsAssigned++;
				assignmentsCreated++;
			} catch (error) {
				decision = await this._reconcileAssignmentRace(intent, error);
				if (decision.decision === "RECONCILE") {
					await this._markAssigned(intent.intentId, decision.assignmentId ?? "");
					decisions.push(decision);
					intentsAssigned++;
				} else {
					await this._markUnschedulable(intent.intentId, decision.reason ?? "unschedulable");
					decisions.push(decision);
					intentsUnschedulable++;
				}
			}
		}

		return {
			runId,
			dryRun,
			policy: this._policy,
			startedAtMs,
			finishedAtMs: this._now(),
			decisions,
			assignmentsCreated,
			intentsAssigned,
			intentsUnschedulable,
			corrupt,
		};
	}

	/**
	 * Compute a deterministic decision for one intent without side effects.
	 * Mission-level unschedulability (missing/corrupt/terminal/active owner)
	 * is distinguished from executor-level unschedulability (no assignable
	 * executor).
	 */
	private async _decideForIntent(
		intent: SchedulingIntentRecord,
		executors: ExecutorSummary[],
		currentAssignments: Map<string, AssignmentRecord>,
		counts: Map<string, number>,
	): Promise<SchedulingDecision> {
		const mission = await this._missions.load(intent.missionId);
		if (mission.status === "missing") {
			return {
				intentId: intent.intentId,
				missionId: intent.missionId,
				decision: "UNSCHEDULABLE",
				reason: "mission missing",
				eligibility: [],
			};
		}
		if (mission.status === "corrupt") {
			return {
				intentId: intent.intentId,
				missionId: intent.missionId,
				decision: "UNSCHEDULABLE",
				reason: `mission corrupt: ${mission.diagnostic}`,
				eligibility: [],
			};
		}
		const record = mission.record;
		if (isTerminalMissionState(record.state)) {
			return {
				intentId: intent.intentId,
				missionId: intent.missionId,
				decision: "UNSCHEDULABLE",
				reason: `mission terminal (${record.state})`,
				eligibility: [],
			};
		}
		if (record.lease && isExecutionLeaseActive(record.lease, this._now())) {
			return {
				intentId: intent.intentId,
				missionId: intent.missionId,
				decision: "UNSCHEDULABLE",
				reason: "mission has an active execution owner",
				eligibility: [],
			};
		}

		const existing = currentAssignments.get(intent.missionId);
		if (existing) {
			return {
				intentId: intent.intentId,
				missionId: intent.missionId,
				decision: "RECONCILE",
				assignmentId: existing.assignmentId,
				eligibility: [],
			};
		}

		return await this._decideExecutor(intent, executors, counts);
	}

	private async _decideExecutor(
		intent: SchedulingIntentRecord,
		executors: ExecutorSummary[],
		counts: Map<string, number>,
	): Promise<SchedulingDecision> {
		if (this._router) return this._decideExecutorRouted(intent, counts);
		return this._decideExecutorLocal(intent, executors, counts);
	}

	/**
	 * Routed executor decision: eligibility comes from the Capability Router's
	 * route candidates (execution mode + remote target health are honored), while
	 * the deterministic Scheduler policy still selects among eligible candidates.
	 */
	private async _decideExecutorRouted(
		intent: SchedulingIntentRecord,
		counts: Map<string, number>,
	): Promise<SchedulingDecision> {
		const evaluation = await this._router!.evaluate({
			requirements: intent.requirements ?? {},
			missionId: intent.missionId,
		});
		const byId = new Map<string, RouteCandidate>(
			evaluation.candidates.map((candidate) => [candidate.executorId, candidate]),
		);

		const eligibility: ExecutorEligibility[] = [];
		const candidates: ExecutorCandidate[] = [];

		for (const candidate of evaluation.candidates) {
			eligibility.push({
				executorId: candidate.executorId,
				status: candidate.workerStatus,
				compatible: candidate.capabilityMatch,
				assignable: candidate.eligible,
				chosen: false,
				reason: candidate.eligible ? undefined : candidate.rejectionReasons.join("; "),
				executionMode: candidate.executionMode,
				remoteTargetId: candidate.remoteTargetId,
				targetHealth: candidate.targetHealth,
				routabilityStatus: candidate.status,
				preferenceScore: candidate.preferenceScore,
				preferenceReasons: candidate.preferenceReasons,
			});
			if (candidate.eligible) {
				candidates.push({
					executorId: candidate.executorId,
					status: candidate.workerStatus,
					assignability: {
						compatible: candidate.capabilityMatch,
						assignable: candidate.eligible,
						status: toAssignabilityStatus(candidate.workerStatus),
						compatibility: {
							compatible: candidate.capabilityMatch,
							satisfied: candidate.matchedRequirements,
							unsatisfied: candidate.rejectedRequirements,
							warnings: [],
						},
					},
					currentAssignmentCount: counts.get(candidate.executorId) ?? 0,
				});
			}
		}

		const chosen = chooseExecutor(candidates, this._policy.mode);
		if (!chosen) {
			return {
				intentId: intent.intentId,
				missionId: intent.missionId,
				decision: "UNSCHEDULABLE",
				reason: this._unschedulableReason(evaluation),
				eligibility,
			};
		}

		const marked = eligibility.map((entry) =>
			entry.executorId === chosen.executorId ? { ...entry, chosen: true } : entry,
		);
		const chosenCandidate = byId.get(chosen.executorId);
		return {
			intentId: intent.intentId,
			missionId: intent.missionId,
			decision: "ASSIGN",
			executorId: chosen.executorId,
			executionMode: chosenCandidate?.executionMode,
			remoteTargetId: chosenCandidate?.remoteTargetId,
			eligibility: marked,
		};
	}

	private _unschedulableReason(evaluation: RoutingEvaluation): string {
		if (evaluation.candidates.length === 0) return "no execution routes available";
		const summary = evaluation.candidates
			.map((candidate) => `${candidate.executorId}=${candidate.status}`)
			.join(", ");
		return `no eligible execution route (${summary})`;
	}

	private _decideExecutorLocal(
		intent: SchedulingIntentRecord,
		executors: ExecutorSummary[],
		counts: Map<string, number>,
	): SchedulingDecision {
		const eligibility: ExecutorEligibility[] = [];
		const candidates: ExecutorCandidate[] = [];

		for (const summary of executors) {
			const assignability = evaluateAssignability({
				requirements: intent.requirements,
				capabilities: summary.capabilities,
				status: toAssignabilityStatus(summary.status),
				retired: summary.retired,
			});
			eligibility.push({
				executorId: summary.executorId,
				status: summary.status,
				compatible: assignability.compatible,
				assignable: assignability.assignable,
				chosen: false,
				reason: assignability.assignable ? undefined : assignability.reason,
			});
			if (assignability.assignable) {
				candidates.push({
					executorId: summary.executorId,
					status: summary.status,
					assignability,
					currentAssignmentCount: counts.get(summary.executorId) ?? 0,
				});
			}
		}

		const chosen = chooseExecutor(candidates, this._policy.mode);
		if (!chosen) {
			return {
				intentId: intent.intentId,
				missionId: intent.missionId,
				decision: "UNSCHEDULABLE",
				reason: `no assignable executor among ${eligibility.length} considered`,
				eligibility,
			};
		}

		const marked = eligibility.map((entry) =>
			entry.executorId === chosen.executorId ? { ...entry, chosen: true } : entry,
		);
		return {
			intentId: intent.intentId,
			missionId: intent.missionId,
			decision: "ASSIGN",
			executorId: chosen.executorId,
			eligibility: marked,
		};
	}

	/** After an assign race, re-read the current assignment to reconcile honestly. */
	private async _reconcileAssignmentRace(intent: SchedulingIntentRecord, error: unknown): Promise<SchedulingDecision> {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: undefined;
		const current = await this._assignments.getCurrentForMission(intent.missionId);
		if (current) {
			return {
				intentId: intent.intentId,
				missionId: intent.missionId,
				decision: "RECONCILE",
				assignmentId: current.assignmentId,
				eligibility: [],
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			intentId: intent.intentId,
			missionId: intent.missionId,
			decision: "UNSCHEDULABLE",
			reason: `assignment failed${code ? ` (${code})` : ""}: ${message}`,
			eligibility: [],
		};
	}

	private async _markAssigned(intentId: string, assignmentId: string): Promise<void> {
		const now = this._now();
		const result = await this._store.mutate(intentId, (current) => {
			if (current.state !== "PENDING") return { kind: "noop", value: undefined };
			const next: SchedulingIntentRecord = {
				...current,
				state: "ASSIGNED",
				assignmentId,
				unschedulableReason: undefined,
				updatedAtMs: now,
				revision: current.revision + 1,
			};
			return { kind: "write", next, value: undefined };
		});
		this._unwrapTransition(result, intentId);
	}

	private async _markUnschedulable(intentId: string, reason: string): Promise<void> {
		const now = this._now();
		const result = await this._store.mutate(intentId, (current) => {
			if (current.state !== "PENDING") return { kind: "noop", value: undefined };
			const next: SchedulingIntentRecord = {
				...current,
				state: "UNSCHEDULABLE",
				assignmentId: undefined,
				unschedulableReason: reason,
				updatedAtMs: now,
				revision: current.revision + 1,
			};
			return { kind: "write", next, value: undefined };
		});
		this._unwrapTransition(result, intentId);
	}

	private _unwrapTransition(
		result:
			| { status: "ok"; value: unknown }
			| { status: "missing" }
			| { status: "corrupt"; intentId: string; diagnostic: string },
		intentId: string,
	): void {
		// Missing means the intent was removed concurrently; the transition is
		// simply skipped. Corrupt is surfaced, never silently folded.
		if (result.status === "missing") return;
		if (result.status === "corrupt") {
			throw new SchedulingError("INTENT_CORRUPT", `Intent ${intentId} is corrupt: ${result.diagnostic}`, {
				intentId,
				diagnostic: result.diagnostic,
			});
		}
	}

	private _intentIdFor(missionId: string): string {
		this._assertMissionId(missionId);
		const intentId = this._intentIdFactory(missionId);
		if (!isSafeIntentId(intentId)) {
			throw new SchedulingError("INVALID_INTENT_ID", `Intent id factory produced an unsafe id: ${intentId}`, {
				missionId,
				intentId,
			});
		}
		return intentId;
	}

	private _requireIntent(intentId: string): Promise<SchedulingIntentRecord> {
		if (!isSafeIntentId(intentId)) {
			throw new SchedulingError("INVALID_INTENT_ID", `Unsafe intent id: ${intentId}`, { intentId });
		}
		return this._store.load(intentId).then((loaded) => {
			if (loaded.status === "missing") {
				throw new SchedulingError("INTENT_NOT_FOUND", `Intent not found: ${intentId}`, { intentId });
			}
			if (loaded.status === "corrupt") {
				throw new SchedulingError("INTENT_CORRUPT", `Intent ${intentId} is corrupt: ${loaded.diagnostic}`, {
					intentId,
					diagnostic: loaded.diagnostic,
				});
			}
			return loaded.record;
		});
	}

	private async _requireMission(missionId: string): Promise<DurableMissionRecord> {
		this._assertMissionId(missionId);
		const loaded = await this._missions.load(missionId);
		if (loaded.status === "missing") {
			throw new SchedulingError("MISSION_NOT_FOUND", `Mission not found: ${missionId}`, { missionId });
		}
		if (loaded.status === "corrupt") {
			throw new SchedulingError("MISSION_CORRUPT", `Mission ${missionId} is corrupt: ${loaded.diagnostic}`, {
				missionId,
				diagnostic: loaded.diagnostic,
			});
		}
		return loaded.record;
	}

	private _assertMissionId(missionId: string): void {
		if (!isSafeMissionId(missionId)) {
			throw new SchedulingError("INVALID_MISSION_ID", `Unsafe mission id: ${missionId}`, { missionId });
		}
	}

	private _unwrapMutation<T>(
		result:
			| { status: "ok"; value: T }
			| { status: "missing" }
			| { status: "corrupt"; intentId: string; diagnostic: string },
		intentId: string,
	): T {
		if (result.status === "missing") {
			throw new SchedulingError("INTENT_NOT_FOUND", `Intent not found: ${intentId}`, { intentId });
		}
		if (result.status === "corrupt") {
			throw new SchedulingError("INTENT_CORRUPT", `Intent ${intentId} is corrupt: ${result.diagnostic}`, {
				intentId,
				diagnostic: result.diagnostic,
			});
		}
		return result.value;
	}

	private _toSummary(record: SchedulingIntentRecord): SchedulingIntentSummary {
		return {
			intentId: record.intentId,
			missionId: record.missionId,
			state: record.state,
			priority: record.priority,
			enqueuedAtMs: record.enqueuedAtMs,
			createdAtMs: record.createdAtMs,
			updatedAtMs: record.updatedAtMs,
			assignmentId: record.assignmentId,
			unschedulableReason: record.unschedulableReason,
		};
	}

	private _toDetail(record: SchedulingIntentRecord): SchedulingIntentDetail {
		return { ...this._toSummary(record), requirements: record.requirements };
	}
}
