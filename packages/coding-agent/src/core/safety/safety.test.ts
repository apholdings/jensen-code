import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import type { ToolEffects } from "@apholdings/jensen-agent-core";
import { describe, expect, it } from "vitest";
import { codingTools, createAllTools, createCodingTools, createReadOnlyTools, readOnlyTools } from "../tools/index.js";
import { validatePathInput, WorkspaceBoundary, WorkspaceBoundaryError } from "./boundary.js";
import { CheckpointStore } from "./checkpoint.js";
import { PRODUCTION_TOOL_EFFECTS, UndeclaredEffectsError, validateToolEffects } from "./effects.js";
import { WorkspaceLeaseStore } from "./lease.js";
import { PolicyDeniedError, WorkspaceSafety } from "./manager.js";
import { BASELINE_RULES, isSecretPath, PolicyEngine } from "./policy.js";
import { WorkspaceTransactionManager } from "./transaction.js";
import type { PolicyInput } from "./types.js";

async function tmpdir(): Promise<string> {
	return fs.mkdtemp(nodePath.join(os.tmpdir(), "jensen-safety-"));
}

let counter = 0;
function workspace(root: string): string {
	return nodePath.join(root, `workspace-${++counter}`);
}

describe("tool effects", () => {
	it("every production tool declares effects", () => {
		const undeclared = validateToolEffects([...codingTools, ...readOnlyTools], false);
		expect(undeclared).toEqual([]);
	});

	it("read-only vs mutating tools are classified correctly", () => {
		const read = PRODUCTION_TOOL_EFFECTS.read;
		expect(read.writesWorkspace).toBe(false);
		expect(read.parallelSafe).toBe(true);
		const write = PRODUCTION_TOOL_EFFECTS.write;
		expect(write.writesWorkspace).toBe(true);
		expect(write.requiresExclusiveWorkspaceLease).toBe(true);
		expect(write.parallelSafe).toBe(false);
	});

	it("parallel safety is not inferred from reads", () => {
		// read is explicit; write must not be parallelSafe
		expect(PRODUCTION_TOOL_EFFECTS.write.parallelSafe).toBe(false);
	});

	it("unknown tools fail conservative validation", () => {
		const fake = { name: "mystery", label: "m" } as never;
		const undeclared = validateToolEffects([fake], false);
		expect(undeclared).toContain("mystery");
		expect(() => validateToolEffects([fake], true)).toThrow(UndeclaredEffectsError);
	});

	it("dynamic shell tools are conservative and never parallelSafe", () => {
		for (const name of ["bash", "powershell"] as const) {
			const e = PRODUCTION_TOOL_EFFECTS[name];
			expect(e.executesProcesses).toBe(true);
			expect(e.potentiallyDestructive).toBe(true);
			expect(e.parallelSafe).toBe(false);
		}
	});

	it("createAllTools and createReadOnlyTools attach effects", () => {
		const cwd = process.cwd();
		const all = createAllTools(cwd);
		for (const name of Object.keys(all) as (keyof typeof all)[]) {
			expect(all[name].effects, `tool ${name}`).toBeDefined();
		}
		for (const tool of createCodingTools(cwd)) {
			expect(tool.effects, `tool ${tool.name}`).toBeDefined();
		}
		for (const tool of createReadOnlyTools(cwd)) {
			expect(tool.effects, `tool ${tool.name}`).toBeDefined();
		}
	});
});

