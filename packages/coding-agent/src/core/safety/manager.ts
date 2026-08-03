import fs, { readFile } from "node:fs/promises";
import nodePath from "node:path";
import type { AgentTool, ToolEffects } from "@apholdings/jensen-agent-core";
import { WorkspaceBoundary, WorkspaceBoundaryError } from "./boundary.js";
import { CheckpointStore, sha256, type WorkspaceCheckpoint } from "./checkpoint.js";
import { type LeaseRecord, type LeaseResult, WorkspaceLeaseStore } from "./lease.js";
import { BASELINE_RULES, PolicyEngine } from "./policy.js";
import { type TransactionRecord, type WorkspaceEdit, WorkspaceTransactionManager } from "./transaction.js";
import type {
	ExecutionMode,
	PolicyDecision,
	PolicyEvaluation,
	PolicyInput,
	RecoveryClass,
	TransactionId,
} from "./types.js";

export class PolicyDeniedError extends Error {
	readonly decision: PolicyDecision;
	constructor(decision: PolicyDecision) {
		super(`policy denied: ${decision.reasonCode}`);
		this.name = "PolicyDeniedError";
		this.decision = decision;
	}
}

export class PolicyApprovalRequiredError extends Error {
	readonly evaluation: PolicyEvaluation;
	constructor(evaluation: PolicyEvaluation) {
		super(
			`policy requires approval: ${(evaluation.decision as Extract<PolicyDecision, { outcome: "require_approval" }>).approvalScope}`,
		);
		this.name = "PolicyApprovalRequiredError";
		this.evaluation = evaluation;
	}
}

export interface WorkspaceSafetyOptions {
	storageDir: string;
	timeoutMs?: number;
	heartbeatMs?: number;
	now?: () => number;
	isProcessAlive?: (pid: number) => boolean;
}

export interface MutationOutcome {
	transactionId: TransactionId;
	stage: "confirmed" | "applied" | "rolled_back";
	changed: string[];
}

/**
 * Durable mutation-lifecycle events (the canonical long-horizon equivalent for
 * workspace mutations). These are recorded by the safety manager for audit and
 * replay. They complement, and never compete with, the long-horizon execution
 * state machine.
 */
export type MutationLifecycleEvent =
	| { event: "MUTATION_POLICY_EVALUATED"; transactionId?: string; outcome: string; reasonCode: string; at?: number }
	| { event: "WORKSPACE_LEASE_ACQUIRED"; ownerRunId: string; leaseId: string; at?: number }
	| { event: "CHECKPOINT_CREATED"; transactionId: string; checkpointId: string; at?: number }
	| { event: "TRANSACTION_APPLY_STARTED"; transactionId: string; at?: number }
	| { event: "TRANSACTION_APPLIED"; transactionId: string; at?: number }
	| { event: "TRANSACTION_VALIDATION_STARTED"; transactionId: string; at?: number }
	| { event: "TRANSACTION_VALIDATED"; transactionId: string; result: string; at?: number }
	| { event: "TRANSACTION_CONFIRMED"; transactionId: string; at?: number }
	| { event: "TRANSACTION_ROLLBACK_STARTED"; transactionId: string; at?: number }
	| { event: "TRANSACTION_ROLLED_BACK"; transactionId: string; at?: number }
	| { event: "TRANSACTION_RECOVERY_REQUIRED"; transactionId: string; reason: string; at?: number }
	| { event: "WORKSPACE_LEASE_RELEASED"; ownerRunId: string; at?: number };

const KNOWN_MUTATORS = new Set(["edit", "write", "bash", "powershell", "process_manager"]);

function extractTargetPaths(toolName: string, params: Record<string, unknown>): string[] {
	if (params && typeof params.path === "string") return [params.path];
	void toolName;
	return [];
}

function effectsMutate(effects: ToolEffects): boolean {
	return (
		effects.writesWorkspace ||
		effects.deletesFiles ||
		effects.mutatesGit ||
		effects.mutatesExternalState ||
		effects.executesProcesses ||
		effects.startsPersistentProcesses
	);
}

