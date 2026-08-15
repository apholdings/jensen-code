/**
 * Mission Control Plane — domain DTOs and structured errors (2.9.0).
 *
 * A stable application/operator boundary over the durable mission domain. These
 * types are plain structured views: they never expose store file paths, lock
 * files, session directories, or raw evidence contents. Read models aggregate
 * durable record fields; mutation commands compose the authoritative
 * coordinator/delegator semantics below.
 */

import type { AssignmentSummary } from "../assignment/assignment-types.js";
import type { DurableMissionCoordinator } from "../mission-domain/durable-coordinator.js";
import type {
	DurableExecutionAttempt,
	DurableMissionRecord,
	DurableMissionTransition,
} from "../mission-domain/durable-store.js";
import type { HeartbeatTelemetry } from "../mission-domain/execution-heartbeat.js";
import type { MissionRequest } from "../mission-domain/mission-request.js";
import type { MissionResult } from "../mission-domain/mission-result.js";
import type { MissionState } from "../mission-domain/mission-state.js";

// =============================================================================
// Structured errors
// =============================================================================

export type MissionControlErrorCode =
	| "MISSION_NOT_FOUND"
	| "MISSION_CORRUPT"
	| "MISSION_NOT_RESUMABLE"
	| "MISSION_TERMINAL"
	| "MISSION_ACTIVE"
	| "NOT_A_DURABLE_CHILD"
	| "MISSION_TREE_CORRUPT"
	| "MISSION_CANCEL_UNSUPPORTED"
	| "MISSION_RESULT_UNAVAILABLE"
	| "EVIDENCE_NOT_FOUND";

export class MissionControlError extends Error {
	readonly code: MissionControlErrorCode;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: MissionControlErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
		super(message);
		this.name = "MissionControlError";
		this.code = code;
		this.details = Object.freeze({ ...details });
	}
}

// =============================================================================
// Ownership / lease views
// =============================================================================

export type LeaseStatus = "ACTIVE" | "EXPIRING" | "EXPIRED" | "NONE";

/**
 * The durable lease is the cross-process ownership truth. Local heartbeat
 * telemetry is process-local runtime state and is absent when inspected from
 * another process; it is never fabricated into durable ownership.
 */
export interface MissionOwnershipView {
	owned: boolean;
	ownerId?: string;
	leaseId?: string;
	fencingToken: number;
	acquiredAtMs?: number;
	renewedAtMs?: number;
	expiresAtMs?: number;
	remainingMs?: number;
	leaseStatus: LeaseStatus;
	/** Live local heartbeat telemetry, only when this process owns/knows it. */
	localRuntime?: {
		known: boolean;
		heartbeatTelemetry?: HeartbeatTelemetry;
	};
}

// =============================================================================
// Attempt views
// =============================================================================

/** One concrete execution attempt (attempt → optional executionId). */
export interface AttemptView {
	attemptId: string;
	executionId?: string;
	startedAtMs: number;
	finishedAtMs?: number;
	endReason?: DurableExecutionAttempt["endReason"];
	recovery?: DurableExecutionAttempt["recovery"];
}

export interface AttemptHistoryView {
	missionId: string;
	attempts: AttemptView[];
	currentAttemptId?: string;
	/** The authoritative terminal result belongs to this execution, when present. */
	resultExecutionId?: string;
}

// =============================================================================
// Result / evidence views
// =============================================================================

export interface MissionResultView {
	available: boolean;
	resultExecutionId?: string;
	result?: MissionResult;
}

export interface MissionEvidenceRef {
	evidenceId: string;
	/** Derived from the deterministic evidence id prefix when cheaply resolvable. */
	kind?: string;
	/** Derived source hint (sanitized) from the deterministic evidence id. */
	source?: string;
	/** Present only when an evidence archive was injected for availability checks. */
	available?: boolean;
}

// =============================================================================
// Resumability
// =============================================================================

export type ResumabilityReasonCode =
	| "MISSION_TERMINAL"
	| "MISSION_ACTIVE"
	| "MISSION_NOT_RUNNABLE_STATE"
	| "MISSING_CHILD_SESSION";

export interface Resumability {
	resumable: boolean;
	reasonCode?: ResumabilityReasonCode;
	reason?: string;
}

// =============================================================================
// Summary + detail
// =============================================================================