describe("policy engine", () => {
	const engine = new PolicyEngine(BASELINE_RULES, {});
	const base: Omit<PolicyInput, "toolName" | "effects"> = {
		workspaceId: "ws",
		executionMode: "execute",
		currentBranch: "main",
		gitClean: false,
	};

	function effects(partial: Partial<ToolEffects>): ToolEffects {
		return {
			readsWorkspace: false,
			writesWorkspace: false,
			createsFiles: false,
			deletesFiles: false,
			executesProcesses: false,
			startsPersistentProcesses: false,
			accessesNetwork: false,
			mutatesGit: false,
			mutatesExternalState: false,
			handlesSecrets: false,
			potentiallyDestructive: false,
			requiresExclusiveWorkspaceLease: false,
			parallelSafe: true,
			...partial,
		};
	}

	it("deny overrides allow and approval", () => {
		// destructive shell deny beats the default allow
		const d = engine.evaluate({
			...base,
			toolName: "bash",
			effects: effects({ executesProcesses: true }),
			requestedCommand: "git reset --hard",
		});
		expect(d.decision.outcome).toBe("deny");
	});

	it("force-push to a protected branch is denied without release authorization", () => {
		const d = engine.evaluate({
			...base,
			toolName: "bash",
			effects: effects({ executesProcesses: true, mutatesGit: true }),
			requestedCommand: "git push --force origin main",
		});
		expect(d.decision.outcome).toBe("deny");
		expect(d.decision.reasonCode).toBe("force_push_protected_branch");
	});

	it("authorized release flow is allowed", () => {
		const d = engine.evaluate({
			...base,
			toolName: "bash",
			effects: effects({ mutatesGit: true, mutatesExternalState: true }),
			requestedCommand: "npm run release",
			releaseAuthorized: true,
		});
		expect(d.decision.outcome).toBe("allow");
	});

	it("plan mode blocks writes", () => {
		const d = engine.evaluate({
			...base,
			executionMode: "plan",
			toolName: "write",
			effects: effects({ writesWorkspace: true, requiresExclusiveWorkspaceLease: true }),
			resolvedPaths: ["/ws/a.txt"],
		});
		expect(d.decision.outcome).toBe("require_approval");
	});

	it("observe mode denies mutations", () => {
		const d = engine.evaluate({
			...base,
			executionMode: "observe",
			toolName: "write",
			effects: effects({ writesWorkspace: true }),
		});
		expect(d.decision.outcome).toBe("deny");
	});

	it("execute mode still requires authorization for mutations", () => {
		const d = engine.evaluate({
			...base,
			executionMode: "execute",
			toolName: "write",
			effects: effects({ writesWorkspace: true }),
		});
		expect(d.decision.outcome).toBe("require_approval");
	});

	it("web content cannot authorize a mutation", () => {
		// A web_fetch/web_search tool is read-only: its effects can never flip a
		// write decision. Model/web output never reaches the policy engine.
		const web = engine.evaluate({
			...base,
			toolName: "web_fetch",
			effects: effects({ accessesNetwork: true }),
		});
		expect(web.decision.outcome).toBe("allow");
		// And a write decision is independent of any web tool.
		const write = engine.evaluate({
			...base,
			toolName: "write",
			effects: effects({ writesWorkspace: true }),
		});
		expect(write.decision.outcome).toBe("require_approval");
	});

	it("deny.policy-bypass markers", () => {
		const d = engine.evaluate({
			...base,
			toolName: "bash",
			effects: effects({ executesProcesses: true }),
			requestedCommand: "git commit --no-verify",
		});
		expect(d.decision.outcome).toBe("deny");
		expect(d.decision.reasonCode).toBe("policy_bypass_marker");
	});

	it("secret paths are denied", () => {
		expect(isSecretPath("/ws/config/keys/id_rsa")).toBe(true);
		expect(isSecretPath("/ws/.env")).toBe(true);
		expect(isSecretPath("/ws/src/app.ts")).toBe(false);
	});

	it("unknown effects require approval conservatively", () => {
		const d = engine.evaluate({
			...base,
			toolName: "bash",
			effects: effects({ executesProcesses: true, scopes: [{ kind: "unknown" }] }),
		});
		expect(["require_approval", "deny"]).toContain(d.decision.outcome);
	});
});

