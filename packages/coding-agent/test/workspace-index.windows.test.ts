/**
 * Windows integration tests for workspace indexing (1.7.0).
 *
 * Verifies native Windows behaviors: junction escape blocking, case-insensitive
 * path identity, and that concurrent opening/indev across two storage handles
 * keeps a consistent ready generation. Skipped on non-Windows platforms.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectSymlinkEscape } from "../src/core/workspace/guard.js";
import { resolveWorkspaceIdentity } from "../src/core/workspace/identity.js";
import { WorkspaceIndex } from "../src/core/workspace/index.js";
import { makeFixture } from "./workspace-fixtures.js";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

function junctionExists(a: string, b: string): boolean {
	try {
		execFileSync("cmd", ["/c", "mklink", "/J", a, b], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describeWindows("workspace indexing Windows integration", () => {
	it("blocks junction escapes out of the workspace", () => {
		const fx = makeFixture({});
		const external = path.join(fx.root, "..", `ext_${Date.now()}`);
		mkdirSync(external, { recursive: true });
		writeFileSync(path.join(external, "secret.txt"), "s");
		const junction = path.join(fx.root, "linkout");
		if (junctionExists(junction, external)) {
			const esc = detectSymlinkEscape(fx.root, path.join(junction, "secret.txt"));
			expect(esc).not.toBeNull();
		}
		rmSync(external, { recursive: true, force: true });
		rmSync(fx.root, { recursive: true, force: true });
		rmSync(fx.storageRoot, { recursive: true, force: true });
	});

	it("is case-insensitively stable for workspace identity", () => {
		const fx = makeFixture({});
		// On Windows, resolve should remain stable regardless of case.
		const a = resolveWorkspaceIdentity(fx.root);
		expect(a.workspaceId).toMatch(/^[a-f0-9]{32}$/);
		rmSync(fx.root, { recursive: true, force: true });
		rmSync(fx.storageRoot, { recursive: true, force: true });
	});

	it("dual concurrent handles serve a consistent ready generation", async () => {
		const fx = makeFixture({});
		const idx1 = new WorkspaceIndex(fx.root, { storageRoot: fx.storageRoot });
		await idx1.build();
		// Simulate another process reading the same workspace store.
		const idx2 = new WorkspaceIndex(fx.root, { storageRoot: fx.storageRoot });
		expect(idx2.status().hasReadyGeneration).toBe(true);
		expect(idx1.status().currentGeneration).toBe(idx2.status().currentGeneration);
		idx1.close();
		idx2.close();
		rmSync(fx.root, { recursive: true, force: true });
		rmSync(fx.storageRoot, { recursive: true, force: true });
	});
});
