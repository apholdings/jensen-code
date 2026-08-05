/**
 * Durable Mission Graph — repository identity, worktree isolation, drift.
 */

import { describe, expect, it } from "vitest";
import {
	allocateWorktree,
	canonicalRepositoryId,
	detectRepositoryDrift,
	isRepositoryDeclared,
	sameRepositoryIdentity,
} from "../../src/core/mission/index.js";

describe("mission repository identity", () => {
	it("REPOSITORY_IDENTITY is canonical and credential-free", () => {
		const a = canonicalRepositoryId("https://user:pass@github.com/org/repo.git");
		const b = canonicalRepositoryId("https://github.com/org/repo");
		expect(a).toBe("repo:git-url:https://github.com/org/repo");
		expect(sameRepositoryIdentity(a, b)).toBe(true);
	});

	it("REMOTE_IDENTITY distinguishes different remotes", () => {
		expect(sameRepositoryIdentity("git@github.com:org/repo", "git@github.com:other/repo")).toBe(false);
	});

	it("MULTI_REPOSITORY declares independent identities", () => {
		const r1 = canonicalRepositoryId("https://github.com/a/one");
		const r2 = canonicalRepositoryId("https://github.com/b/two");
		expect(r1).not.toBe(r2);
	});

	it("isRepositoryDeclared matches within scope", () => {
		expect(
			isRepositoryDeclared([canonicalRepositoryId("https://github.com/a/one")], "https://github.com/a/one.git"),
		).toBe(true);
		expect(
			isRepositoryDeclared([canonicalRepositoryId("https://github.com/a/one")], "https://github.com/z/nope"),
		).toBe(false);
	});
});

describe("mission worktree isolation", () => {
	it("MULTI_WORKTREE_ISOLATION rejects allocations outside the root", () => {
		const r = allocateWorktree({
			repositoryId: canonicalRepositoryId("https://github.com/a/one"),
			root: "/work/root",
			worktreePath: "/elsewhere/target",
			operatorWorktree: "/home/user/op",
		});
		expect(r.ok).toBe(false);
		expect(r.code).toBe("FORBIDDEN_MUTATION");
	});

	it("SYMLINK_ESCAPE_BLOCKED via lexical path traversal", () => {
		const r = allocateWorktree({
			repositoryId: "repo:x",
			root: "/work/root",
			worktreePath: "/work/root/../../etc/passwd-dir",
			operatorWorktree: "/home/user/op",
		});
		expect(r.ok).toBe(false);
	});

	it("allocates an isolated worktree within the root", () => {
		const r = allocateWorktree({
			repositoryId: "repo:x",
			root: "/work/root",
			worktreePath: "/work/root/repos/r1",
			operatorWorktree: "/home/user/op",
		});
		expect(r.ok).toBe(true);
		expect(r.value?.isolated).toBe(true);
		expect(r.value?.path).toBe("/work/root/repos/r1");
	});

	it("OPERATOR_WORKTREE_UNTOUCHED cannot be allocated", () => {
		const op = "/home/user/op";
		const r = allocateWorktree({
			repositoryId: "repo:x",
			root: "/home/user",
			worktreePath: op,
			operatorWorktree: op,
		});
		expect(r.ok).toBe(false);
	});
});

describe("mission repository drift", () => {
	it("detects drift and allows declared repositories", () => {
		const declared = [canonicalRepositoryId("https://github.com/a/one")];
		const observed = [
			"https://github.com/a/one.git", // declared (canonical-equal)
			"https://github.com/rogue/other", // undeclared
		];
		const drift = detectRepositoryDrift(declared, observed);
		expect(drift).toContain(canonicalRepositoryId("https://github.com/rogue/other"));
		expect(drift).not.toContain(canonicalRepositoryId("https://github.com/a/one"));
	});
});
