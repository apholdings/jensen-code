/**
 * Windows integration test for process_manager.
 *
 * Tests the full lifecycle using real PowerShell and real processes.
 * Skipped on non-Windows platforms.
 *
 * Safety: only kills PIDs created by this test. No Stop-Process by name.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createProcessManagerTool, type ProcessRecord } from "./process-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function psRunSync(script: string, timeoutSecs = 10): { stdout: string; stderr: string; status: number | null } {
	const encoded = Buffer.from(script, "utf-16le").toString("base64");
	const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
		timeout: timeoutSecs * 1000,
		encoding: "utf-8",
		windowsHide: true,
	});
	return {
		stdout: (result.stdout || "").trim(),
		stderr: (result.stderr || "").trim(),
		status: result.status,
	};
}

async function pickFreePort(min = 31000, max = 31999): Promise<number> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const port = min + Math.floor(Math.random() * (max - min + 1));
		const r = psRunSync(
			`$c = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue; if ($c) { 'TAKEN' } else { 'FREE' }`,
		);
		if (r.stdout.includes("FREE")) return port;
	}
	throw new Error("Could not find a free port");
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function httpGet(port: number, path: string, timeoutMs = 5000): Promise<{ status: number; body: string }> {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal });
		const body = await res.text();
		return { status: res.status, body };
	} catch (err) {
		return { status: 0, body: (err as Error).message };
	} finally {
		clearTimeout(t);
	}
}

// ---------------------------------------------------------------------------
// Describe block
// ---------------------------------------------------------------------------

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("process manager Windows integration", () => {
	const fixturePaths: string[] = [];
	const pidsToCleanup: number[] = [];

	afterAll(() => {
		for (const pid of pidsToCleanup) {
			try {
				psRunSync(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
			} catch {
				// Already dead
			}
		}
		for (const fp of fixturePaths) {
			try {
				if (existsSync(fp)) unlinkSync(fp);
			} catch {
				// Ignore
			}
		}
	});

	function createFixture(port: number): string {
		const fp = join(tmpdir(), `jensen-pm-wintest-${randomBytes(4).toString("hex")}.js`);
		const code = [
			`const http = require("node:http");`,
			`console.log("PROCESS_MANAGER_FIXTURE_STARTED");`,
			`console.error("PROCESS_MANAGER_FIXTURE_STDERR_READY");`,
			`const server = http.createServer((_req, res) => {`,
			`  res.writeHead(200, {"Content-Type":"text/plain"});`,
			`  res.end("fixture-ok");`,
			`});`,
			`server.listen(${port}, "127.0.0.1", () => {});`,
			`setInterval(() => {}, 60000);`,
		].join("\n");
		writeFileSync(fp, code, "utf-8");
		fixturePaths.push(fp);
		return fp;
	}

	it("full lifecycle: start -> status -> list -> stop -> idempotent stop", async () => {
		const port = await pickFreePort();
		const fixturePath = createFixture(port);
		const tool = createProcessManagerTool(process.cwd());

		// START
		const startResult = await tool.execute("wintest-1", {
			action: "start",
			command: `node "${fixturePath}"`,
			expectedPort: port,
			readyTimeout: 20,
		});

		const record: ProcessRecord = startResult.details?.record;
		expect(record).toBeDefined();
		expect(record.runId).toBeTruthy();
		expect(record.rootPid).toBeGreaterThan(0);
		expect(record.listenerPid).toBeGreaterThan(0);
		expect(record.status).toBe("running");
		pidsToCleanup.push(record.rootPid);

		const runId = record.runId;

		// Verify listener
		const connResult = psRunSync(
			`$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { "PID:$($c.OwningProcess)" } else { "NONE" }`,
		);
		const listenerMatch = connResult.stdout.match(/PID:(\d+)/);
		expect(listenerMatch).not.toBeNull();
		expect(Number(listenerMatch![1])).toBe(record.listenerPid);

		// Verify stdout log
		expect(existsSync(record.stdoutPath)).toBe(true);
		expect(readFileSync(record.stdoutPath, "utf-8")).toContain("PROCESS_MANAGER_FIXTURE_STARTED");

		// Verify stderr log
		expect(existsSync(record.stderrPath)).toBe(true);
		expect(readFileSync(record.stderrPath, "utf-8")).toContain("PROCESS_MANAGER_FIXTURE_STDERR_READY");

		// HTTP
		const httpRes = await httpGet(port, "/");
		expect(httpRes.status).toBe(200);
		expect(httpRes.body).toBe("fixture-ok");

		// STATUS
		const statusResult = await tool.execute("wintest-2", { action: "status", runId });
		const statusText = statusResult.content[0]?.type === "text" ? statusResult.content[0].text : "";
		expect(statusText).toContain("Status: running");

		// LIST
		const listResult = await tool.execute("wintest-3", { action: "list" });
		const listText = listResult.content[0]?.type === "text" ? listResult.content[0].text : "";
		expect(listText).toContain(runId);

		// STOP
		const stopResult = await tool.execute("wintest-4", { action: "stop", runId });
		const stopText = stopResult.content[0]?.type === "text" ? stopResult.content[0].text : "";
		expect(stopText).toContain("stopped successfully");

		// Wait for port release
		await sleep(2000);

		// Verify listener gone
		const connAfter = psRunSync(
			`$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { "PID:$($c.OwningProcess)" } else { "NONE" }`,
		);
		expect(connAfter.stdout).toContain("NONE");

		// Second stop (idempotent)
		const stop2Result = await tool.execute("wintest-5", { action: "stop", runId });
		const stop2Text = stop2Result.content[0]?.type === "text" ? stop2Result.content[0].text : "";
		expect(stop2Text).toContain("already stopped");

		// Remove from cleanup list (already stopped)
		pidsToCleanup.length = 0;
	}, 60000);

	it("port conflict: does not kill external process", async () => {
		const conflictPort = await pickFreePort();
		const extFixturePath = createFixture(conflictPort);

		// Start external fixture via PowerShell (not via process_manager)
		const extStart = psRunSync(
			`$proc = Start-Process -FilePath 'node' -ArgumentList '"${extFixturePath.replace(/"/g, '\\"')}"' -WindowStyle Hidden -PassThru; Write-Output "PID:$($proc.Id)"`,
			10,
		);
		const extPidMatch = extStart.stdout.match(/PID:(\d+)/);
		expect(extPidMatch).not.toBeNull();
		const extPid = Number(extPidMatch![1]);
		pidsToCleanup.push(extPid);

		// Wait for external fixture to listen
		let extReady = false;
		for (let i = 0; i < 40; i++) {
			const check = psRunSync(
				`$c = Get-NetTCPConnection -LocalPort ${conflictPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c -and $c.OwningProcess -eq ${extPid}) { 'READY' } else { 'WAIT' }`,
			);
			if (check.stdout.includes("READY")) {
				extReady = true;
				break;
			}
			await sleep(500);
		}
		expect(extReady).toBe(true);

		// Try to start process_manager on the same port — must fail
		const tool = createProcessManagerTool(process.cwd());
		const conflictFixturePath = join(tmpdir(), `jensen-pm-conflict-${randomBytes(4).toString("hex")}.js`);
		writeFileSync(conflictFixturePath, fixtureContent(conflictPort), "utf-8");
		fixturePaths.push(conflictFixturePath);

		await expect(
			tool.execute("wintest-conflict", {
				action: "start",
				command: `node "${conflictFixturePath}"`,
				expectedPort: conflictPort,
				readyTimeout: 10,
			}),
		).rejects.toThrow();

		// External fixture must still be alive
		const aliveResult = psRunSync(
			`$p = Get-Process -Id ${extPid} -ErrorAction SilentlyContinue; if ($p) { 'ALIVE' } else { 'DEAD' }`,
		);
		expect(aliveResult.stdout).toContain("ALIVE");

		// External fixture must still own the port
		const portOwner = psRunSync(
			`$c = Get-NetTCPConnection -LocalPort ${conflictPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { "PID:$($c.OwningProcess)" } else { "NONE" }`,
		);
		expect(portOwner.stdout).toContain(`PID:${extPid}`);

		// Cleanup external fixture
		psRunSync(`Stop-Process -Id ${extPid} -Force -ErrorAction SilentlyContinue`);
		pidsToCleanup.length = 0;
	}, 60000);
});

function fixtureContent(port: number): string {
	return [
		`const http = require("node:http");`,
		`console.log("FIXTURE_STARTED");`,
		`const server = http.createServer((_req, res) => {`,
		`  res.writeHead(200, {"Content-Type":"text/plain"});`,
		`  res.end("conflict-ok");`,
		`});`,
		`server.listen(${port}, "127.0.0.1", () => {});`,
		`setInterval(() => {}, 60000);`,
	].join("\n");
}
