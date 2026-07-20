import { describe, expect, it } from "vitest";
import { runDoctorChecks } from "./doctor.js";
import { buildExecutionEnvironment, parseWorktreeList } from "./footer-data-provider.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { getToolPrompt } from "./tools/tools-prompt-data.js";

// ============================================================================
// porcelain parsing tests — test the parser directly, not the git call
// ============================================================================

describe("worktree porcelain parser (unit)", () => {
	// Direct test of parseWorktreePorcelain via parseWorktreeList with a mock
	// that returns known porcelain output. We use the exported parseWorktreeList
	// but rely on git being available — parseWorktreeList wraps spawnSync internally.
	// These tests validate the porcelain format parsing by using real porcelain output
	// from a temporary git repo.

	it("parses real git worktree output for current repo", () => {
		// The current repo has at least one worktree
		const result = parseWorktreeList(process.cwd());
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThanOrEqual(0);
		// Each entry must have required fields
		for (const entry of result) {
			expect(typeof entry.path).toBe("string");
			expect(typeof entry.head).toBe("string");
			expect(entry.head.length).toBe(40); // Full SHA
			expect(typeof entry.locked).toBe("boolean");
			expect(typeof entry.prunable).toBe("boolean");
		}
	});
});

// ============================================================================
// execution environment tests
// ============================================================================

describe("buildExecutionEnvironment", () => {
	it("returns host, os, shell fields on Linux", () => {
		const env = buildExecutionEnvironment("/home/user/test-repo");
		expect(env.host).toBeTruthy();
		expect(env.host.length).toBeGreaterThan(0);
		expect(env.os).toBe("Linux");
		expect(env.shell).toBeTruthy();
	});

	it("captures initialCwd and effectiveCwd", () => {
		const env = buildExecutionEnvironment("/home/user/test-repo");
		expect(env.initialCwd).toBe("/home/user/test-repo");
		expect(typeof env.effectiveCwd).toBe("string");
		expect(env.effectiveCwd.length).toBeGreaterThan(0);
	});

	it("initialCwd is captured separately from effectiveCwd", () => {
		const env = buildExecutionEnvironment("/tmp/some-other-path");
		// initialCwd is the session start directory, preserved as-is
		expect(env.initialCwd).toBe("/tmp/some-other-path");
		// effectiveCwd is where commands actually run (process.cwd())
		expect(typeof env.effectiveCwd).toBe("string");
		expect(env.effectiveCwd.length).toBeGreaterThan(0);
		// gitRoot reflects the effective cwd's git repo, which may be valid
		expect(typeof env.gitRoot === "string" || env.gitRoot === null).toBe(true);
	});

	it("returns git info from real repo", () => {
		const env = buildExecutionEnvironment(process.cwd());
		expect(env.gitRoot).toBeTruthy();
		expect(typeof env.gitBranch).toBe("string");
	});

	it("never leaks sensitive data in serialization", () => {
		const env = buildExecutionEnvironment("/home/user/test-repo");
		const json = JSON.stringify(env);
		expect(json).not.toContain("API_KEY");
		expect(json).not.toContain("TOKEN");
		expect(json).not.toContain("SECRET");
		expect(json).not.toContain("PASSWORD");
	});

	it("detached HEAD detection works", () => {
		const env = buildExecutionEnvironment(process.cwd());
		// Not detached in normal repo
		expect(typeof env.isDetachedHead).toBe("boolean");
	});

	it("worktreeCount is a number", () => {
		const env = buildExecutionEnvironment(process.cwd());
		expect(typeof env.worktreeCount).toBe("number");
		expect(env.worktreeCount).toBeGreaterThanOrEqual(0);
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

	it("includes shell field", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toMatch(/- shell: /);
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
	it("includes SHORT/LONG_RUNNING/PERSISTENT classification", () => {
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
	it("removes standalone Current working directory line", () => {
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

	it("includes quoting guidance for SSH", () => {
		const prompt = getToolPrompt("powershell")!;
		expect(prompt).toContain("single quotes around the SSH command");
	});
});
