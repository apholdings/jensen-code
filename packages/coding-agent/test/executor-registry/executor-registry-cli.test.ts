/**
 * Executor Registry — CLI output tests (2.10.0).
 *
 * Proves `jensen executor ...` human and `--json` output are structured and
 * stable. Runs against a temp registry directory, never the operator's real
 * ~/.jensen/agent/executor-registry directory.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleExecutorCommand } from "../../src/core/executor-registry/cli.js";

function makeRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "executor-registry-cli-"));
}

let root: string;
let captured: string[];

beforeEach(() => {
	root = makeRoot();
	process.env.JENSEN_EXECUTOR_REGISTRY_DIR = root;
	captured = [];
	process.exitCode = 0;
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		captured.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	delete process.env.JENSEN_EXECUTOR_REGISTRY_DIR;
	process.exitCode = 0;
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function text(): string {
	return captured.join("");
}

describe("TEST Y — JSON CLI output matches DTO schema", () => {
	it("executor register/show/list --json emit stable structured DTOs", async () => {
		expect(
			await handleExecutorCommand([
				"executor",
				"register",
				"qa-cli",
				"--display-name",
				"QA CLI",
				"--label",
				"linux",
				"--provider",
				"llamacpp-local",
				"--model",
				"qwen-local",
				"--json",
			]),
		).toBe(true);
		const registered = JSON.parse(text()) as { executorId: string; status: string };
		expect(registered).toMatchObject({ executorId: "qa-cli", status: "created" });

		captured = [];
		expect(await handleExecutorCommand(["executor", "activate", "qa-cli", "--json"])).toBe(true);
		const activation = JSON.parse(text()) as {
			executorId: string;
			runtimeInstanceId: string;
			runtimeEpoch: number;
			proof: Record<string, unknown>;
		};
		expect(activation.executorId).toBe("qa-cli");
		expect(activation.runtimeInstanceId).toMatch(/^runtime_/);
		expect(activation.runtimeEpoch).toBe(1);
		expect(activation.proof).toEqual({
			executorId: "qa-cli",
			runtimeInstanceId: activation.runtimeInstanceId,
			runtimeEpoch: 1,
		});

		captured = [];
		expect(await handleExecutorCommand(["executor", "show", "qa-cli", "--json"])).toBe(true);
		const detail = JSON.parse(text()) as {
			executorId: string;
			status: string;
			runtimeEpoch: number;
			configuredCapabilities: { providers: string[]; models: string[] };
			currentAssignments: { status: string };
		};
		expect(detail.executorId).toBe("qa-cli");
		expect(detail.status).toBe("ONLINE");
		expect(detail.runtimeEpoch).toBe(1);
		expect(detail.configuredCapabilities.providers).toEqual(["llamacpp-local"]);
		expect(detail.configuredCapabilities.models).toEqual(["qwen-local"]);
		expect(detail.currentAssignments.status).toBe("unavailable");

		captured = [];
		expect(await handleExecutorCommand(["executor", "list", "--json"])).toBe(true);
		const list = JSON.parse(text()) as { entries: Record<string, unknown>[] };
		expect(list.entries).toHaveLength(1);
		expect(list.entries[0]).toMatchObject({ executorId: "qa-cli", status: "ONLINE", runtimeEpoch: 1 });
	});
});

describe("TEST Z — human CLI output", () => {
	it("executor show prints stable operator output", async () => {
		await handleExecutorCommand(["executor", "register", "qa-human", "--label", "linux"]);
		captured = [];
		expect(await handleExecutorCommand(["executor", "activate", "qa-human"])).toBe(true);
		captured = [];

		expect(await handleExecutorCommand(["executor", "show", "qa-human"])).toBe(true);
		const out = text();
		expect(out).toContain("EXECUTOR");
		expect(out).toContain("id: qa-human");
		expect(out).toContain("status: ONLINE");
		expect(out).toContain("epoch: 1");
		expect(out).toContain("RUNTIME");
		expect(out).toContain("instance:");
	});
});