export interface MissionSummary {
	missionId: string;
	parentMissionId?: string;
	childSessionId?: string;
	depth: number;
	state: MissionState;
	createdAtMs: number;
	updatedAtMs: number;
	currentAttemptId?: string;
	currentExecutionId?: string;
	attemptCount: number;
	fencingToken: number;
	owned: boolean;
	leaseStatus: LeaseStatus;
	terminal: boolean;
	resultStatus?: MissionState;
	verificationStatus?: MissionResult["verification"]["status"];
	interrupted: boolean;
	resumable: boolean;
	childCount: number;
	/** Assignment designation (present only when an assignment store is wired). */
	assigned: boolean;
	currentAssignmentId?: string;
	assignedExecutorId?: string;
}

/**
 * Bounded, structured request view. The immutable `context` package can be
 * large, so it is reduced to its keys (never flattened into the operator view).
 */
export interface MissionRequestView {
	missionId: string;
	parentMissionId?: string;
	depth: number;
	objective: string;
	agent: string;
	executionMode: MissionRequest["executionMode"];
	acceptanceCriteria: readonly MissionRequest["acceptanceCriteria"][number][];
	workspaceScope?: MissionRequest["workspaceScope"];
	budget?: MissionRequest["budget"];
	capabilities?: readonly string[];
	modelPolicy?: MissionRequest["modelPolicy"];
	idempotencyKey?: string;
	childSessionId?: string;
	constraints?: readonly string[];
	contextKeys: readonly string[];
	createdAtMs: number;
}

/** Bounded checkpoint projection (no transcripts, no evidence contents). */
export interface MissionCheckpointSummary {
	objective: string;
	constraints: readonly string[];
	lastTransition?: DurableMissionTransition;
	startedAtMs?: number;
	finishedAtMs?: number;
}

export interface MissionDetail {
	summary: MissionSummary;
	request: MissionRequestView;
	currentAttempt?: AttemptView;
	ownership: MissionOwnershipView;
	result: MissionResultView;
	checkpointSummary: MissionCheckpointSummary;
	evidenceRefs: MissionEvidenceRef[];
	children: string[];
	resumability: Resumability;
	/** Current assignment designation, when an assignment store is wired. */
	assignment?: AssignmentSummary;
}

// =============================================================================
// Tree
// =============================================================================

export interface MissionTreeNode {
	missionId: string;
	state: MissionState;
	depth: number;
	childSessionId?: string;
	summary: {
		attemptCount: number;
		terminal: boolean;
		resultStatus?: MissionState;
		verificationStatus?: MissionResult["verification"]["status"];
	};
	ownership: {
		owned: boolean;
		leaseId?: string;
		fencingToken: number;
		leaseStatus: LeaseStatus;
	};
	children: MissionTreeNode[];
}

// =============================================================================
// Listing
// =============================================================================

export type MissionListSort = "createdAtMs" | "updatedAtMs" | "missionId";
export type MissionListDirection = "asc" | "desc";

export interface MissionListFilter {
	state?: MissionState;
	parentMissionId?: string;
	terminal?: boolean;
	interrupted?: boolean;
	owned?: boolean;
	resumable?: boolean;
	depth?: number;
}

export interface MissionListOptions {
	filter?: MissionListFilter;
	sort?: MissionListSort;
	direction?: MissionListDirection;
	limit?: number;
	offset?: number;
}

export interface MissionListResult {
	entries: MissionSummary[];
	/** Corrupt records are surfaced structurally, never folded into healthy state. */
	corrupt: { missionId: string; diagnostic: string }[];
}

// =============================================================================
// Mutation outcomes
// =============================================================================

export interface MissionControlResumeOutcome {
	missionId: string;
	parentMissionId?: string;
	childSessionId?: string;
	attemptId: string;
	executionId?: string;
	missionState: MissionState;
	fencingToken: number;
	success: boolean;
	result: MissionResult;
	record: DurableMissionRecord;
	heartbeatTelemetry?: HeartbeatTelemetry;
}

export type MissionCancellationStatus = "cancelled" | "cancel_requested" | "not_running" | "remote_owner" | "terminal";

export interface MissionCancellationView {
	missionId: string;
	status: MissionCancellationStatus;
	executorConfirmedStopped: boolean;
	requestedAtMs?: number;
	reason?: string;
}

// =============================================================================
// Service dependencies
// =============================================================================

export interface BuildResumeLaunchInput {
	request: DurableMissionRecord["request"];
	resumePrompt: string;
	childSessionId: string;
}

/** Maps a resume to the concrete child CLI launch (mirrors ProcessMissionLaunch). */
export type BuildResumeLaunch = (input: BuildResumeLaunchInput) => {
	command: string;
	args: readonly string[];
	cwd: string;
};

/** Local live execution retained by the control plane for heartbeat + cancel. */
export interface MissionControlActiveExecution {
	coordinator: DurableMissionCoordinator;
	resume: Promise<DurableMissionRecord>;
}