/**
 * Plumbs the deterministic safety lifecycle together: policy → boundary →
 * lease → checkpoint → transactional apply → validate → confirm/rollback →
 * durable record. Provides a guarded tool wrapper for production tool
 * execution and a diagnostic surface that never exposes secrets or contents.
 */
export class WorkspaceSafety {
	readonly storageDir: string;
	readonly boundary: WorkspaceBoundary;
	readonly policy: PolicyEngine;
	readonly leases: WorkspaceLeaseStore;
	readonly checkpoints: CheckpointStore;
	readonly transactions: WorkspaceTransactionManager;
	readonly workspaceId: string;
	readonly root: string;
	executionMode: ExecutionMode;

	constructor(
		root: string,
		boundary: WorkspaceBoundary,
		options: WorkspaceSafetyOptions,
		mode: ExecutionMode = "observe",
	) {
		this.root = nodePath.resolve(root);
		this.boundary = boundary;
		this.workspaceId = boundary.effectiveRoot.replace(/[\\/]+/g, "/").toLowerCase();
		this.storageDir = options.storageDir;
		this.policy = new PolicyEngine(BASELINE_RULES, {});
		this.leases = new WorkspaceLeaseStore({
			storageDir: options.storageDir,
			timeoutMs: options.timeoutMs ?? 30_000,
			heartbeatMs: options.heartbeatMs ?? 5_000,
			now: options.now ?? (() => Date.now()),
			isProcessAlive: options.isProcessAlive ?? undefined,
		});
		this.checkpoints = new CheckpointStore({ storageDir: options.storageDir });
		this.transactions = new WorkspaceTransactionManager(options.storageDir, boundary, this.checkpoints);
		this.executionMode = mode;
	}

	static async create(
		root: string,
		options: WorkspaceSafetyOptions,
		mode: ExecutionMode = "execute",
	): Promise<WorkspaceSafety> {
		const boundary = await WorkspaceBoundary.create(root);
		await fs.mkdir(nodePath.join(options.storageDir, "leases"), { recursive: true });
		await fs.mkdir(nodePath.join(options.storageDir, "transactions"), { recursive: true });
		await fs.mkdir(nodePath.join(options.storageDir, "checkpoints"), { recursive: true });
		const safety = new WorkspaceSafety(root, boundary, options, mode);
		await safety.persistMode();
		return safety;
	}

	private modePath(): string {
		return nodePath.join(this.storageDir, "mode.json");
	}

	private journalPath(): string {
		const key = this.workspaceId.replace(/[^a-z0-9._-]/g, "_");
		return nodePath.join(this.storageDir, "events", `${key}.jsonl`);
	}

	/** Append a durable mutation-lifecycle event (audit/replay, not authority). */
	async appendEvent(ev: MutationLifecycleEvent & { at?: number }): Promise<void> {
		const record = { ...ev, at: ev.at ?? Date.now() };
		await fs.mkdir(nodePath.dirname(this.journalPath()), { recursive: true });
		await fs.appendFile(this.journalPath(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
	}

	async readEvents(): Promise<Record<string, unknown>[]> {
		try {
			const raw = await fs.readFile(this.journalPath(), "utf-8");
			return raw
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l) as Record<string, unknown>);
		} catch {
			return [];
		}
	}

	/**
	 * Completion gate for long-horizon: a step whose required mutation
	 * transaction is unresolved (unvalidated/unconfirmed/rollback- or
	 * recovery-required) cannot be marked complete.
	 */
	async gateStepCompletion(mutating: boolean): Promise<{ canComplete: boolean; blockingReason?: string }> {
		if (!mutating) return { canComplete: true };
		const unresolved = await this.transactions.list();
		const blocking = unresolved.find((t) =>
			["prepared", "checkpointed", "applied", "validating", "validated", "recovery_required"].includes(t.stage),
		);
		if (blocking) {
			return {
				canComplete: false,
				blockingReason: `mutation transaction ${blocking.transactionId} is unresolved (${blocking.stage})`,
			};
		}
		return { canComplete: true };
	}

	async persistMode(): Promise<void> {
		await fs.writeFile(this.modePath(), JSON.stringify({ mode: this.executionMode }), { mode: 0o600 });
	}

	async setExecutionMode(mode: ExecutionMode): Promise<void> {
		this.executionMode = mode;
		await this.persistMode();
	}

