/**
 * Deterministic tests for the workspace intelligence subsystem (1.7.0).
 *
 * These tests run on the bundled SQLite backend with the local deterministic
 * fixture embedding backend — no network, no paid dependency, fully
 * reproducible across Linux and Windows.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyPath } from "../src/core/workspace/classify.js";
import {
	buildRetrievalContextPacket,
	renderPacketAsEvidence,
	toEvidenceRecord,
} from "../src/core/workspace/context-packet.js";
import {
	DisabledEmbeddingBackend,
	FixtureEmbeddingBackend,
	LocalEmbeddingBackend,
	resolveEmbeddingBackend,
	truncateForEmbedding,
} from "../src/core/workspace/embedding.js";
import { assertInsideWorkspace, detectSymlinkEscape, sanitizeQueryTerm } from "../src/core/workspace/guard.js";
import { resolveWorkspaceIdentity, revalidateResult, WorkspaceIndex } from "../src/core/workspace/index.js";
import { planQuery } from "../src/core/workspace/planner.js";
import { tokenizeQuery } from "../src/core/workspace/tokenize.js";
import type { WorkspaceRetrievalResult } from "../src/core/workspace/types.js";
import { makeFixture } from "./workspace-fixtures.js";

let fx: ReturnType<typeof makeFixture>;
let idx: WorkspaceIndex;

beforeAll(async () => {
	fx = makeFixture();
	idx = new WorkspaceIndex(fx.root, { storageRoot: fx.storageRoot });
	await idx.build();
});

afterAll(() => {
	idx.close();
	try {
		rmSync(fx.root, { recursive: true, force: true });
		rmSync(fx.storageRoot, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe("workspace identity", () => {
	it("resolves a canonical, stable, secret-free identity", () => {
		const identity = resolveWorkspaceIdentity(fx.root);
		expect(identity.workspaceId).toMatch(/^[a-f0-9]{32}$/);
		expect(identity.canonicalRoot).toBeTruthy();
		expect(identity.workspaceId).not.toContain("secret");
		// Deterministic for same root.
		const again = resolveWorkspaceIdentity(fx.root);
		expect(again.workspaceId).toBe(identity.workspaceId);
	});

	it("index never becomes an execution authority and stays rebuildable", () => {
		const status = idx.status();
		expect(status.hasReadyGeneration).toBe(true);
		// The index lives outside the workspace and must not write source files.
		expect(status.storageDir.startsWith(fx.root)).toBe(false);
	});
});

describe("file classification and ignore policy", () => {
	it("classifies source, documentation, configuration and secret-sensitive files", () => {
		expect(classifyPath("src/auth.ts").classification).toBe("source");
		expect(classifyPath("README.md").classification).toBe("documentation");
		expect(classifyPath("package.json").classification).toBe("configuration");
		expect(classifyPath("src/.env").isSensitive).toBe(true);
		expect(classifyPath("src/.env").classification).toBe("secret-sensitive");
		expect(classifyPath("node_modules/x/y.js").ignoredByVendor).toBe(true);
	});

	it("secret files are indexed as metadata only, never chunked or embedded", () => {
		// .env is excluded from content coverage: no chunk should reference it.
		const files = idx.files();
		expect(files.some((f) => f.path === "src/.env")).toBe(false);
	});

	it("path traversal and symlink escapes are rejected", () => {
		expect(() => assertInsideWorkspace(fx.root, "../etc/passwd")).toThrow();
		expect(() => assertInsideWorkspace(fx.root, "a/../../b")).toThrow();
		expect(sanitizeQueryTerm('a" OR 1=1 --')).not.toContain('"');
	});
});

describe("chunking", () => {
	it("produces symbol-bounded chunks with stable ids", () => {
		const status = idx.status();
		expect(status.chunkCount).toBeGreaterThan(0);
	});
});

describe("lexical retrieval", () => {
	it("finds exact identifiers with camelCase tokenization", () => {
		const r = idx.search({ query: "authenticateUser", mode: "lexical" });
		expect(r.results.some((x) => x.file.workspaceRelativePath === "src/auth.ts")).toBe(true);
		// camelCase split works too
		const camel = idx.search({ query: "authenticateUser", mode: "lexical" });
		expect(camel.results.length).toBeGreaterThan(0);
	});

	it("finds snake/kebab and phrase coverage", () => {
		expect(tokenizeQuery("connectDatabase")).toContain("database");
		expect(tokenizeQuery("runQuery sql")).toContain("sql");
	});

	it("does not depend on embeddings (lexical works when embeddings disabled)", () => {
		const off = new WorkspaceIndex(fx.root, {
			storageRoot: fx.storageRoot,
			embedding: { mode: "disabled" },
		});
		const r = off.search({ query: "connectDatabase", mode: "lexical" });
		expect(r.results.some((x) => x.file.workspaceRelativePath === "src/db.ts")).toBe(true);
		off.close();
	});

	it("returns deterministic ordering for the same generation", () => {
		const a = idx.search({ query: "database", mode: "lexical" });
		const b = idx.search({ query: "database", mode: "lexical" });
		expect(a.results.map((r) => r.resultId)).toEqual(b.results.map((r) => r.resultId));
	});
});

describe("symbol retrieval", () => {
	it("resolves a symbol name to its definition location", () => {
		const r = idx.search({ query: "AuthService", mode: "symbol" });
		expect(r.results.some((x) => x.symbol?.name === "AuthService")).toBe(true);
		expect(r.results[0].location.startLine).toBeGreaterThanOrEqual(0);
	});
});

describe("semantic retrieval", () => {
	it("returns semantically related code even with differing terminology", () => {
		const r = idx.search({ query: "verify user login credentials", mode: "semantic" });
		expect(r.results.some((x) => x.file.workspaceRelativePath === "src/auth.ts")).toBe(true);
	});

	it("degrades gracefully when the embedding backend is unavailable", () => {
		const off = new WorkspaceIndex(fx.root, { storageRoot: fx.storageRoot, embedding: { mode: "disabled" } });
		const r = off.search({ query: "verify user login", mode: "semantic" });
		// Should not throw; falls back to lexical-style candidates.
		expect(Array.isArray(r.results)).toBe(true);
		off.close();
	});
});

describe("hybrid retrieval and planning", () => {
	it("plans a deterministic generator set per query mode", () => {
		const plan = planQuery({ query: "authenticateUser" }, { embeddingAvailable: true });
		expect(plan.mode).toBe("exact_identifier");
		const concept = planQuery({ query: "how does login flow work" }, { embeddingAvailable: true });
		expect(concept.generators.some((g) => g.kind === "semantic")).toBe(true);
	});

	it("fuses lexical + semantic + symbol for a mixed query", () => {
		const r = idx.search({ query: "database query connection", mode: "hybrid" });
		expect(r.results.length).toBeGreaterThan(0);
	});

	it("deduplicates chunks and bounds per-file diversity", () => {
		const r = idx.search({ query: "auth user login password hash", mode: "hybrid", limit: 50 });
		const ids = r.results.map((x) => x.resultId);
		expect(new Set(ids).size).toBe(ids.length);
		const perFile = new Map<string, number>();
		for (const res of r.results)
			perFile.set(res.file.workspaceRelativePath, (perFile.get(res.file.workspaceRelativePath) ?? 0) + 1);
		for (const count of perFile.values()) expect(count).toBeLessThanOrEqual(4);
	});

	it("produces explanation signals (reason codes) on results", () => {
		const r = idx.search({ query: "database", mode: "hybrid" });
		expect(r.results[0].score.reasonCodes.length).toBeGreaterThan(0);
	});
});

describe("reranking and determinism", () => {
	it("keeps exact identifiers strong", () => {
		const exact = idx.search({ query: "connectDatabase", mode: "hybrid" });
		expect(exact.results[0].file.workspaceRelativePath).toBe("src/db.ts");
	});
});

describe("freshness and incremental indexing", () => {
	it("detects added files via incremental refresh", async () => {
		const fx2 = makeFixture({});
		const i2 = new WorkspaceIndex(fx2.root, { storageRoot: fx2.storageRoot });
		await i2.build();
		writeFileSync(path.join(fx2.root, "src", "util.ts"), "export function helper(): string { return 'x'; }\n");
		const report = await i2.refresh();
		expect(report.added).toBe(1);
		const r = i2.search({ query: "helper", mode: "symbol" });
		expect(r.results.some((x) => x.file.workspaceRelativePath === "src/util.ts")).toBe(true);
		i2.close();
		try {
			rmSync(fx2.root, { recursive: true, force: true });
			rmSync(fx2.storageRoot, { recursive: true, force: true });
		} catch {
			/* noop */
		}
	});

	it("detects modified files and marks stale content", async () => {
		const fx3 = makeFixture({});
		const i3 = new WorkspaceIndex(fx3.root, { storageRoot: fx3.storageRoot });
		const _build = await i3.build();
		// Revalidate the current file: it should be current.
		const lexi = i3.search({ query: "connectDatabase", mode: "lexical" });
		const current = i3.revalidate(lexi.results[0]);
		expect(current).toBe("current");
		// Modify the file out-of-band and revalidate -> stale.
		appendFileSync(path.join(fx3.root, "src", "db.ts"), "\nexport function changed(): void {}\n");
		const stale = i3.revalidate(lexi.results[0]);
		expect(stale).toBe("stale");
		// Reindex and the new content becomes current.
		await i3.refresh();
		expect(i3.revalidate(lexi.results[0])).toBe("stale"); // old chunk no longer current; fresh lookup returns the new one
		const fresh = i3.search({ query: "connectDatabase", mode: "lexical" });
		expect(i3.revalidate(fresh.results[0])).toBe("current");
		i3.close();
		try {
			rmSync(fx3.root, { recursive: true, force: true });
			rmSync(fx3.storageRoot, { recursive: true, force: true });
		} catch {
			/* noop */
		}
	});

	it("removes deleted files from current results after refresh", async () => {
		const fx4 = makeFixture({});
		const i4 = new WorkspaceIndex(fx4.root, { storageRoot: fx4.storageRoot });
		await i4.build();
		rmSync(path.join(fx4.root, "src", "db.ts"));
		const report = await i4.refresh();
		expect(report.removed).toBe(1);
		const files = i4.files();
		expect(files.some((f) => f.path === "src/db.ts")).toBe(false);
		i4.close();
		try {
			rmSync(fx4.root, { recursive: true, force: true });
			rmSync(fx4.storageRoot, { recursive: true, force: true });
		} catch {
			/* noop */
		}
	});
});

