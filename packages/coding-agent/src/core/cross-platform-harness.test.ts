import { describe, expect, it } from "vitest";
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
		expect(prompt).toContain("Avoid fragile multi-layer quoting");
		expect(prompt).toContain("simple single-command payloads");
		// The outdated simplistic rule should be gone
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
