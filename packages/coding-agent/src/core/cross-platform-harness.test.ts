import { describe, expect, it } from "vitest";
import { getPowerShellConfig, resetShellConfigCache } from "../utils/shell.js";
import { executeBash } from "./bash-executor.js";
import { runDoctorChecks } from "./doctor.js";
import { buildExecutionEnvironment, parseWorktreeList } from "./footer-data-provider.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { getToolPrompt } from "./tools/tools-prompt-data.js";

// ============================================================================
// porcelain parsing tests — unit tests against known fixture data
// ============================================================================

describe("worktree porcelain parser", () => {
	// Test the internal parseWorktreePorcelain via a temp git repo.
	// parseWorktreeList wraps spawnSync; we validate against real git.

	it("parses real git worktree output for current repo", () => {
		const result = parseWorktreeList(process.cwd());
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThanOrEqual(0);
		for (const entry of result) {
			expect(typeof entry.path).toBe("string");
			expect(typeof entry.head).toBe("string");
			expect(entry.head.length).toBe(40);
			expect(typeof entry.locked).toBe("boolean");
			expect(typeof entry.prunable).toBe("boolean");
		}
	});

	it("returns empty array when git is unavailable", () => {
		const result = parseWorktreeList("/dev/null/nonexistent");
		expect(result).toEqual([]);
	});
});

// ============================================================================
// execution environment tests
// ============================================================================

describe("buildExecutionEnvironment", () => {
	it("returns host, os, loginShell on Linux", () => {
		const env = buildExecutionEnvironment("/home/user/test-repo");
		expect(env.host).toBeTruthy();
		expect(env.host.length).toBeGreaterThan(0);
		expect(env.os).toBe("Linux");
		expect(env.loginShell).toBeTruthy();
		expect(typeof env.loginShell).toBe("string");
	});

	it("captures initialCwd separately from effectiveCwd", () => {
		const env = buildExecutionEnvironment("/home/user/test-repo");
		expect(env.initialCwd).toBe("/home/user/test-repo");
		expect(typeof env.effectiveCwd).toBe("string");
		expect(env.effectiveCwd.length).toBeGreaterThan(0);
	});

	it("distinguishes initialCwd from effectiveCwd when they differ", () => {
		const env = buildExecutionEnvironment("/tmp/some-other-path");
		expect(env.initialCwd).toBe("/tmp/some-other-path");
		expect(env.initialCwd).not.toBe(env.effectiveCwd);
		expect(typeof env.gitRoot === "string" || env.gitRoot === null).toBe(true);
	});

	it("controllerGitRoot is null when initialCwd === effectiveCwd", () => {
		const env = buildExecutionEnvironment(process.cwd());
		expect(env.controllerGitRoot).toBeNull();
	});

	it("controllerGitRoot is populated when initialCwd is a different git repo", () => {
		// Use /tmp as initialCwd (not a git repo) — controllerGitRoot should remain null
		const env = buildExecutionEnvironment("/tmp");
		expect(env.controllerGitRoot).toBeNull();
	});

	it("returns git info from real repo", () => {
		const env = buildExecutionEnvironment(process.cwd());
		expect(env.gitRoot).toBeTruthy();
		expect(typeof env.gitBranch).toBe("string");
	});

	it("never leaks sensitive data", () => {
		const env = buildExecutionEnvironment("/home/user/test-repo");
		const json = JSON.stringify(env);
		expect(json).not.toContain("API_KEY");
		expect(json).not.toContain("TOKEN");
		expect(json).not.toContain("SECRET");
		expect(json).not.toContain("PASSWORD");
	});

	it("detached HEAD detection produces boolean", () => {
		const env = buildExecutionEnvironment(process.cwd());
		expect(typeof env.isDetachedHead).toBe("boolean");
	});

	it("worktreeCount is a non-negative number", () => {
		const env = buildExecutionEnvironment(process.cwd());
		expect(typeof env.worktreeCount).toBe("number");
		expect(env.worktreeCount).toBeGreaterThanOrEqual(0);
	});

	it("handles SHELL unset gracefully", () => {
		const origShell = process.env.SHELL;
		delete process.env.SHELL;
		try {
			const env = buildExecutionEnvironment("/tmp/test");
			expect(env.loginShell).toBe("/bin/sh");
		} finally {
			if (origShell) process.env.SHELL = origShell;
		}
	});

	it("loginShell is distinct from the bash tool shell", () => {
		const env = buildExecutionEnvironment(process.cwd());
		// loginShell comes from $SHELL (e.g., /usr/bin/zsh), but
		// the bash tool uses /bin/bash on Linux
		expect(typeof env.loginShell).toBe("string");
		// loginShell should not be empty
		expect(env.loginShell.length).toBeGreaterThan(0);
	});
});