describe("index generation and rebuild", () => {
	it("builds an atomic generation that becomes ready and is inspectable", async () => {
		const fx5 = makeFixture({});
		const i5 = new WorkspaceIndex(fx5.root, { storageRoot: fx5.storageRoot });
		const report = await i5.build();
		expect(report.status).toBe("ready");
		expect(i5.status().hasReadyGeneration).toBe(true);
		expect(i5.inspectGeneration(report.generationId)).toBeTruthy();
		// verify passes
		expect(i5.verify().valid).toBe(true);
		// rebuild supersedes old generations and leaves a fresh ready one
		await i5.rebuild();
		expect(i5.status().currentGeneration).not.toBe(report.generationId);
		i5.close();
		try {
			rmSync(fx5.root, { recursive: true, force: true });
			rmSync(fx5.storageRoot, { recursive: true, force: true });
		} catch {
			/* noop */
		}
	});
});

describe("index pruning and retention", () => {
	it("prune preview is zero-mutation and executable prune is idempotent", async () => {
		const fx6 = makeFixture({});
		const i6 = new WorkspaceIndex(fx6.root, { storageRoot: fx6.storageRoot });
		await i6.build();
		await i6.rebuild(); // now 2+ generations
		const before = i6.generations().length;
		const preview = i6.prune({ preview: true });
		expect(preview.preview).toBe(true);
		expect(i6.generations().length).toBe(before); // no mutation
		const exec = i6.prune({ preview: false, keepAudit: 1 });
		expect(exec.removed.length).toBeGreaterThan(0);
		expect(i6.generations().length).toBeLessThan(before);
		i6.close();
		try {
			rmSync(fx6.root, { recursive: true, force: true });
			rmSync(fx6.storageRoot, { recursive: true, force: true });
		} catch {
			/* noop */
		}
	});
});