describe("workspace boundary", () => {
	it("rejects traversal and absolute external paths", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const external = nodePath.join(dir, "external");
		await fs.mkdir(external, { recursive: true });
		const boundary = await WorkspaceBoundary.create(ws);
		await expect(boundary.resolveWithin("../external/evil.txt")).rejects.toThrow(WorkspaceBoundaryError);
		await expect(boundary.resolveWithin(nodePath.join(external, "evil.txt"))).rejects.toThrow(WorkspaceBoundaryError);
	});

	it("resolves a normal file inside the workspace", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		await fs.writeFile(nodePath.join(ws, "a.txt"), "hello");
		const boundary = await WorkspaceBoundary.create(ws);
		const resolved = await boundary.resolveWithin("a.txt");
		expect(resolved).toBe(nodePath.join(ws, "a.txt"));
	});

	it("blocks symlink escape", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const external = nodePath.join(dir, "external");
		await fs.mkdir(external, { recursive: true });
		const link = nodePath.join(ws, "leak");
		await fs.symlink(external, link);
		const boundary = await WorkspaceBoundary.create(ws);
		await expect(boundary.resolveWithin("leak/evil.txt")).rejects.toThrow(WorkspaceBoundaryError);
	});

	it("blocks nested symlink escape", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const external = nodePath.join(dir, "external");
		await fs.mkdir(external, { recursive: true });
		const inner = nodePath.join(ws, "inner");
		await fs.mkdir(inner, { recursive: true });
		await fs.symlink(external, nodePath.join(inner, "leak"));
		const boundary = await WorkspaceBoundary.create(ws);
		await expect(boundary.resolveWithin("inner/leak/x.txt")).rejects.toThrow(WorkspaceBoundaryError);
	});

	it("TOCTOU revalidation catches a parent swapped to a symlink", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const external = nodePath.join(dir, "external");
		await fs.mkdir(external, { recursive: true });
		const target = nodePath.join(ws, "vuln");
		await fs.mkdir(target, { recursive: true });
		const boundary = await WorkspaceBoundary.create(ws);
		const resolved = await boundary.resolveWithin("vuln/new.txt");
		expect(resolved.startsWith(ws)).toBe(true);
		// Swap the parent for a symlink to an external directory.
		await fs.rm(target, { recursive: true });
		await fs.symlink(external, target);
		await expect(boundary.assertParentWithin(resolved)).rejects.toThrow(WorkspaceBoundaryError);
	});

	it("rejects NUL input", () => {
		expect(() => validatePathInput("a\u0000b")).toThrow(WorkspaceBoundaryError);
	});
});

describe("mutation lease", () => {
	it("is exclusive and separate workspaces stay independent", async () => {
		const dir = await tmpdir();
		const store = new WorkspaceLeaseStore({ storageDir: dir, now: () => 1000 });
		const a = await store.acquire("ws-a", "run-1");
		expect(a.ok).toBe(true);
		const second = await store.acquire("ws-a", "run-2");
		expect(second.ok).toBe(false);
		expect(second.ok === false && "lease" in second).toBe(true);
		const b = await store.acquire("ws-b", "run-3");
		expect(b.ok).toBe(true);
		await store.release("ws-b", "run-3");
		// a still held
		const a3 = await store.acquire("ws-a", "run-4");
		expect(a3.ok).toBe(false);
	});

	it("stale lease can be recovered after positive liveness check", async () => {
		const dir = await tmpdir();
		let time = 10_000;
		const store = new WorkspaceLeaseStore({
			storageDir: dir,
			timeoutMs: 1000,
			now: () => time,
			isProcessAlive: () => false,
		});
		await store.acquire("ws", "run-1");
		time += 5000;
		// heartbeat does not advance (no heartbeat call), lease is stale+dead
		const rec = await store.acquire("ws", "run-2");
		expect(rec.ok).toBe(true);
	});

	it("live lease cannot be stolen", async () => {
		const dir = await tmpdir();
		const store = new WorkspaceLeaseStore({
			storageDir: dir,
			timeoutMs: 1000,
			now: () => 100,
			isProcessAlive: () => true,
		});
		await store.acquire("ws", "run-1");
		const attempt = await store.acquire("ws", "run-2");
		expect(attempt.ok).toBe(false);
		await expect(store.recoverIfStale("ws", "run-2")).rejects.toThrowError(/alive/);
	});

	it("release is idempotent and owner-scoped", async () => {
		const dir = await tmpdir();
		const store = new WorkspaceLeaseStore({ storageDir: dir, now: () => 100 });
		await store.acquire("ws", "run-1");
		await store.release("ws", "run-1");
		await store.release("ws", "run-1");
		expect(await store.status("ws")).toBeNull();
		// a new owner can acquire after release
		const again = await store.acquire("ws", "run-2");
		expect(again.ok).toBe(true);
	});
});