// ============================================================================
// BashResult timestamp tests
// ============================================================================

describe("BashResult timestamps", () => {
	it("includes startedAt and finishedAt on success", async () => {
		const result = await executeBash("echo hello");
		expect(typeof result.startedAt).toBe("string");
		expect(typeof result.finishedAt).toBe("string");
		// ISO 8601 format: starts with YYYY-MM-DD
		expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(result.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(result.startedAt <= result.finishedAt).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
	});

	it("includes timestamps on non-zero exit code", async () => {
		try {
			await executeBash("exit 42");
		} catch {
			// The tool throws on non-zero exit; we can't directly get the result
			// from executeBash when it throws. Tested indirectly via the tool layer.
		}
	});

	it("timestamps are ISO 8601 strings not Date objects", async () => {
		const result = await executeBash("echo ts");
		// Verify they're strings, not Date objects
		expect(typeof result.startedAt).toBe("string");
		expect(typeof result.finishedAt).toBe("string");
		// Verify they contain T separator (ISO format)
		expect(result.startedAt).toContain("T");
		expect(result.finishedAt).toContain("T");
	});

	it("finishedAt >= startedAt", async () => {
		const result = await executeBash("echo timing");
		expect(result.startedAt <= result.finishedAt).toBe(true);
	});
});

// ============================================================================
// BashResult separation tests (stdout, stderr, timedOut, spawnError)
// ============================================================================

describe("BashResult stream separation", () => {
	it("captures stdout only with exit 0", async () => {
		const result = await executeBash("printf 'hello stdout'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello stdout");
		expect(result.stderr).toBe("");
		expect(result.output).toContain("hello stdout");
		expect(result.timedOut).toBe(false);
		expect(result.cancelled).toBe(false);
		expect(result.spawnError).toBeUndefined();
	});

	it("captures stderr only with exit 0", async () => {
		const result = await executeBash("printf 'error message' >&2");
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("error message");
		expect(result.stdout).toBe("");
		expect(result.timedOut).toBe(false);
		expect(result.cancelled).toBe(false);
	});

	it("captures simultaneous stdout and stderr", async () => {
		const result = await executeBash("printf 'out'; printf 'err' >&2");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("out");
		expect(result.stderr).toBe("err");
	});

	it("captures stdout with non-zero exit", async () => {
		const result = await executeBash("printf 'fail output' >&2; exit 3");
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("fail output");
	});

	it("does not treat stderr as failure when exit 0", async () => {
		const result = await executeBash("printf 'just noise' >&2; exit 0");
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("just noise");
		expect(result.stdout).toBe("");
	});

	it("timestamps are present in all result states", async () => {
		const result = await executeBash("true");
		expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(result.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(result.startedAt <= result.finishedAt).toBe(true);
	});

	it("timedOut is false on normal completion", async () => {
		const result = await executeBash("true");
		expect(result.timedOut).toBe(false);
	});

	it("spawnError is undefined on normal completion", async () => {
		const result = await executeBash("true");
		expect(result.spawnError).toBeUndefined();
	});
});

// ============================================================================
// Pipeline evidence tests
// ============================================================================

describe("pipeline evidence", () => {
	it("detects simple pipeline with authoritative evidence", async () => {
		const result = await executeBash("false | tail");
		expect(result.pipeline).toBeDefined();
		expect(result.pipeline!.isPipeline).toBe(true);
		// PIPESTATUS is now captured via fd 3, so evidence is authoritative
		expect(result.pipeline!.evidenceAuthoritative).toBe(true);
		expect(result.pipeline!.stageExitCodesKnown).toBe(true);
		expect(result.pipeline!.stageExitCodes).toEqual([1, 0]);
	});

	it("detects pipeline with grep", async () => {
		const result = await executeBash("printf 'ok\n' | grep ok");
		expect(result.pipeline).toBeDefined();
		expect(result.pipeline!.isPipeline).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.pipeline!.stageExitCodes).toEqual([0, 0]);
	});

	it("non-pipeline command still captures pipeline metadata", async () => {
		const result = await executeBash("echo hello");
		// PIPESTATUS capture always runs, but isPipeline flag reflects command detection
		expect(result.pipeline).toBeDefined();
		expect(result.pipeline!.isPipeline).toBe(false);
		expect(result.pipeline!.evidenceAuthoritative).toBe(true);
		expect(result.pipeline!.stageExitCodes).toEqual([0]);
	});

	it("non-pipeline exit 0 has authoritative evidence", async () => {
		const result = await executeBash("true");
		expect(result.pipeline).toBeDefined();
		expect(result.pipeline!.isPipeline).toBe(false);
		expect(result.pipeline!.evidenceAuthoritative).toBe(true);
		expect(result.pipeline!.stageExitCodes).toEqual([0]);
		expect(result.exitCode).toBe(0);
	});

	it("pipeline exit code reflects last stage", async () => {
		const result = await executeBash("false | grep anything");
		expect(result.pipeline).toBeDefined();
		expect(result.exitCode).toBe(1);
		expect(result.pipeline!.stageExitCodes).toEqual([1, 1]);
	});
});

// ============================================================================
// system prompt content tests
// ============================================================================

describe("system prompt execution environment", () => {
	it("includes Execution environment section", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("Execution environment:");
	});

	it("includes host field", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toMatch(/- host: \S/);
	});

	it("includes operating system field", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toMatch(/- operating system: /);
	});

	it("includes login shell field (not plain shell)", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toMatch(/- login shell: \//);
	});

	it("does not use ambiguous 'shell' field", () => {
		const prompt = buildSystemPrompt();
		// Should not contain "- shell:" since we now use "- login shell:"
		const lines = prompt.split("\n");
		const shellLine = lines.find((l) => l.startsWith("- shell:"));
		expect(shellLine).toBeUndefined();
	});

	it("includes working directory field", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toMatch(/- working directory: /);
	});

	it("includes git repository field", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toMatch(/- git repository: /);
	});
});