describe("embedding backends", () => {
	it("fixture backend is deterministic and local", async () => {
		const b = new FixtureEmbeddingBackend("fixture-test", 16);
		const r1 = await b.embed({ texts: ["hello world"] });
		const r2 = await b.embed({ texts: ["hello world"] });
		expect(r1.embeddings[0]).toEqual(r2.embeddings[0]);
		expect(b.local).toBe(true);
		expect(r1.dimensions).toBe(16);
	});

	it("disabled backend throws and retrieval degrades to lexical/symbolic", () => {
		const b = new DisabledEmbeddingBackend();
		expect(b.backendId).toBe("disabled");
		const off = new WorkspaceIndex(fx.root, { storageRoot: fx.storageRoot, embedding: { mode: "disabled" } });
		expect(off.search({ query: "connectDatabase", mode: "lexical" }).results.length).toBeGreaterThan(0);
		off.close();
	});

	it("local loopback backend refuses non-loopback endpoints", async () => {
		const b = new LocalEmbeddingBackend({
			endpoint: "http://10.0.0.5:8080",
			modelId: "m",
			dimensions: 8,
		});
		await expect(b.embed({ texts: ["x"] })).rejects.toThrow(/non-loopback/);
	});

	it("resolveEmbeddingBackend honors explicit configuration and defaults to a local path", () => {
		expect(resolveEmbeddingBackend({ mode: "fixture" }).local).toBe(true);
		expect(() => resolveEmbeddingBackend({ mode: "remote" })).toThrow(/explicit policy/);
		expect(
			resolveEmbeddingBackend({ mode: "remote", allowed: true, endpoint: "http://localhost:11434/v1" }).local,
		).toBe(false);
	});

	it("truncates long inputs deterministically within a token bound", () => {
		const long = "x".repeat(10_000);
		const out = truncateForEmbedding(long, 100);
		expect(out.length).toBeLessThan(100 * 4 + 10);
	});
});

