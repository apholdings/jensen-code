/**
 * Git metadata collection and worktree invalidation.
 *
 * Git is used only as a bounded ranking/invalidation signal, never as a
 * rollback mechanism. Current workspace content remains authoritative. Never
 * runs destructive Git commands.
 */

import { execSync } from "node:child_process";
import path from "node:path";

export interface GitFileMeta {
	workspaceRelativePath: string;
	lastCommit?: string;
	lastCommitTime?: string;
	changeCount: number;
	gitBlobId?: string;
	isTracked: boolean;
}

export interface WorktreeFingerprint {
	gitHead?: string;
	branch?: string;
	worktreeId?: string;
	statusHash: string;
	dirty: boolean;
}

export interface GitSnapshot {
	files: Map<string, GitFileMeta>; // keyed by workspace-relative path
	fingerprint: WorktreeFingerprint;
}

function git(cwd: string, args: string[]): { out: string; ok: boolean } {
	try {
		const out = execSync(`git ${args.join(" ")}`, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10000,
		});
		return { out: out.trim(), ok: true };
	} catch {
		return { out: "", ok: false };
	}
}

/** Determine if cwd is inside a git repository. */
export function isGitRepo(cwd: string): boolean {
	return git(cwd, ["rev-parse", "--is-inside-work-tree"]).out === "true";
}

/** Compute a dirty-state fingerprint for a worktree. */
export function worktreeStatusSnapshot(cwd: string): { dirty: boolean; hash: string } {
	const res = git(cwd, ["status", "--porcelain"]);
	if (!res.ok) return { dirty: false, hash: "no-git" };
	const lines = res.out.split("\n").filter(Boolean).sort();
	return { dirty: lines.length > 0, hash: lines.join("|") || "clean" };
}

/** Compute the worktree fingerprint used in generation source snapshots. */
export function computeWorktreeFingerprint(
	cwd: string,
	worktreeId?: string,
): { gitHead?: string; branch?: string; dirty: boolean; statusHash: string; fingerprint: string } {
	const head = git(cwd, ["rev-parse", "HEAD"]).out || undefined;
	const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).out || undefined;
	const status = worktreeStatusSnapshot(cwd);
	const fingerprint = `${worktreeId ?? ""}|${head ?? ""}|${branch ?? ""}|${status.hash}`;
	return { gitHead: head, branch, dirty: status.dirty, statusHash: status.hash, fingerprint };
}

/** Collect bounded Git metadata for a set of files (tracked/untracked + shallow history). */
export function collectGitMetadata(
	cwd: string,
	relativePaths: string[],
	opts: { historyDepth?: number } = {},
): GitSnapshot {
	const map = new Map<string, GitFileMeta>();
	const fingerprint = computeWorktreeFingerprint(cwd);
	const historyDepth = Math.max(0, opts.historyDepth ?? 5);

	for (const rel of relativePaths) {
		map.set(rel, {
			workspaceRelativePath: rel,
			changeCount: 0,
			isTracked: false,
		});
	}

	// Which files are tracked? Use git ls-files.
	const tracked = new Set<string>();
	const ls = git(cwd, ["ls-files"]);
	if (ls.ok) for (const f of ls.out.split("\n")) if (f) tracked.add(f.replace(/\\/g, "/"));
	// Real paths (files may be symlinked); compare basenames to handle casing.
	for (const rel of relativePaths) {
		const meta = map.get(rel);
		if (!meta) continue;
		meta.isTracked = tracked.has(rel);
		if (!meta.isTracked) {
			// Case-insensitive fallback (Windows).
			for (const t of tracked) {
				if (t.toLowerCase() === rel.toLowerCase()) {
					meta.isTracked = true;
					break;
				}
			}
		}
	}

	// Bounded per-file history (git log for diamonds is bounded by historyDepth).
	if (historyDepth > 0) {
		const chunks: string[][] = [];
		for (let i = 0; i < relativePaths.length; i += 40) chunks.push(relativePaths.slice(i, i + 40));
		for (const batch of chunks) {
			if (batch.length === 0) continue;
			const pathspec = batch.map((p) => `-- '${p.replace(/'/g, "''")}'`).join(" ");
			const res = git(cwd, [
				"log",
				"--format=%H|%ct",
				`-n`,
				`${historyDepth}`,
				`--name-only`,
				`--date=unix`,
				pathspec,
			]);
			if (!res.ok) continue;
			const lines = res.out.split("\n");
			let currentHash = "";
			let currentTime = "";
			for (const line of lines) {
				const hmm = line.match(/^([0-9a-f]{40})\|(\d+)$/);
				if (hmm) {
					currentHash = hmm[1];
					currentTime = hmm[2];
					continue;
				}
				if (line.startsWith(" ") || line === "") continue;
				const rel = line.replace(/\\/g, "/");
				const meta = findMeta(map, rel) ?? map.get(rel);
				if (!meta) continue;
				if (!meta.lastCommit) {
					meta.lastCommit = currentHash || undefined;
					meta.lastCommitTime = currentTime ? new Date(Number(currentTime) * 1000).toISOString() : undefined;
				}
				meta.changeCount++;
			}
		}
	}

	// Resolve blob ids for tracked files cheaply (bounded) — optional and lazy.
	return { files: map, fingerprint };
}

function findMeta(map: Map<string, GitFileMeta>, rel: string): GitFileMeta | undefined {
	const direct = map.get(rel);
	if (direct) return direct;
	for (const key of map.keys()) {
		if (key.toLowerCase() === rel.toLowerCase()) return map.get(key);
	}
	return undefined;
}

/** Returns the absolute path of the git blob not needed; helper kept for API completeness. */
export function gitExec(cwd: string, args: string[]): { out: string; ok: boolean } {
	return git(cwd, args);
}

/** Detect whether two worktree fingerprints differ materially. */
export function fingerprintChanged(a?: string, b?: string): boolean {
	return Boolean(a && b && a !== b);
}

/** Verify a workspace root is a git repo without throwing. */
export function safeResolveGitTopLevel(cwd: string): string | undefined {
	const res = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!res.ok) return undefined;
	return path.resolve(cwd, res.out);
}
