/**
 * CLI tests for workspace retrieval commands (1.7.0).
 */

import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleWorkspaceRetrievalCommand } from "../src/core/workspace-cli.js";
import { type FixtureTree, makeFixture } from "./workspace-fixtures.js";

let fx: FixtureTree;
let captured: unknown;

const _originalLog = console.log;
beforeAll(async () => {
	fx = makeFixture();
	const lines: string[] = [];
	captured = lines;
	const orig = console.log;
	console.log = (v: unknown) => {
		lines.push(typeof v === "string" ? v : JSON.stringify(v));
		orig(v);
	};
	process.env.JENSEN_INDEX_STORAGE_ROOT = fx.storageRoot;
	await handleWorkspaceRetrievalCommand(["index", "build", "--root", fx.root, "--json"]);
	console.log = orig;
});

afterAll(() => {
	try {
		rmSync(fx.root, { recursive: true, force: true });
		rmSync(fx.storageRoot, { recursive: true, force: true });
	} catch {
		/* noop */
	}
});

function capture(fn: () => Promise<boolean>): Promise<string[]> {
	const out: string[] = [];
	const orig = console.log;
	console.log = (v: unknown) => out.push(typeof v === "string" ? v : JSON.stringify(v));
	console.error = () => {};
	return fn().then((_r) => {
		console.log = orig;
		return out;
	});
}

describe("workspace retrieval CLI", () => {
	it("index build produces a ready generation", () => {
		const status = (captured as string[]).join("\n");
		expect(status).toContain('"status": "ready"');
	});

	it("index status reports ready generation", async () => {
		const out = await capture(() =>
			handleWorkspaceRetrievalCommand(["index", "status", "--root", fx.root, "--json"]),
		);
		expect(out.join("\n")).toContain('"hasReadyGeneration": true');
	});

	it("search returns evidence-backed results", async () => {
		const out = await capture(() =>
			handleWorkspaceRetrievalCommand(["search", "connectDatabase", "--root", fx.root, "--json"]),
		);
		expect(out.join("\n")).toContain("src/db.ts");
		expect(out.join("\n")).toContain("evidenceId");
	});

	it("search symbol resolves a symbol", async () => {
		const out = await capture(() =>
			handleWorkspaceRetrievalCommand(["search", "symbol", "AuthService", "--root", fx.root, "--json"]),
		);
		expect(out.join("\n")).toContain("AuthService");
	});

	it("search hybrid ranks and explains", async () => {
		const out = await capture(() =>
			handleWorkspaceRetrievalCommand(["search", "hybrid", "authentication login", "--root", fx.root, "--json"]),
		);
		expect(out.join("\n")).toContain("src/auth.ts");
		expect(out.join("\n")).toContain("reasonCodes");
	});

	it("doctor index reports checks", async () => {
		const out = await capture(() =>
			handleWorkspaceRetrievalCommand(["doctor", "index", "--root", fx.root, "--json"]),
		);
		expect(out.join("\n")).toContain("index.ready_generation");
	});

	it("doctor embeddings reports mode and no-remote", async () => {
		const out = await capture(() =>
			handleWorkspaceRetrievalCommand(["doctor", "embeddings", "--root", fx.root, "--json"]),
		);
		expect(out.join("\n")).toContain("embeddings.mode");
		expect(out.join("\n")).not.toContain("remote");
	});

	it("index verify passes for a clean index", async () => {
		const out = await capture(() =>
			handleWorkspaceRetrievalCommand(["index", "verify", "--root", fx.root, "--json"]),
		);
		expect(out.join("\n")).toContain('"valid": true');
	});

	it("retrieval plan classifies the query", async () => {
		const out = await capture(() =>
			handleWorkspaceRetrievalCommand(["retrieval", "plan", "authenticateUser", "--root", fx.root, "--json"]),
		);
		expect(out.join("\n")).toContain("exact_identifier");
	});

	it("index prune --preview is zero-mutation", async () => {
		const beforeOut = await capture(() =>
			handleWorkspaceRetrievalCommand(["index", "generations", "--root", fx.root, "--json"]),
		);
		const nBefore = (JSON.parse(beforeOut.join("\n")) as unknown[]).length;
		await capture(() =>
			handleWorkspaceRetrievalCommand(["index", "prune", "--preview", "--root", fx.root, "--json"]),
		);
		const afterOut = await capture(() =>
			handleWorkspaceRetrievalCommand(["index", "generations", "--root", fx.root, "--json"]),
		);
		const nAfter = (JSON.parse(afterOut.join("\n")) as unknown[]).length;
		expect(nAfter).toBe(nBefore);
	});
});