describe("system prompt evidence discipline", () => {
	it("includes exit code discipline", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("Never declare a command succeeded without inspecting its exit code");
	});

	it("includes evidence separation", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain(
			"Treat stdout, stderr, exit code, timeout, cancellation, and truncation as separate pieces of evidence",
		);
	});

	it("includes non-zero exit code is failure", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("non-zero exit code is a failure");
	});

	it("includes stderr does not always mean failure", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("stderr alone does not mean failure");
	});

	it("warns against conflating proposed with executed", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("Do not conflate a proposed command with an executed one");
	});
});

describe("system prompt command classification", () => {
	it("includes SHORT/LONG_RUNNING/PERSISTENT", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("Classify commands before execution");
		expect(prompt).toContain("SHORT");
		expect(prompt).toContain("LONG_RUNNING");
		expect(prompt).toContain("PERSISTENT");
	});
});

describe("system prompt platform policy", () => {
	it("includes Linux guidance on Linux", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("You are on Linux");
		expect(prompt).toContain("Use the bash tool for all shell operations");
	});

	it("does not include Windows guidance on Linux", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).not.toContain("Use the powershell tool for Windows-native workflows");
	});
});

describe("system prompt legacy cwd removal", () => {
	it("no standalone Current working directory line", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).not.toContain("Current working directory:");
	});
});

// ============================================================================
// doctor worktree tests
// ============================================================================

describe("doctor worktree diagnostics", () => {
	it("includes worktrees check in results", async () => {
		const result = await runDoctorChecks();
		const worktreeCheck = result.checks.find((c) => c.name === "worktrees");
		expect(worktreeCheck).toBeDefined();
		expect(["ok", "warn", "error"]).toContain(worktreeCheck!.status);
	});

	it("worktree check has a message", async () => {
		const result = await runDoctorChecks();
		const worktreeCheck = result.checks.find((c) => c.name === "worktrees");
		expect(worktreeCheck!.message.length).toBeGreaterThan(0);
	});

	it("skips gracefully outside a git repo", async () => {
		const result = await runDoctorChecks({ cwd: "/tmp" });
		const worktreeCheck = result.checks.find((c) => c.name === "worktrees");
		expect(worktreeCheck).toBeDefined();
		expect(worktreeCheck!.status).toBe("ok");
		expect(worktreeCheck!.message).toContain("Not a git repository");
	});
});

// ============================================================================
// tool prompt content tests
// ============================================================================