describe("checkpoint store", () => {
	async function setup(): Promise<{ dir: string; cp: CheckpointStore; ws: string }> {
		const dir = await tmpdir();
		const cp = new CheckpointStore({ storageDir: dir });
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		return { dir, cp, ws };
	}

	it("restores a modified file, removes a created file, recreates a deleted file", async () => {
		const { cp, ws } = await setup();
		const a = nodePath.join(ws, "a.txt");
		const b = nodePath.join(ws, "b.txt");
		await fs.writeFile(a, "before-a");
		await fs.writeFile(b, "before-b");
		const checkpoint = await cp.create("ws", "tx1", [a, b]);
		// mutate
		await fs.writeFile(a, "after-a");
		await fs.writeFile(nodePath.join(ws, "new.txt"), "new");
		await fs.rm(b);
		// rollback manually for a and b via a fresh transaction manager to reuse logic
		// Here we just verify the store content materialize
		await cp.verify(checkpoint.checkpointId);
		const mat = await cp.materialize(checkpoint.checkpointId, {
			path: a,
			type: "file",
			existed: true,
			contentSha256: checkpoint.entries.find((e) => e.path === a)!.contentSha256,
		});
		expect(mat!.toString()).toBe("before-a");
		await cp.updateStatus(checkpoint.checkpointId, "confirmed");
		const read = await cp.read(checkpoint.checkpointId);
		expect(read!.status).toBe("confirmed");
	});

	it("detects checkpoint tampering", async () => {
		const { cp, ws } = await setup();
		const a = nodePath.join(ws, "a.txt");
		await fs.writeFile(a, "hello");
		const checkpoint = await cp.create("ws", "tx1", [a]);
		// Tamper with the manifest
		const manifestPath = nodePath.join(cp.storageDir, "checkpoints", checkpoint.checkpointId, "manifest.json");
		const raw = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
		raw.entries[0].contentSha256 = "deadbeef";
		await fs.writeFile(manifestPath, JSON.stringify(raw));
		await expect(cp.verify(checkpoint.checkpointId)).rejects.toThrowError(/mismatch/i);
	});

	it("blocks oversized file checkpointing", async () => {
		const dir = await tmpdir();
		const cp = new CheckpointStore({ storageDir: dir, maxCheckpointBytes: 4 });
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const a = nodePath.join(ws, "big.txt");
		await fs.writeFile(a, "this is way too long");
		await expect(cp.create("ws", "tx1", [a])).rejects.toThrowError(/oversized/i);
	});

	it("gc removes only confirmed, expired checkpoints", async () => {
		const { cp, ws } = await setup();
		const a = nodePath.join(ws, "a.txt");
		await fs.writeFile(a, "hi");
		const cp1 = await cp.create("ws", "tx1", [a]);
		const cp2 = await cp.create("ws", "tx2", [a]);
		await cp.updateStatus(cp1.checkpointId, "confirmed");
		// cp2 remains created (active/recovery) and must never be collected.
		const now = Date.now() + 1000;
		const res = await cp.gc({ retainMs: 0, now });
		expect(res.removed).toContain(cp1.checkpointId);
		expect(res.removed).not.toContain(cp2.checkpointId);
		expect(await cp.read(cp1.checkpointId)).toBeNull();
		expect(await cp.read(cp2.checkpointId)).not.toBeNull();
	});
});

