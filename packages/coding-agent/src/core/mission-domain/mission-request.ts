/**
 * First-Class Mission Request (2.3.0).
 *
 * The immutable declared work contract needed to launch a mission. It is
 * executor-independent and provider-independent: a request does not mention a
 * process, a CLI, or a transport. A child mission knows its parent through
 * explicit structured identity (`parentMissionId` + derived `depth`), never
 * through PID, prompt text, or ephemeral process state.
 */

import { randomUUID } from "node:crypto";
import type { VerificationSpec } from "../reliability/types.js";

// =============================================================================
// Component types
// =============================================================================

/**
 * Execution mode. Provider/executor-independent. These values intentionally
 * align with the subagent configuration layer (`SubagentExecutionMode`) without
 * importing that layer: the domain primitive must not depend on agent config.
 */
export type MissionExecutionMode = "observe" | "plan" | "execute";

export interface MissionAcceptanceCriterion {
	/** Stable criterion id, unique within the request. */
	id: string;
	description: string;
	/**
	 * Deterministic verification for this criterion. When present the criterion
	 * can be satisfied only by authoritative evidence (Reliability Kernel).
	 * When absent the criterion is descriptive and cannot yet be mapped to a
	 * MissionRuntime contract (mapping is rejected explicitly, never fabricated).
	 */
	verification?: VerificationSpec;
}

export interface MissionWorkspaceScope {
	/** Absolute working directory that bounds the mission. */
	cwd: string;
	/** Optional explicit allowed relative paths (defense in depth). */
	allowedPaths?: readonly string[];
}

export interface MissionBudget {
	maxModelTurns?: number;
	maxToolCalls?: number;
	maxWallTimeMs?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxCostUsd?: number;
	maxAffectedFiles?: number;
}

export interface MissionModelPolicy {
	provider: string;
	model: string;
}

export type MissionWorkspaceAccess = "READ_ONLY" | "WRITE";
export type MissionOrchestrationNodeKind = "DIRECT" | "CHILD" | "SYNTHESIS" | "REVIEW" | "VERIFICATION";
export type MissionOrchestrationNodeRequirement = "REQUIRED" | "OPTIONAL" | "VERIFICATION_GATING";

/** Durable provenance for a mission materialized from an orchestration plan. */
export interface MissionOrchestrationMetadata {
	orchestrationId: string;
	planRevision: number;
	nodeId: string;
	role: string;
	nodeKind: MissionOrchestrationNodeKind;
	requirement: MissionOrchestrationNodeRequirement;
	workspaceAccess: MissionWorkspaceAccess;
	independenceReason?: string;
	/** Scheduler-facing dependency criticality derived from the plan DAG. */
	dependencyCriticality?: number;
	priority?: number;
	verification?: boolean;
}

/**
 * Typed parent orchestration execution contract.
 *
 * Present only on a mission that OWNS an orchestration plan it must drive to
 * completion (the parent side; `orchestration` above is the child side). It
 * is executor-independent and provider-independent, like the rest of the
 * request: it names the plan identity and the child execution authority,
 * never a process, a port instance, or a PID. The durable request names the
 * authority; the runtime (orchestration layer) resolves the name to an
 * `OrchestrationChildExecutionPort` instance.
 */
export interface MissionOrchestrationExecution {
	/** Identity of the orchestration plan this mission owns and must execute. */
	orchestrationId: string;
	/**
	 * Stable identity of the child execution authority for this orchestration.
	 * Required: a parent orchestration execution without a named child
	 * execution authority is rejected, never defaulted.
	 */
	childExecutionAuthority: string;
}

// =============================================================================
// MissionRequest
// =============================================================================

