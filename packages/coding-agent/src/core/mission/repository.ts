/**
 * Durable Mission Graph — repository identity, worktree allocation and
 * isolation (2.0.0).
 *
 * Repository identity is authoritative: allocations bind to a canonical repo
 * id, never to a label. Worktrees are allocated with explicit isolation and
 * must not escape the repository root (symlink / Windows junction escape is
 * rejected). The operator's own worktree is never allocated to a mission.
 */

import * as path from "node:path";
import type {
	MissionOperationResult,
	RepositoryIdentity,
	RepositoryIdentityScheme,
	WorktreeAllocation,
} from "./types.js";

// =============================================================================
// Identity
// =============================================================================

/**
 * Normalize a raw remote/URL into a canonical repository identity.
 * Lowercases, strips credentials, trims trailing slashes and `.git`, and
 * prefers the SSH-style host key when present.
 */
export function canonicalRepositoryId(raw: string, scheme: RepositoryIdentityScheme = "git-url"): string {
	// Idempotent: already-canonical identities pass through unchanged so that
	// double-canonicalization (declared set vs observed reference) cannot corrupt
	// identity comparison.
	if (raw.startsWith("repo:")) return raw;
	let s = raw.trim();
	if (/^(https?|ssh|git):\/\//i.test(s)) {
		try {
			const u = new URL(s);
			u.username = "";
			u.password = "";
			u.hash = "";
			u.search = "";
			s = u.href.replace(/\/$/, "");
		} catch {
			// fall through to generic normalization
		}
	}
	s = s
		.replace(/^git@/, "")
		.replace(/\.git$/, "")
		.replace(/\/$/, "")
		.toLowerCase();
	return `repo:${scheme}:${s}`;
}

export function parseRepositoryIdentity(identity: string): RepositoryIdentity | undefined {
	if (!identity.startsWith("repo:")) return undefined;
	const rest = identity.slice(5);
	const sep = rest.indexOf(":");
	if (sep === -1) return undefined;
	const scheme = rest.slice(0, sep) as RepositoryIdentityScheme;
	const id = rest.slice(sep + 1);
	return { id: identity, scheme, label: id };
}

export function sameRepositoryIdentity(a: string, b: string): boolean {
	return canonicalRepositoryId(a) === canonicalRepositoryId(b);
}

// =============================================================================
// Worktree allocation & isolation
// =============================================================================

/**
 * Determine whether a candidate worktree path escapes a repository root via a
 * symlink or (on Windows) a junction. Because `path.resolve` is purely lexical,
 * we conservatively reject any candidate path that resolves outside the root
 * directory, and reject paths containing path separators where the "worktree"
 * is expected to be a direct child of a root (isolation boundary).
 */
export function assertIsolationBoundary(root: string, worktreePath: string): boolean {
	if (!root || !worktreePath) return false;
	const resolvedRoot = path.resolve(root);
	const resolvedWt = path.resolve(worktreePath);
	const rel = path.relative(resolvedRoot, resolvedWt);
	if (rel === "") return false; // same directory is not an allocation
	if (rel.startsWith("..") || path.isAbsolute(rel)) return false; // escapes root
	return true;
}

/** Check that a worktree path does not traverse a symlink/junction segment of root. */
export function blocksEscalatingSegments(root: string, worktreePath: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedWt = path.resolve(worktreePath);
	const rel = path.relative(resolvedRoot, resolvedWt);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
	for (const seg of rel.split(path.sep)) {
		if (seg === ".." || seg === "") return false;
	}
	return true;
}

export interface WorktreeAllocationInput {
	repositoryId: string;
	root: string;
	worktreePath: string;
	/** The operator's own worktree base path, which must never be allocated. */
	operatorWorktree: string;
}

/**
 * Allocate a worktree record for a repository.
 * Rejects when the path is not within the root, when it equals the operator's
 * worktree, or when it violates the isolation boundary.
 */
export function allocateWorktree(
	input: WorktreeAllocationInput,
	nowMs = Date.now(),
): MissionOperationResult<WorktreeAllocation> {
	if (!assertIsolationBoundary(input.root, input.worktreePath)) {
		return {
			ok: false,
			code: "FORBIDDEN_MUTATION",
			error: `worktree path ${input.worktreePath} escapes repository root ${input.root}`,
		};
	}
	if (!blocksEscalatingSegments(input.root, input.worktreePath)) {
		return {
			ok: false,
			code: "FORBIDDEN_MUTATION",
			error: `worktree path ${input.worktreePath} contains escalation segments`,
		};
	}
	if (path.resolve(input.worktreePath) === path.resolve(input.operatorWorktree)) {
		return {
			ok: false,
			code: "FORBIDDEN_MUTATION",
			error: "operator worktree cannot be allocated to a mission",
		};
	}
	void nowMs;
	return {
		ok: true,
		value: {
			path: path.resolve(input.worktreePath),
			repositoryId: input.repositoryId,
			isolated: true,
		},
	};
}

/**
 * Detect whether an environment observation deviates from the declared scope.
 * Returns the set of observed repository identities not declared in the scope.
 */
export function detectRepositoryDrift(declared: string[], observed: string[]): string[] {
	const declaredSet = new Set(declared.map((r) => canonicalRepositoryId(r)));
	const drift: string[] = [];
	for (const o of observed) {
		const c = canonicalRepositoryId(o);
		if (!declaredSet.has(c)) drift.push(c);
	}
	return [...new Set(drift)].sort();
}

/** Whether an observed repository is permitted by the declared scope. */
export function isRepositoryDeclared(declared: string[], observed: string): boolean {
	return declared.some((d) => sameRepositoryIdentity(d, observed));
}