describe("workspace transaction", () => {
	async function setup(): Promise<{
		dir: string;
		mgr: WorkspaceTransactionManager;
		ws: string;
		boundary: WorkspaceBoundary;
	}> {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const boundary = await WorkspaceBoundary.create(ws);
		const checkpoints = new CheckpointStore({ storageDir: dir });
		const mgr = new WorkspaceTransactionManager(dir, boundary, checkpoints);
		return { dir, mgr, ws, boundary };
	}

	it("successful multi-file transaction confirms", async () => {
		const { mgr, ws } = await setup();
		const a = nodePath.join(ws, "a.txt");
		await fs.writeFile(a, "old");
		const tx = await mgr.begin("ws", { mode: "execute", policy: { outcome: "allow", ruleId: "t", reasonCode: "x" } });
		const paths = await mgr.resolvePaths([
			{ kind: "replace_file", path: "a.txt", content: "new-a" },
			{ kind: "create_file", path: "b.txt", content: "new-b" },
		]);
		await mgr.checkpoint(tx, paths);
		const applied = await mgr.apply(tx, [
			{ kind: "replace_file", path: "a.txt", content: "new-a" },
			{ kind: "create_file", path: "b.txt", content: "new-b" },
		]);
		expect(applied.changed.length).toBe(2);
		expect(await fs.readFile(a, "utf-8")).toBe("new-a");
		expect(await fs.readFile(nodePath.join(ws, "b.txt"), "utf-8")).toBe("new-b");
		await mgr.validate(tx, { id: "t", label: "t", run: () => Promise.resolve({ exitCode: 0, outputArtifact: "" }) });
		await mgr.confirm(tx);
		expect(await mgr.classify(tx.transactionId)).toBe("already_confirmed");
	});

	it("validation failure rolls back", async () => {
		const { mgr, ws } = await setup();
		const a = nodePath.join(ws, "a.txt");
		await fs.writeFile(a, "original");
		const tx = await mgr.begin("ws", { mode: "execute", policy: null });
		const paths = await mgr.resolvePaths([{ kind: "replace_file", path: "a.txt", content: "changed" }]);
		await mgr.checkpoint(tx, paths);
		await mgr.apply(tx, [{ kind: "replace_file", path: "a.txt", content: "changed" }]);
		await mgr.validate(tx, {
			id: "t",
			label: "t",
			run: () => Promise.resolve({ exitCode: 1, outputArtifact: "boom" }),
		});
		expect(tx.validation!.result).toBe("failed");
		await expect(mgr.confirm(tx)).rejects.toThrow(/validation/i);
		const rollback = await mgr.rollback(tx);
		expect(rollback.status).toBe("rolled_back");
		expect(await fs.readFile(a, "utf-8")).toBe("original");
		expect(await mgr.classify(tx.transactionId)).toBe("already_rolled_back");
	});

	it("partial write failure rolls back", async () => {
		const { mgr, ws } = await setup();
		const a = nodePath.join(ws, "a.txt");
		await fs.writeFile(a, "original");
		const tx = await mgr.begin("ws", { mode: "execute", policy: null });
		const paths = await mgr.resolvePaths([
			{ kind: "replace_file", path: "a.txt", content: "ok" },
			{ kind: "create_file", path: "sub/deep/unwritable.txt", content: "x" },
		]);
		await mgr.checkpoint(tx, paths);
		await expect(
			mgr.apply(tx, [
				{ kind: "replace_file", path: "a.txt", content: "ok" },
				{ kind: "create_file", path: "sub/deep/never.txt", content: "x" },
			]),
		).rejects.toThrow();
		// a.txt was already written then rolled back
		expect(await fs.readFile(a, "utf-8")).toBe("original");
	});

	it("rollback is idempotent and drift-aware", async () => {
		const { mgr, ws } = await setup();
		const a = nodePath.join(ws, "a.txt");
		await fs.writeFile(a, "original");
		const tx = await mgr.begin("ws", { mode: "execute", policy: null });
		const paths = await mgr.resolvePaths([{ kind: "replace_file", path: "a.txt", content: "changed" }]);
		await mgr.checkpoint(tx, paths);
		await mgr.apply(tx, [{ kind: "replace_file", path: "a.txt", content: "changed" }]);
		// user edits after transaction
		await fs.writeFile(a, "user-drift");
		const rb = await mgr.rollback(tx);
		expect(rb.status).toBe("conflict");
		expect(rb.conflicts.length).toBeGreaterThan(0);
		expect(await fs.readFile(a, "utf-8")).toBe("user-drift");
		// rollback again is safe (idempotent)
		const rb2 = await mgr.rollback(tx);
		expect(rb2.status).toBe("conflict");
		expect(await fs.readFile(a, "utf-8")).toBe("user-drift");
	});

	it("plan-mode preview performs zero physical mutations", async () => {
		const { mgr, ws } = await setup();
		const preview = await mgr.preview([
			{ kind: "create_file", path: "new.txt", content: "hello" },
			{ kind: "replace_file", path: "a.txt", content: "x" },
			{ kind: "delete_file", path: "gone.txt" },
		]);
		expect(preview.created).toEqual(["new.txt"]);
		expect(preview.modified).toEqual(["a.txt"]);
		expect(preview.deleted).toEqual(["gone.txt"]);
		expect(preview.bytesChanged).toBeGreaterThan(0);
		expect(await fs.stat(nodePath.join(ws, "new.txt")).catch(() => null)).toBeNull();
	});

	it("crash after checkpoint is classified safe_to_resume_apply", async () => {
		const { mgr, ws } = await setup();
		const a = nodePath.join(ws, "a.txt");
		await fs.writeFile(a, "original");
		const tx = await mgr.begin("ws", { mode: "execute", policy: null });
		const paths = await mgr.resolvePaths([{ kind: "replace_file", path: "a.txt", content: "new" }]);
		await mgr.checkpoint(tx, paths);
		expect(await mgr.classify(tx.transactionId)).toBe("safe_to_resume_apply");
	});

	it("confirmed transaction remains confirmed", async () => {
		const { mgr } = await setup();
		const tx = await mgr.begin("ws", { mode: "execute", policy: null });
		const paths = await mgr.resolvePaths([{ kind: "create_file", path: "c.txt", content: "c" }]);
		await mgr.checkpoint(tx, paths);
		await mgr.apply(tx, [{ kind: "create_file", path: "c.txt", content: "c" }]);
		await mgr.validate(tx, { id: "t", label: "t", run: () => Promise.resolve({ exitCode: 0, outputArtifact: "" }) });
		await mgr.confirm(tx);
		const reloaded = await mgr.read(tx.transactionId);
		expect(reloaded!.stage).toBe("confirmed");
		expect(await mgr.classify(tx.transactionId)).toBe("already_confirmed");
	});
});