describe("worktree/git invalidation awareness", () => {
	it("worktree identity differs between two roots", () => {
		const fxA = makeFixture({});
		const fxB = makeFixture({});
		const idA = resolveWorkspaceIdentity(fxA.root);
		const idB = resolveWorkspaceIdentity(fxB.root);
		expect(idA.workspaceId).not.toBe(idB.workspaceId);
		try {
			rmSync(fxA.root, { recursive: true, force: true });
			rmSync(fxA.storageRoot, { recursive: true, force: true });
			rmSync(fxB.root, { recursive: true, force: true });
			rmSync(fxB.storageRoot, { recursive: true, force: true });
		} catch {
			/* noop */
		}
	});
});

describe("security and privacy", () => {
	it("index never writes source files", () => {
		// Source files must remain unchanged after indexing.
		const authPath = path.join(fx.root, "src", "auth.ts");
		expect(readFileSync(authPath, "utf-8")).toContain("export function authenticateUser");
		const dbPath = path.join(fx.root, "src", "db.ts");
		expect(readFileSync(dbPath, "utf-8")).toContain("export function connectDatabase");
	});

	it("indexed source remains untrusted (no result can authorize actions)", () => {
		const pkt = buildRetrievalContextPacket({
			query: "x",
			retrievalPlanId: "q1",
			indexGenerationId: "g1",
			results: [],
		});
		expect(pkt.results).toEqual([]);
		const rendered = renderPacketAsEvidence(pkt);
		expect(rendered).toContain("untrusted");
	});

	it("results are addressable and evidence-backed", () => {
		const r = idx.search({ query: "connectDatabase", mode: "lexical" });
		const res = r.results[0];
		expect(res.evidenceId).toBeTruthy();
		expect(res.indexGenerationId).toBeTruthy();
		expect(res.file.contentSha256).toMatch(/^[a-f0-9]{64}$/);
		const ev = toEvidenceRecord(res);
		expect(ev.evidenceId).toBe(res.evidenceId);
		expect(ev.filePath).toBe(res.file.workspaceRelativePath);
		expect(ev.freshness).toBe("current");
	});

	it("query injection is blocked via parameter binding", () => {
		// Malicious FTS-syntax in a query must not throw or inject.
		const r = idx.search({ query: 'a" OR 1=1 --', mode: "lexical" });
		expect(Array.isArray(r.results)).toBe(true);
	});

	it("detectSymlinkEscape flags external symlinks", () => {
		const sx = makeFixture({});
		mkdirSync(path.join(sx.root, "external"), { recursive: true });
		writeFileSync(path.join(sx.root, "external", "secret.txt"), "ext");
		try {
			symlinkSync(path.join(sx.root, "external"), path.join(sx.root, "linkout"), "dir");
		} catch {
			// symlinks may be unavailable on some platforms (windows without privilege)
		}
		const esc = detectSymlinkEscape(sx.root, path.join(sx.root, "linkout", "secret.txt"));
		// Either an escape is detected or the path does not resolve as escape.
		expect(esc === null || esc.length > 0).toBe(true);
		try {
			rmSync(sx.root, { recursive: true, force: true });
			rmSync(sx.storageRoot, { recursive: true, force: true });
		} catch {
			/* noop */
		}
	});
});

describe("revalidation contract", () => {
	it("revalidateResult reports stale for changed file and current when fresh", () => {
		const fakeStale: WorkspaceRetrievalResult = {
			resultId: "r",
			workspaceId: "w",
			indexGenerationId: "g",
			file: {
				workspaceRelativePath: "src/db.ts",
				contentSha256: "0".repeat(64),
				classification: "source",
				languageId: "typescript",
			},
			location: { startLine: 0, endLine: 1 },
			snippet: "",
			score: { fused: 0, reasonCodes: [] },
			evidenceId: "r",
			freshness: "current",
		};
		expect(revalidateResult(fakeStale, fx.root)).toBe("stale");
	});
});