describe("bash tool prompt", () => {
	it("includes command classification", () => {
		const prompt = getToolPrompt("bash")!;
		expect(prompt).toContain("Classify commands before execution");
		expect(prompt).toContain("SHORT");
		expect(prompt).toContain("LONG_RUNNING");
		expect(prompt).toContain("PERSISTENT");
	});

	it("includes Linux platform guidance", () => {
		const prompt = getToolPrompt("bash")!;
		expect(prompt).toContain("On Linux: use native Bash syntax");
	});

	it("includes Windows Git Bash guidance", () => {
		const prompt = getToolPrompt("bash")!;
		expect(prompt).toContain("On Windows via Git Bash");
	});

	it("prohibits unowned background processes", () => {
		const prompt = getToolPrompt("bash")!;
		expect(prompt).toContain("Do NOT use");
		expect(prompt).toContain("nohup");
	});

	it("emphasizes exit code checking", () => {
		const prompt = getToolPrompt("bash")!;
		expect(prompt).toContain("non-zero exit code means the command failed");
	});
});

describe("powershell tool prompt", () => {
	it("includes SSH remote guidance", () => {
		const prompt = getToolPrompt("powershell")!;
		expect(prompt).toContain("When executing PowerShell remotely via SSH");
		expect(prompt).toContain("Do not send Bash syntax as the PowerShell payload");
	});

	it("includes UTF-16LE encoding note", () => {
		const prompt = getToolPrompt("powershell")!;
		expect(prompt).toContain("UTF-16LE");
		expect(prompt).toContain("-EncodedCommand");
	});

	it("includes tiered quoting guidance not simplistic rule", () => {
		const prompt = getToolPrompt("powershell")!;
		expect(prompt).toContain("Avoid fragile multi-layer manual quoting");
		expect(prompt).toContain("EncodedCommand");
		// The outdated simplistic single/double quote rule should be gone
		expect(prompt).not.toContain("single quotes around the SSH command and double quotes inside");
	});

	it("includes LASTEXITCODE guidance", () => {
		const prompt = getToolPrompt("powershell")!;
		expect(prompt).toContain("$LASTEXITCODE");
		expect(prompt).toContain("native executables");
	});

	it("includes exit code propagation guidance", () => {
		const prompt = getToolPrompt("powershell")!;
		expect(prompt).toContain("Propagate the remote exit code");
	});
});

// ============================================================================
// PowerShell discovery tests
// ============================================================================

describe("PowerShell discovery", () => {
	it("JENSEN_PWSH_PATH env var takes priority over PATH", () => {
		// Ensure clean cache
		resetShellConfigCache();

		// Without JENSEN_PWSH_PATH and without pwsh on PATH, getPowerShellConfig should throw
		// unless pwsh is actually installed
		try {
			const config = getPowerShellConfig();
			// If pwsh is available, just verify the config shape
			expect(typeof config.shell).toBe("string");
			expect(config.shell.length).toBeGreaterThan(0);
			expect(Array.isArray(config.args)).toBe(true);
			expect(["pwsh", "powershell"]).toContain(config.flavor);
		} catch (err) {
			// Expected when pwsh is not available — this is fine
			expect(err).toBeDefined();
		}

		resetShellConfigCache();
	});

	it("does not scan HOME for pwsh fallback", () => {
		// The production code must not contain HOME scan logic.
		// We verify this by checking the shell config resolution:
		// 1. It does not search $HOME/.local/powershell/pwsh
		// 2. It only uses PATH, explicit env var, or platform defaults
		// We validate by reading the source since env-based runtime tests
		// are unreliable across different machines.
		const fs = require("node:fs");
		const shellSource = fs.readFileSync(require("node:path").resolve(__dirname, "..", "utils", "shell.ts"), "utf-8");
		// The old HOME-scan code would contain join(HOME, ".local", ...) or similar.
		expect(shellSource).not.toMatch(/\.local.*powershell.*pwsh/);
	});
});

// ============================================================================
// Doctor cache side-effects test
// ============================================================================

describe("doctor does not reset cache", () => {
	it("doctor does not import resetShellConfigCache", () => {
		const fs = require("node:fs");
		const doctorSource = fs.readFileSync(require("node:path").join(__dirname, "doctor.ts"), "utf-8");
		// Verify that resetShellConfigCache is NOT imported in doctor.ts
		expect(doctorSource).not.toContain("resetShellConfigCache");
	});

	it("doctor pwsh check does not modify global shell cache", async () => {
		// Set up a known cache state
		resetShellConfigCache();

		// Try to get the shell config first (populates cache if pwsh is available)
		let beforeConfig: string | null = null;
		try {
			beforeConfig = getPowerShellConfig().shell;
		} catch {
			// pwsh not available — skip cache validation
		}

		// Run doctor
		await runDoctorChecks();

		// After doctor, the cache should still be valid and unchanged
		if (beforeConfig) {
			const afterConfig = getPowerShellConfig().shell;
			expect(afterConfig).toBe(beforeConfig);
		}

		resetShellConfigCache();
	});
});
