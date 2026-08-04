/**
 * Canonical workspace identity resolution.
 *
 * The identity must be stable across symlink/junction-safe realpaths, distinct
 * per repository and per worktree, and carry no secret content. Branch and HEAD
 * are metadata, never the sole identity.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/** Current workspace index schema version. */
export const INDEX_SCHEMA_VERSION = 1;

export interface ResolvedWorkspaceIdentity {
	workspaceId: string;
	canonicalRoot: string;
	filesystemIdentity: string;
	gitRepositoryId?: string;
	gitCommonDir?: string;
	worktreeId?: string;
	branch?: string;
	headCommit?: string;
}

function safeExec(argv: string[]): string | undefined {
	try {
		const out = execSync(argv.join(" "), {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});
		return out.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve canonical root (symlink/junction-safe) and git identity for a path.
 * Never throws for a usable filesystem path.
 */
export function resolveWorkspaceIdentity(cwd: string): ResolvedWorkspaceIdentity {
	const abs = path.resolve(cwd);
	let canonicalRoot = abs;
	try {
		if (existsSync(abs)) canonicalRoot = realpathSync(abs);
	} catch {
		canonicalRoot = abs;
	}

	const filesystemIdentity = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 32);

	let gitCommonDir: string | undefined;
	let gitRepositoryId: string | undefined;
	let worktreeId: string | undefined;
	let branch: string | undefined;
	let headCommit: string | undefined;

	const common = safeExec(["rev-parse", "--git-common-dir"]);
	const topLevel = safeExec(["rev-parse", "--show-toplevel"]);
	const gitDir = safeExec(["rev-parse", "--absolute-git-dir"]);

	if (common) {
		gitCommonDir = path.resolve(abs, common);
		try {
			gitCommonDir = realpathSync(gitCommonDir);
		} catch {
			/* keep resolved form */
		}
		// Repository identity is the common dir (shared across worktrees).
		gitRepositoryId = createHash("sha256").update(gitCommonDir).digest("hex").slice(0, 32);
	}

	if (gitDir && topLevel) {
		// worktree identity is the actual working git dir when it differs from common.
		const resolvedGitDir = path.resolve(abs, gitDir);
		if (!gitCommonDir || resolvedGitDir !== gitCommonDir) {
			worktreeId = createHash("sha256").update(resolvedGitDir).digest("hex").slice(0, 32);
		}
		branch = safeExec(["rev-parse", "--abbrev-ref", "HEAD"]);
		headCommit = safeExec(["rev-parse", "HEAD"]);
	}

	const topRoot = topLevel ? path.resolve(abs, topLevel) : canonicalRoot;

	// Stable workspace id: prefer git repository identity, else filesystem identity.
	const identityBase = gitRepositoryId ?? filesystemIdentity;
	const workspaceId = createHash("sha256")
		.update(`${identityBase}:${worktreeId ?? ""}:${normalizeForIdentity(topRoot, worktreeId)}`)
		.digest("hex")
		.slice(0, 32);

	return {
		workspaceId,
		canonicalRoot: topRoot,
		filesystemIdentity,
		gitRepositoryId,
		gitCommonDir,
		worktreeId,
		branch,
		headCommit,
	};
}

/** Case-normalization appropriate to platform (lowercase on win32). */
function normalizeForIdentity(p: string, worktreeId?: string): string {
	let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
	if (process.platform === "win32") s = s.toLowerCase();
	// Include worktree id so two worktrees of the same repo don't conflate even
	// if the common repo was already used as the primary base.
	if (worktreeId) s = `${s}#${worktreeId}`;
	return s;
}

export interface IdentityMeta extends ResolvedWorkspaceIdentity {
	indexVersion: number;
}

export function toIdentityMeta(identity: ResolvedWorkspaceIdentity): IdentityMeta {
	return { ...identity, indexVersion: INDEX_SCHEMA_VERSION };
}

/**
 * Compute the storage root for workspace index data. Never inside the source
 * directory by default. Per-workspace isolation is achieved with subdirectories
 * keyed by workspace id.
 */
export function defaultIndexRoot(): string {
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
		return path.join(local, "jensen", "index");
	}
	if (process.platform === "darwin") {
		return path.join(homedir(), "Library", "Caches", "jensen", "index");
	}
	const xdg = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
	return path.join(xdg, "jensen", "index");
}

export function workspaceIndexDir(root: string, workspaceId: string): string {
	return path.join(root, workspaceId);
}

/** Temporary sibling used during atomic generation replacement. */
export function tempDirUnder(root: string): string {
	return path.join(root, ".tmp");
}

export function systemTempDir(): string {
	return tmpdir();
}