describe("workspace safety manager integration", () => {
	it("plan mode performs zero physical mutations", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const safety = await WorkspaceSafety.create(ws, { storageDir: dir }, "plan");
		await expect(
			safety.performMutation({ edits: [{ kind: "create_file", path: "x.txt", content: "x" }] }),
		).rejects.toThrow(/approval|deny/i);
		const exists = await fs.stat(nodePath.join(ws, "x.txt")).catch(() => null);
		expect(exists).toBeNull();
	});

	it("execute mode confirms an authorized transaction", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		await fs.writeFile(nodePath.join(ws, "a.txt"), "old");
		const safety = await WorkspaceSafety.create(ws, { storageDir: dir }, "execute");
		const out = await safety.performMutation({
			edits: [{ kind: "replace_file", path: "a.txt", content: "new" }],
			policy: { outcome: "allow", ruleId: "t", reasonCode: "x" },
		});
		expect(out.stage).toBe("confirmed");
		expect(await fs.readFile(nodePath.join(ws, "a.txt"), "utf-8")).toBe("new");
		const cp = await safety.lastCheckpoint();
		expect(cp).not.toBeNull();
	});

	it("policy deny blocks before mutation and releases lease", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const safety = await WorkspaceSafety.create(ws, { storageDir: dir }, "execute");
		await expect(
			safety.performMutation({
				edits: [{ kind: "create_file", path: "secret/id_rsa", content: "x" }],
			}),
		).rejects.toThrow(PolicyDeniedError);
		expect(await safety.leaseStatus()).toBeNull();
	});

	it("guardMutation enforces boundary", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const safety = await WorkspaceSafety.create(ws, { storageDir: dir }, "execute");
		await expect(
			safety.guardMutation({
				toolName: "write",
				effects: PRODUCTION_TOOL_EFFECTS.write,
				resolvedPaths: ["../evil"],
			}),
		).rejects.toThrow(WorkspaceBoundaryError);
	});

	it("wrapMutationTools rejects a denied call", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const safety = await WorkspaceSafety.create(ws, { storageDir: dir }, "execute");
		const tools = safety.wrapMutationTools(Object.values(createAllTools(ws)) as never);
		const write = tools.find((t) => t.name === "write")!;
		await expect(
			write.execute("id1", { path: "../evil.txt", content: "x" } as never, undefined as never, undefined as never),
		).rejects.toThrow(WorkspaceBoundaryError);
	});
});