export interface MissionRequest {
	/** Stable canonical mission identity. Never derived from PID. */
	readonly missionId: string;
	/** Explicit structured parent identity; absent only for a root mission. */
	readonly parentMissionId?: string;
	/** Structural recursion depth: 0 for root, parentDepth + 1 for a child. */
	readonly depth: number;
	/** Declared objective (work contract). */
	readonly objective: string;
	/** Canonical agent/role policy reference (e.g. "worker", "cavecrew-builder"). */
	readonly agent: string;
	readonly executionMode: MissionExecutionMode;
	/** Acceptance criteria. Required for a governed mission. */
	readonly acceptanceCriteria: readonly MissionAcceptanceCriterion[];
	readonly workspaceScope?: MissionWorkspaceScope;
	readonly budget?: MissionBudget;
	readonly capabilities?: readonly string[];
	readonly modelPolicy?: MissionModelPolicy;
	/**
	 * Optional idempotency/deduplication identity. When present it is a stable
	 * caller-supplied key independent of the generated `missionId`.
	 */
	readonly idempotencyKey?: string;
	/**
	 * Durable child AgentSession identity. Allocated BEFORE external execution
	 * and immutable for the life of the mission. A delegated child mission binds
	 * to exactly one AgentSession; explicit resume restores this exact session
	 * rather than allocating a replacement. Never PID-derived.
	 */
	readonly childSessionId?: string;
	/**
	 * Inherited operational constraints (parent + user policy). Durable so an
	 * interrupted + resumed child retains its guardrails without reconstructing
	 * them from prompt prose.
	 */
	readonly constraints?: readonly string[];
	/** Immutable reference/context package for the mission. */
	readonly context?: Readonly<Record<string, unknown>>;
	/** Orchestration metadata for a child mission; execution remains owned by Mission/Scheduler. */
	readonly orchestration?: MissionOrchestrationMetadata;
	/**
	 * Typed parent orchestration execution contract. Present only on a mission
	 * that owns an orchestration plan it must drive; names the plan identity
	 * and the child execution authority. Absent for children and for missions
	 * without orchestration.
	 */
	readonly orchestrationExecution?: MissionOrchestrationExecution;
	readonly createdAtMs: number;
}

// =============================================================================
// Factory
// =============================================================================

export interface CreateMissionRequestInput {
	missionId?: string;
	/** Parent identity used to derive `parentMissionId` and `depth` structurally. */
	parent?: { missionId: string; depth: number };
	objective: string;
	agent: string;
	executionMode: MissionExecutionMode;
	acceptanceCriteria: readonly MissionAcceptanceCriterion[];
	workspaceScope?: MissionWorkspaceScope;
	budget?: MissionBudget;
	capabilities?: readonly string[];
	modelPolicy?: MissionModelPolicy;
	idempotencyKey?: string;
	childSessionId?: string;
	constraints?: readonly string[];
	context?: Readonly<Record<string, unknown>>;
	orchestration?: MissionOrchestrationMetadata;
	orchestrationExecution?: MissionOrchestrationExecution;
	/** Timestamp override for deterministic construction (defaults to now). */
	now?: number;
}

/**
 * Build a canonical MissionRequest. If no `missionId` is supplied a stable
 * UUID-based id is generated (never PID-derived). Depth is derived from the
 * parent's depth so parenthood cannot be forged independently of depth.
 */
export function createMissionRequest(input: CreateMissionRequestInput): MissionRequest {
	const missionId = input.missionId ?? newMissionId();
	const parentMissionId = input.parent?.missionId;
	const depth = input.parent ? input.parent.depth + 1 : 0;

	return Object.freeze({
		missionId,
		parentMissionId,
		depth,
		objective: input.objective,
		agent: input.agent,
		executionMode: input.executionMode,
		acceptanceCriteria: Object.freeze([...input.acceptanceCriteria]),
		workspaceScope: input.workspaceScope ? Object.freeze({ ...input.workspaceScope }) : undefined,
		budget: input.budget ? Object.freeze({ ...input.budget }) : undefined,
		capabilities: input.capabilities ? Object.freeze([...input.capabilities]) : undefined,
		modelPolicy: input.modelPolicy ? Object.freeze({ ...input.modelPolicy }) : undefined,
		idempotencyKey: input.idempotencyKey,
		childSessionId: input.childSessionId,
		constraints: input.constraints ? Object.freeze([...input.constraints]) : undefined,
		context: input.context ? Object.freeze({ ...input.context }) : undefined,
		orchestration: input.orchestration ? Object.freeze({ ...input.orchestration }) : undefined,
		orchestrationExecution: input.orchestrationExecution
			? Object.freeze({ ...input.orchestrationExecution })
			: undefined,
		createdAtMs: input.now ?? Date.now(),
	});
}

/** Stable canonical mission id. UUID-based, never PID-derived. */
export function newMissionId(): string {
	return `mission_${randomUUID()}`;
}

/** Stable durable child AgentSession id. UUID-based, never PID-derived. */
export function newChildSessionId(): string {
	return `child_${randomUUID()}`;
}

/** A child session id is an opaque path-safe identity (used as a session header id). */
export function isSafeChildSessionId(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
}

// =============================================================================
// Validation
// =============================================================================

export type MissionRequestValidationError =
	| "MISSING_MISSION_ID"
	| "UNTRIMMED_MISSION_ID"
	| "NEGATIVE_DEPTH"
	| "PARENT_WITHOUT_DEPTH"
	| "ROOT_DEPTH_MISMATCH"
	| "MISSING_OBJECTIVE"
	| "MISSING_AGENT"
	| "INVALID_EXECUTION_MODE"
	| "DUPLICATE_CRITERION_ID"
	| "UNSAFE_CHILD_SESSION_ID"
	| "INVALID_CONSTRAINTS"
	| "INVALID_ORCHESTRATION_METADATA"
	| "INVALID_ORCHESTRATION_EXECUTION";

