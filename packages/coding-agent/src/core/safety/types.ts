import type { ToolEffects } from "@apholdings/jensen-agent-core";

/**
 * Shared types for the safe-autonomous-execution subsystem.
 *
 * The lifecycle these types describe is intentionally provider-independent and
 * deterministic: a tool request is classified, evaluated against a policy
 * engine, validated against the workspace boundary, granted a mutation lease,
 * checkpointed, applied transactionally, validated, confirmed or rolled back,
 * recorded durably, and then the lease is released.
 */

/** Execution mode as an explicit, durable, user-originated state. */
export type ExecutionMode = "observe" | "plan" | "execute";

/**
 * Unique identifier for a mutation lease.
 * Format: `<workspaceId>:<runId>:<nonce>`
 */
export type LeaseId = string;

/** Unique identifier for a workspace mutation transaction. */
export type TransactionId = string;

/** Unique identifier for a checkpoint. */
export type CheckpointId = string;

export type RollbackCapability = "full" | "partial" | "none" | "unknown";

export interface PolicyInput {
	toolName: string;
	effects: ToolEffects;
	/** Resolved absolute target paths (already boundary-checked by the caller). */
	resolvedPaths?: string[];
	workspaceId: string;
	executionMode: ExecutionMode;
	/** Current branch, when running inside a git worktree. */
	currentBranch?: string;
	/** Whether the workspace has uncommitted (dirty) changes. */
	gitClean?: boolean;
	/** The raw shell command, for the bash/powershell tools. */
	requestedCommand?: string;
	/** Network destination, when the tool requests network access. */
	networkHost?: string;
	/** External resource identity, when applicable. */
	externalResource?: string;
	/** Whether the current task carries explicit release authorization. */
	releaseAuthorized?: boolean;
	/** Destination ref for git force operations. */
	gitForceTarget?: string;
}

export type PolicyDecision =
	| {
			outcome: "allow";
			ruleId: string;
			reasonCode: string;
	  }
	| {
			outcome: "require_approval";
			ruleId: string;
			reasonCode: string;
			approvalScope: string;
	  }
	| {
			outcome: "deny";
			ruleId: string;
			reasonCode: string;
	  };

export interface PolicyEvaluation {
	decision: PolicyDecision;
	key: string;
}

/** Classify an interrupted or incomplete transaction at startup/resume. */
export type RecoveryClass =
	| "safe_to_resume_apply"
	| "validation_required"
	| "rollback_required"
	| "manual_conflict"
	| "already_confirmed"
	| "already_rolled_back"
	| "not_found";
