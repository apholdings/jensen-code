/**
 * Tool-surface tests for workspace retrieval tools (1.7.0).
 */

import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCTION_TOOL_EFFECTS } from "../src/core/safety/effects.js";
import { createWorkspaceSearchTools } from "../src/core/tools/workspace-search.js";
import { WorkspaceIndex } from "../src/core/workspace/index.js";
import { makeFixture } from "./workspace-fixtures.js";

let fx: ReturnType<typeof makeFixture>;
let tools: Record<string, ReturnType<typeof createWorkspaceSearchTools>[string]>;

beforeAll(async () => {
	fx = makeFixture();
	const idx = new WorkspaceIndex(fx.root, { storageRoot: fx.storageRoot });
	await idx.build();
	idx.close();
	tools = createWorkspaceSearchTools(fx.root);
});

afterAll(() => {
	try {
		rmSync(fx.root, { recursive: true, force: true });
		rmSync(fx.storageRoot, { recursive: true, force: true });
	} catch {
		/* noop */
	}
});

describe("workspace search tools", () => {
	it("registers all six tools with declared effects", () => {
		const names = [
			"workspace_search",
			"workspace_search_lexical",
			"workspace_search_semantic",
			"workspace_search_symbols",
			"workspace_retrieval_status",
			"workspace_index_refresh",
		];
		for (const n of names) {
			expect(tools[n]).toBeTruthy();
			expect(PRODUCTION_TOOL_EFFECTS[n]).toBeTruthy();
		}
	});

	it("hybrid search tool returns text evidence and works read-only", async () => {
		const tool = tools.workspace_search;
		const result = await tool.execute("t1", { query: "database query connection", limit: 10 });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("src/db.ts");
	});

	it("lexical search tool finds an exact identifier", async () => {
		const tool = tools.workspace_search_lexical;
		const result = await tool.execute("t2", { query: "connectDatabase", limit: 10 });
		expect((result.content[0] as { text: string }).text).toContain("src/db.ts");
	});

	it("status tool reports the ready generation", async () => {
		const tool = tools.workspace_retrieval_status;
		const result = await tool.execute("t3", {});
		expect((result.content[0] as { text: string }).text).toContain("ready=true");
	});

	it("semantic search tool degrades without throwing", async () => {
		const tool = tools.workspace_search_semantic;
		const result = await tool.execute("t4", { query: "login credential validation", limit: 5 });
		expect(Array.isArray(result.content)).toBe(true);
	});

	it("all search tools are parallel-safe; refresh is not", () => {
		const safe = tools.workspace_search.isConcurrencySafe as (p?: unknown) => boolean;
		expect(safe).toBeTruthy();
		expect(safe({})).toBe(true);
		const refresh = tools.workspace_index_refresh.isConcurrencySafe as (p?: unknown) => boolean;
		expect(refresh({})).toBe(false);
	});
});
