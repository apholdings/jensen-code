import os from "node:os";
import nodePath from "node:path";
import { PRODUCTION_TOOL_EFFECTS } from "./effects.js";
import { WorkspaceSafety } from "./manager.js";
import type { TransactionId } from "./types.js";

export const WORKSPACE_STATE_DIR_ENV = "JENSEN_WORKSPACE_STATE_DIR";

/** Resolve the durable workspace-state storage directory. */
export function defaultWorkspaceStateDir(): string {
	if (process.env[WORKSPACE_STATE_DIR_ENV]) return process.env[WORKSPACE_STATE_DIR_ENV]!;
	return nodePath.join(os.homedir(), ".local", "state", "jensen", "workspace");
}

function usage(): string {
	return [
		"Usage: jensen workspace <command> [args]",
		"",
		"Commands:",
		"  status                          Show workspace safety status",
		"  policy                          Show the deterministic policy profile",
		"  lease                           Show the active mutation lease",
		"  transactions                    List mutation transactions",
		"  transaction inspect <id>        Inspect one transaction",
		"  checkpoint inspect <id>         Inspect one checkpoint (metadata only)",
		"  rollback <transaction-id>       Roll back one failed/unconfirmed transaction",
		"  recovery status                 Classify incomplete transactions",
		"  recovery inspect <id>           Inspect recovery state for a transaction",
		"  recovery resume <id>            Recover a transaction flagged for resume",
		"  recovery rollback <id>          Roll back a transaction flagged for rollback",
	].join("\n");
}

function red(s: string): string {
	return s;
}

export async function handleWorkspaceCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "workspace") return false;
	const sub = args[1] ?? "status";
	const storageDir = defaultWorkspaceStateDir();
	const root = process.cwd();
	try {
		const safety = await WorkspaceSafety.create(root, { storageDir }, "execute");
		switch (sub) {
			case "status":
				await printStatus(safety);
				break;
			case "policy":
				printPolicy();
				break;
			case "lease":
				await printLease(safety);
				break;
			case "transactions":
				await printTransactions(safety);
				break;
			case "transaction":
				if (args[2] !== "inspect") {
					console.error(usage());
					return true;
				}
				await inspectTransaction(safety, args[3]);
				break;
			case "checkpoint":
				if (args[2] !== "inspect") {
					console.error(usage());
					return true;
				}
				await inspectCheckpoint(safety, args[3]);
				break;
			case "rollback": {
				if (!args[2]) {
					console.error("Missing transaction-id");
					return true;
				}
				await doRollback(safety, args[2]);
				break;
			}
			case "recovery":
				await handleRecovery(safety, args);
				break;
			default:
				console.error(usage());
		}
	} catch (err) {
		console.error(red(`workspace command failed: ${err instanceof Error ? err.message : String(err)}`));
	}
	return true;
}

async function printStatus(safety: WorkspaceSafety): Promise<void> {
	const lease = await safety.leaseStatus();
	const txs = await safety.transactions.list();
	const cp = await safety.lastCheckpoint();
	const incomplete = txs.filter((t) =>
		["prepared", "checkpointed", "applied", "validating", "validated", "recovery_required"].includes(t.stage),
	);
	console.log(`Workspace:       ${safety.root}`);
	console.log(`Canonical root:  ${safety.boundary.effectiveRoot}`);
	console.log(`Workspace id:    ${safety.workspaceId}`);
	console.log(`Execution mode:  ${safety.executionMode}`);
	console.log(`Policy profile:  baseline (deny > approval > allow > default)`);
	console.log(
		`Active lease:    ${lease ? `${lease.ownerRunId} acquired ${new Date(lease.acquiredAt).toISOString()}` : "none"}`,
	);
	console.log(`Transactions:    ${txs.length} (${incomplete.length} incomplete)`);
	console.log(`Last checkpoint: ${cp ? cp.checkpointId : "none"}`);
	console.log(`Rollback cap:    ${incomplete[0]?.rollbackCapability ?? "-"}`);
}

function printPolicy(): void {
	console.log("Policy precedence: deny > require_approval > allow > default");
	console.log("");
	console.log("Baseline rules:");
	const rules = [
		"deny.destructive_shell       - rm -rf /, git reset --hard, force-push to protected branch, policy-bypass markers",
		"deny.paths_outside_workspace - targets resolved outside the authorized root",
		"deny.secrets                 - private key material, .env, credentials",
		"allow.authorized_release     - publication only under explicit release authorization",
		"deny.unknown_effects         - dynamic/unknown-effect tools are conservative",
		"mode.observe/plan/execute    - explicit durable execution modes",
	];
	for (const r of rules) console.log(`  ${r}`);
	console.log("");
	console.log("Tool effects registered:");
	for (const name of Object.keys(PRODUCTION_TOOL_EFFECTS)) {
		const e = PRODUCTION_TOOL_EFFECTS[name];
		const flags =
			[
				e.writesWorkspace && "writes",
				e.deletesFiles && "deletes",
				e.executesProcesses && "exec",
				e.accessesNetwork && "net",
				e.mutatesGit && "git",
				e.potentiallyDestructive && "destructive",
				e.parallelSafe && "parallel",
			]
				.filter(Boolean)
				.join(",") || "read";
		console.log(`  ${name.padEnd(20)} ${flags}`);
	}
}