	async readMode(): Promise<ExecutionMode | null> {
		try {
			const raw = JSON.parse(await fs.readFile(this.modePath(), "utf-8")) as { mode?: ExecutionMode };
			return raw.mode ?? null;
		} catch {
			return null;
		}
	}

	evaluate(
		input: Omit<PolicyInput, "workspaceId" | "executionMode"> & Partial<Pick<PolicyInput, "executionMode">>,
	): PolicyEvaluation {
		return this.policy.evaluate({
			workspaceId: this.workspaceId,
			executionMode: input.executionMode ?? this.executionMode,
			...input,
		});
	}

	/** Guard a mutation path. Returns resolved abs paths or throws Denied/Approval/Boundary. */
	async guardMutation(input: Omit<PolicyInput, "workspaceId" | "executionMode">): Promise<{
		evaluation: PolicyEvaluation;
		resolved: string[];
	}> {
		const evaluation = this.evaluate(input);
		if (evaluation.decision.outcome === "deny") throw new PolicyDeniedError(evaluation.decision);
		const resolved: string[] = [];
		for (const p of input.resolvedPaths ?? []) {
			resolved.push(await this.boundary.resolveWithin(p));
		}
		return { evaluation, resolved };
	}

	/**
	 * High-level transactional mutation over a structured edit batch.
	 * Policy is evaluated, an exclusive lease is acquired, a checkpoint is
	 * created before the first write, the batch is applied, validated, and
	 * confirmed. Any failure rolls back and releases the lease.
	 */
	async performMutation(opts: {
		runId?: string;
		mode?: ExecutionMode;
		edits: WorkspaceEdit[];
		policy?: PolicyDecision | null;
		validation?: {
			id: string;
			label: string;
			run: (() => Promise<{ exitCode: number; outputArtifact: string }>) | null;
		};
		effects?: ToolEffects;
		releaseAuthorized?: boolean;
	}): Promise<MutationOutcome> {
		const mode = opts.mode ?? this.executionMode;
		const absEdits = await Promise.all(
			opts.edits.map(async (e) => ({ e, abs: await this.boundary.resolveWithin(e.path) })),
		);
		const targetPaths = absEdits.map((x) => x.abs);
		// Evaluate policy.
		const input: PolicyInput = {
			toolName: "workspace_transaction",
			effects: opts.effects ?? DEFAULT_MUTATING_EFFECTS,
			resolvedPaths: targetPaths,
			workspaceId: this.workspaceId,
			executionMode: mode,
			releaseAuthorized: opts.releaseAuthorized,
		};
		const evaluation = opts.policy ?? this.policy.evaluate(input).decision;
		if (evaluation.outcome === "deny") throw new PolicyDeniedError(evaluation);
		if (evaluation.outcome === "require_approval") {
			// performMutation has no approval channel: an unattended mutation
			// requiring approval must not proceed.
			throw new PolicyApprovalRequiredError({ decision: evaluation, key: this.workspaceId });
		}
		await this.appendEvent({
			event: "MUTATION_POLICY_EVALUATED",
			outcome: evaluation.outcome,
			reasonCode: evaluation.reasonCode,
		});
		// Acquire exclusive workspace mutation lease.
		const lease = await this.acquireLease(opts.runId ?? "run");
		if (!lease.ok) {
			await this.appendEvent({
				event: "TRANSACTION_RECOVERY_REQUIRED",
				transactionId: "none",
				reason: "lease_unavailable",
			});
			throw new PolicyDeniedError({
				outcome: "deny",
				ruleId: "lease",
				reasonCode: "workspace_mutation_lease_unavailable",
			});
		}
		await this.appendEvent({
			event: "WORKSPACE_LEASE_ACQUIRED",
			ownerRunId: opts.runId ?? "run",
			leaseId: lease.lease.leaseId,
		});
		try {
			const tx = await this.transactions.begin(this.workspaceId, { runId: opts.runId, mode, policy: evaluation });
			await this.transactions.checkpoint(tx, targetPaths);
			await this.appendEvent({
				event: "CHECKPOINT_CREATED",
				transactionId: tx.transactionId,
				checkpointId: tx.checkpointId!,
			});
			try {
				await this.appendEvent({ event: "TRANSACTION_APPLY_STARTED", transactionId: tx.transactionId });
				const applied = await this.transactions.apply(tx, opts.edits);
				await this.appendEvent({ event: "TRANSACTION_APPLIED", transactionId: tx.transactionId });
				await this.appendEvent({ event: "TRANSACTION_VALIDATION_STARTED", transactionId: tx.transactionId });
				if (opts.validation) {
					await this.transactions.validate(tx, opts.validation);
				} else {
					await this.transactions.validate(tx, {
						id: "write-verify",
						label: "write-verify",
						run: async () => {
							for (const p of tx.appliedPaths) {
								const cur = await readFile(p).catch(() => null);
								const expected = tx.appliedSha[p];
								if (expected !== null && (!cur || sha256(cur) !== expected)) {
									return { exitCode: 1, outputArtifact: `hash mismatch: ${p}` };
								}
							}
							return { exitCode: 0, outputArtifact: "" };
						},
					});
				}
				await this.appendEvent({
					event: "TRANSACTION_VALIDATED",
					transactionId: tx.transactionId,
					result: tx.validation?.result ?? "unknown",
				});
				if (
					tx.validation?.result === "failed" ||
					tx.validation?.result === "aborted" ||
					tx.validation?.result === "timed_out"
				) {
					await this.appendEvent({ event: "TRANSACTION_ROLLBACK_STARTED", transactionId: tx.transactionId });
					await this.transactions.rollback(tx);
					await this.appendEvent({ event: "TRANSACTION_ROLLED_BACK", transactionId: tx.transactionId });
					await this.releaseLease(opts.runId ?? "run");
					await this.appendEvent({ event: "WORKSPACE_LEASE_RELEASED", ownerRunId: opts.runId ?? "run" });
					return { transactionId: tx.transactionId, stage: "rolled_back", changed: [] };
				}
				await this.transactions.confirm(tx);
				await this.appendEvent({ event: "TRANSACTION_CONFIRMED", transactionId: tx.transactionId });
				await this.releaseLease(opts.runId ?? "run");
				await this.appendEvent({ event: "WORKSPACE_LEASE_RELEASED", ownerRunId: opts.runId ?? "run" });
				return { transactionId: tx.transactionId, stage: "confirmed", changed: applied.changed.map((c) => c.path) };
			} catch (err) {
				await this.appendEvent({ event: "TRANSACTION_ROLLBACK_STARTED", transactionId: tx.transactionId });
				if (tx.checkpointId) await this.transactions.rollback(tx).catch(() => {});
				await this.appendEvent({ event: "TRANSACTION_ROLLED_BACK", transactionId: tx.transactionId });
				await this.releaseLease(opts.runId ?? "run");
				await this.appendEvent({ event: "WORKSPACE_LEASE_RELEASED", ownerRunId: opts.runId ?? "run" });
				throw err;
			}
		} catch (err) {
			if (err instanceof WorkspaceBoundaryError || err instanceof PolicyDeniedError) {
				await this.releaseLease(opts.runId ?? "run").catch(() => {});
			}
			throw err;
		}
	}