export type MissionRequestValidationResult =
	| { valid: true; request: MissionRequest }
	| { valid: false; errors: MissionRequestValidationError[] };

const EXECUTION_MODES: ReadonlySet<string> = new Set<MissionExecutionMode>(["observe", "plan", "execute"]);

/**
 * Validate a MissionRequest against the domain invariants. Rejects malformed
 * requests explicitly; never derives identity from anything except structured
 * fields.
 */
export function validateMissionRequest(request: MissionRequest): MissionRequestValidationResult {
	const errors: MissionRequestValidationError[] = [];

	if (typeof request.missionId !== "string" || request.missionId.trim().length === 0) {
		errors.push("MISSING_MISSION_ID");
	} else if (request.missionId !== request.missionId.trim()) {
		errors.push("UNTRIMMED_MISSION_ID");
	}

	if (!Number.isSafeInteger(request.depth) || request.depth < 0) {
		errors.push("NEGATIVE_DEPTH");
	}

	if (request.parentMissionId !== undefined) {
		if (request.depth < 1) errors.push("PARENT_WITHOUT_DEPTH");
	} else if (request.depth !== 0) {
		errors.push("ROOT_DEPTH_MISMATCH");
	}

	if (typeof request.objective !== "string" || request.objective.trim().length === 0) {
		errors.push("MISSING_OBJECTIVE");
	}

	if (typeof request.agent !== "string" || request.agent.trim().length === 0) {
		errors.push("MISSING_AGENT");
	}

	if (!EXECUTION_MODES.has(request.executionMode)) {
		errors.push("INVALID_EXECUTION_MODE");
	}

	if (Array.isArray(request.acceptanceCriteria)) {
		const seen = new Set<string>();
		for (const criterion of request.acceptanceCriteria) {
			if (typeof criterion.id === "string" && seen.has(criterion.id)) {
				errors.push("DUPLICATE_CRITERION_ID");
				break;
			}
			if (typeof criterion.id === "string") seen.add(criterion.id);
		}
	}

	if (request.childSessionId !== undefined) {
		if (typeof request.childSessionId !== "string" || !isSafeChildSessionId(request.childSessionId)) {
			errors.push("UNSAFE_CHILD_SESSION_ID");
		}
	}

	if (
		request.constraints !== undefined &&
		(!Array.isArray(request.constraints) || request.constraints.some((c) => typeof c !== "string"))
	) {
		errors.push("INVALID_CONSTRAINTS");
	}

	if (request.orchestration !== undefined) {
		const metadata = request.orchestration;
		if (
			typeof metadata !== "object" ||
			metadata === null ||
			typeof metadata.orchestrationId !== "string" ||
			typeof metadata.planRevision !== "number" ||
			!Number.isSafeInteger(metadata.planRevision) ||
			metadata.planRevision < 1 ||
			typeof metadata.nodeId !== "string" ||
			typeof metadata.role !== "string" ||
			!(["DIRECT", "CHILD", "SYNTHESIS", "REVIEW", "VERIFICATION"] as const).includes(metadata.nodeKind) ||
			!(["REQUIRED", "OPTIONAL", "VERIFICATION_GATING"] as const).includes(metadata.requirement) ||
			!(["READ_ONLY", "WRITE"] as const).includes(metadata.workspaceAccess) ||
			(metadata.independenceReason !== undefined && typeof metadata.independenceReason !== "string") ||
			(metadata.dependencyCriticality !== undefined &&
				(!Number.isSafeInteger(metadata.dependencyCriticality) || metadata.dependencyCriticality < 0)) ||
			(metadata.priority !== undefined && (!Number.isSafeInteger(metadata.priority) || metadata.priority < 0)) ||
			(metadata.verification !== undefined && typeof metadata.verification !== "boolean")
		) {
			errors.push("INVALID_ORCHESTRATION_METADATA");
		}
	}

	if (request.orchestrationExecution !== undefined) {
		const execution = request.orchestrationExecution;
		if (
			typeof execution !== "object" ||
			execution === null ||
			typeof execution.orchestrationId !== "string" ||
			execution.orchestrationId.trim().length === 0 ||
			typeof execution.childExecutionAuthority !== "string" ||
			execution.childExecutionAuthority.trim().length === 0
		) {
			errors.push("INVALID_ORCHESTRATION_EXECUTION");
		}
	}

	if (errors.length > 0) return { valid: false, errors };
	return { valid: true, request };
}