async function printLease(safety: WorkspaceSafety): Promise<void> {
	const lease = await safety.leaseStatus();
	if (!lease) {
		console.log("No active mutation lease.");
		return;
	}
	console.log(`Lease id:        ${lease.leaseId}`);
	console.log(`Workspace:       ${lease.workspaceId}`);
	console.log(`Owner run:       ${lease.ownerRunId}`);
	console.log(`Process id:      ${lease.processId}`);
	console.log(`Acquired at:     ${new Date(lease.acquiredAt).toISOString()}`);
	console.log(`Last heartbeat:  ${new Date(lease.lastHeartbeat).toISOString()}`);
	console.log(`Expiry:          ${new Date(lease.expiresAt).toISOString()}`);
}

async function printTransactions(safety: WorkspaceSafety): Promise<void> {
	const txs = await safety.transactions.list();
	if (txs.length === 0) {
		console.log("No transactions recorded.");
		return;
	}
	for (const t of txs) {
		console.log(
			`${t.transactionId}  ${t.stage.padEnd(18)} ${new Date(t.createdAt).toISOString()}  paths=${t.appliedPaths.length}`,
		);
	}
}

async function inspectTransaction(safety: WorkspaceSafety, id?: string): Promise<void> {
	if (!id) {
		console.error("Missing transaction id");
		return;
	}
	const t = await safety.transactions.read(id as TransactionId);
	if (!t) {
		console.error(`Transaction not found: ${id}`);
		return;
	}
	console.log(`Transaction:    ${t.transactionId}`);
	console.log(`Workspace:      ${t.workspaceId}`);
	console.log(`Stage:          ${t.stage}`);
	console.log(`Mode:           ${t.mode}`);
	console.log(`Policy:         ${t.policy ? `${t.policy.outcome}/${t.policy.reasonCode}` : "none"}`);
	console.log(`Checkpoint:     ${t.checkpointId ?? "none"}`);
	console.log(`Created:        ${new Date(t.createdAt).toISOString()}`);
	console.log(`Rollback cap:   ${t.rollbackCapability}`);
	const v = t.validation;
	if (v) {
		console.log(`Validation:     ${v.result} (exit ${v.exitCode}, ${v.durationMs}ms)`);
	}
	console.log(`Changed paths:  ${t.appliedPaths.length}`);
	for (const p of t.appliedPaths.slice(0, 20)) console.log(`  ${p}`);
}

async function inspectCheckpoint(safety: WorkspaceSafety, id?: string): Promise<void> {
	if (!id) {
		console.error("Missing checkpoint id");
		return;
	}
	const cp = await safety.checkpoints.read(id!);
	if (!cp) {
		console.error(`Checkpoint not found: ${id}`);
		return;
	}
	console.log(`Checkpoint:     ${cp.checkpointId}`);
	console.log(`Status:         ${cp.status}`);
	console.log(`Transaction:    ${cp.transactionId}`);
	console.log(`Entries:        ${cp.entries.length}`);
	console.log(`Manifest sha:   ${cp.manifestSha256.slice(0, 16)}…`);
	for (const e of cp.entries.slice(0, 20)) {
		console.log(`  ${(e.type + (e.existed ? "" : " (missing)")).padEnd(22)} ${nodePath.basename(e.path)}`);
	}
}

async function doRollback(safety: WorkspaceSafety, id: string): Promise<void> {
	const rec = await safety.transactions.read(id as TransactionId);
	if (!rec) {
		console.error(`Transaction not found: ${id}`);
		return;
	}
	console.log(`Rolling back transaction ${id}...`);
	const result = await safety.transactions.rollback(rec);
	if (result.status === "conflict") {
		console.error(`Rollback conflict on ${result.conflicts.length} path(s). Not overwriting user changes.`);
		for (const c of result.conflicts) console.error(`  ${c.path}: ${c.message}`);
		return;
	}
	console.log(`${result.status}: ${result.restored.length} path(s) restored.`);
}

async function handleRecovery(safety: WorkspaceSafety, args: string[]): Promise<void> {
	const action = args[2];
	const id = args[3];
	switch (action) {
		case "status": {
			const txs = await safety.transactions.list();
			const incomplete = txs.filter((t) =>
				["prepared", "checkpointed", "applied", "validating", "validated", "recovery_required"].includes(t.stage),
			);
			console.log(`${incomplete.length} incomplete transaction(s).`);
			for (const t of incomplete) {
				const cls = await safety.transactions.classify(t.transactionId);
				console.log(`  ${t.transactionId}  stage=${t.stage}  recovery=${cls}`);
			}
			break;
		}
		case "inspect":
			if (!id) return console.error("Missing transaction id");
			console.log(await safety.transactions.classify(id as TransactionId));
			break;
		case "resume":
		case "rollback": {
			if (!id) return console.error("Missing transaction id");
			const cls = await safety.transactions.classify(id as TransactionId);
			if (action === "rollback" || cls === "rollback_required") {
				return doRollback(safety, id);
			}
			console.log(`Transaction ${id} classified as ${cls}; no rollback performed.`);
			break;
		}
		default:
			console.error(usage());
	}
}