	async acquireLease(ownerRunId: string): Promise<LeaseResult> {
		return this.leases.acquire(this.workspaceId, ownerRunId);
	}

	async releaseLease(ownerRunId: string): Promise<void> {
		await this.leases.release(this.workspaceId, ownerRunId);
	}

	async leaseStatus(): Promise<LeaseRecord | null> {
		return this.leases.status(this.workspaceId);
	}

	async lastCheckpoint(): Promise<WorkspaceCheckpoint | null> {
		const all = await this.checkpoints.list();
		all.sort((a, b) => b.createdAt - a.createdAt);
		return all[0] ?? null;
	}

	async recoverRollback(transactionId: TransactionId): Promise<TransactionRecord | null> {
		const rec = await this.transactions.read(transactionId);
		if (!rec) return null;
		await this.transactions.rollback(rec);
		return rec;
	}

	async classify(transactionId: TransactionId): Promise<RecoveryClass> {
		return this.transactions.classify(transactionId);
	}

	/**
	 * Wrap the deterministic mutating tools (edit, write) so that every call is
	 * guarded by policy + lease + checkpoint + transaction confirm/rollback.
	 */
	wrapMutationTools<T extends AgentTool>(tools: T[], authorize?: (scope: string) => boolean | Promise<boolean>): T[] {
		return tools.map((tool) => {
			if (!KNOWN_MUTATORS.has(tool.name)) return tool;
			const rawExecute = tool.execute.bind(tool);
			const wrapper: T = Object.create(tool);
			Object.defineProperty(wrapper, "execute", {
				value: async (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: never) => {
					const effects = tool.effects ?? DEFAULT_MUTATING_EFFECTS;
					const targetPaths = extractTargetPaths(tool.name, params as Record<string, unknown>);
					const resolved: string[] = [];
					for (const p of targetPaths) {
						resolved.push(await this.boundary.resolveWithin(p));
					}
					const input: PolicyInput = {
						toolName: tool.name,
						effects,
						resolvedPaths: resolved,
						workspaceId: this.workspaceId,
						executionMode: this.executionMode,
						requestedCommand:
							typeof (params as { command?: string }).command === "string"
								? (params as { command?: string }).command
								: undefined,
					};
					const evaluation = this.policy.evaluate(input);
					if (evaluation.decision.outcome === "deny") throw new PolicyDeniedError(evaluation.decision);
					if (evaluation.decision.outcome === "require_approval") {
						const approved = authorize
							? await authorize(
									(evaluation.decision as Extract<PolicyDecision, { outcome: "require_approval" }>)
										.approvalScope,
								)
							: false;
						if (!approved) throw new PolicyApprovalRequiredError(evaluation);
					}
					if (!effectsMutate(effects)) {
						return rawExecute(toolCallId, params, signal, onUpdate);
					}
					// Mutating tool: lease + checkpoint + transactional.
					if (tool.name === "bash" || tool.name === "powershell" || tool.name === "process_manager") {
						// Dynamic shell effects are not structurally checkpointable.
						const lease = await this.acquireLease("run");
						if (!lease.ok)
							throw new PolicyDeniedError({
								outcome: "deny",
								ruleId: "lease",
								reasonCode: "workspace_mutation_lease_unavailable",
							});
						try {
							const result = await rawExecute(toolCallId, params, signal, onUpdate);
							await this.releaseLease("run");
							return result;
						} catch (err) {
							await this.releaseLease("run");
							throw err;
						}
					}
					// Deterministic file mutators: checkpoint the target file.
					const tx = await this.transactions.begin(this.workspaceId, {
						runId: "run",
						mode: this.executionMode,
						policy: evaluation.decision,
					});
					await this.transactions.checkpoint(tx, resolved);
					try {
						const result = await rawExecute(toolCallId, params, signal, onUpdate);
						const expected = await readFile(resolved[0] ?? "").catch(() => null);
						await this.transactions.validate(tx, {
							id: "tool-write-verify",
							label: `verify ${tool.name}`,
							run: async () => {
								if (!resolved.length) return { exitCode: 0, outputArtifact: "" };
								if (!expected) return { exitCode: 1, outputArtifact: `${resolved[0]} missing after write` };
								return { exitCode: 0, outputArtifact: sha256(expected) };
							},
						});
						if (tx.validation && tx.validation.result !== "passed") {
							await this.transactions.rollback(tx);
							throw new PolicyDeniedError({
								outcome: "deny",
								ruleId: "validation",
								reasonCode: "tool_write_validation_failed",
							});
						}
						await this.transactions.confirm(tx);
						return result;
					} catch (err) {
						if (tx.checkpointId) await this.transactions.rollback(tx).catch(() => {});
						throw err;
					}
				},
			});
			return wrapper;
		});
	}
}

const DEFAULT_MUTATING_EFFECTS: ToolEffects = {
	readsWorkspace: true,
	writesWorkspace: true,
	createsFiles: true,
	deletesFiles: true,
	executesProcesses: false,
	startsPersistentProcesses: false,
	accessesNetwork: false,
	mutatesGit: false,
	mutatesExternalState: false,
	handlesSecrets: false,
	potentiallyDestructive: false,
	requiresExclusiveWorkspaceLease: true,
	parallelSafe: false,
};