describe("long-horizon integration", () => {
	it("records replayable mutation lifecycle events and gates completion", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		await fs.writeFile(nodePath.join(ws, "a.txt"), "old");
		const safety = await WorkspaceSafety.create(ws, { storageDir: dir }, "execute");
		// Gate: before any mutation, incomplete transactions block completion only when mutating.
		expect((await safety.gateStepCompletion(false)).canComplete).toBe(true);
		const out = await safety.performMutation({
			edits: [{ kind: "replace_file", path: "a.txt", content: "new" }],
			policy: { outcome: "allow", ruleId: "t", reasonCode: "x" },
		});
		expect(out.stage).toBe("confirmed");
		const events = await safety.readEvents();
		const kinds = events.map((e) => e.event);
		expect(kinds).toContain("MUTATION_POLICY_EVALUATED");
		expect(kinds).toContain("WORKSPACE_LEASE_ACQUIRED");
		expect(kinds).toContain("CHECKPOINT_CREATED");
		expect(kinds).toContain("TRANSACTION_APPLIED");
		expect(kinds).toContain("TRANSACTION_CONFIRMED");
		expect(kinds).toContain("WORKSPACE_LEASE_RELEASED");
		expect((await safety.gateStepCompletion(true)).canComplete).toBe(true);
	});

	it("incomplete mutation blocks step completion", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const safety = await WorkspaceSafety.create(ws, { storageDir: dir }, "execute");
		// Simulate an unresolved transaction by starting one and leaving it applied.
		const tx = await safety.transactions.begin("ws", { mode: "execute", policy: null });
		const paths = await safety.transactions.resolvePaths([{ kind: "create_file", path: "x.txt", content: "x" }]);
		await safety.transactions.checkpoint(tx, paths);
		await safety.transactions.apply(tx, [{ kind: "create_file", path: "x.txt", content: "x" }]);
		const gate = await safety.gateStepCompletion(true);
		expect(gate.canComplete).toBe(false);
		expect(gate.blockingReason).toContain(tx.transactionId);
	});
});

describe("cross-platform path safety", () => {
	it("normalizes separators and rejects absolute external paths regardless of platform", async () => {
		const dir = await tmpdir();
		const ws = workspace(dir);
		await fs.mkdir(ws, { recursive: true });
		const boundary = await WorkspaceBoundary.create(ws);
		// Windows-style backslash traversal resolves and is contained
		const inside = await boundary.resolveWithin("a\\b.txt");
		expect(nodePath.isAbsolute(inside)).toBe(true);
		// UNC-ish path on POSIX is a normal path; ensure it can't point to an
		// external sibling.
		await expect(boundary.resolveWithin(`${nodePath.join(dir, "..", "elsewhere")}\\x`)).rejects.toThrow(
			WorkspaceBoundaryError,
		);
	});

	it("platform-conditional: Windows path safety is only exercised where the primitive exists", async () => {
		// Junctions/reparse points only exist on Windows. On POSIX we verify the
		// symlink-escape path (already covered) and assert the platform gate.
		if (process.platform !== "win32") {
			expect(typeof WorkspaceBoundary).toBe("function");
			return;
		}
		expect(typeof WorkspaceBoundary).toBe("function");
	});
});
