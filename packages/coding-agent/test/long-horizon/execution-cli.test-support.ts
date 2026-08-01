import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

const FIXTURES = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures");

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync(
		process.execPath,
		[tsxCliPath, resolve(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts"), ...args],
		{
			cwd: REPO_ROOT,
			timeout: 15_000,
			encoding: "utf-8",
			env: {
				...process.env,
				ANTHROPIC_API_KEY: "",
				OPENAI_API_KEY: "",
			},
		},
	);
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status,
	};
}

function createTempDir(): string {
	return mkdtempSync(resolve(tmpdir(), "lh2-exec-cli-"));
}

function cleanupTempDir(dir: string): void {
	try {
		rmdirSync(dir, { recursive: true });
	} catch {}
}

// =============================================================================
// ESM-25: Generic CLI completion rejected atomically
// =============================================================================

export function registerExecutionTransitionTests(): void {
	describe("ESM-25: generic CLI completion rejected atomically", () => {
		it("APPROVE_COMPLETION through generic CLI fails before output mutation", () => {
			const dir = createTempDir();
			try {
				// First create an execution record up to COMPLETION_REVIEW
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const execPath = resolve(dir, "exec.json");

				// Init
				let result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"exec-cli-001",
					"--format",
					"json",
					"--output",
					execPath,
				]);
				expect(result.status).toBe(0);

				// START_EXECUTION
				result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					contractPath,
					"--execution",
					execPath,
					"--transition-id",
					"t-001",
					"--expected-revision",
					"0",
					"--kind",
					"START_EXECUTION",
					"--format",
					"json",
					"--output",
					execPath,
				]);
				expect(result.status).toBe(0);

				// REQUEST_VERIFICATION
				result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					contractPath,
					"--execution",
					execPath,
					"--transition-id",
					"t-002",
					"--expected-revision",
					"1",
					"--kind",
					"REQUEST_VERIFICATION",
					"--format",
					"json",
					"--output",
					execPath,
				]);
				expect(result.status).toBe(0);

				// REQUEST_COMPLETION_REVIEW
				result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					contractPath,
					"--execution",
					execPath,
					"--transition-id",
					"t-003",
					"--expected-revision",
					"2",
					"--kind",
					"REQUEST_COMPLETION_REVIEW",
					"--format",
					"json",
					"--output",
					execPath,
				]);
				expect(result.status).toBe(0);

				// Read the current file contents BEFORE attempting APPROVE_COMPLETION
				const beforeContent = readFileSync(execPath, "utf-8");
				const beforeJson = JSON.parse(beforeContent);
				expect(beforeJson.state).toBe("COMPLETION_REVIEW");
				expect(beforeJson.revision).toBe(3);

				// Attempt APPROVE_COMPLETION — MUST fail
				result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					contractPath,
					"--execution",
					execPath,
					"--transition-id",
					"t-004",
					"--expected-revision",
					"3",
					"--kind",
					"APPROVE_COMPLETION",
					"--format",
					"json",
					"--output",
					execPath,
				]);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain("TRUSTED_VALIDATION_CONTEXT_REQUIRED");

				// Verify file is unchanged
				const afterContent = readFileSync(execPath, "utf-8");
				expect(afterContent).toBe(beforeContent);
			} finally {
				cleanupTempDir(dir);
			}
		});
	});

	// =============================================================================
	// ESM-26: Generic non-privileged transition succeeds
	// =============================================================================

	describe("ESM-26: generic non-privileged transition succeeds", () => {
		it("all non-privileged transitions work through CLI", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const execPath = resolve(dir, "exec.json");

				// Init
				let result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"exec-cli-002",
					"--format",
					"json",
					"--output",
					execPath,
				]);
				expect(result.status).toBe(0);

				const nonPrivilegedKinds = [
					{ kind: "START_EXECUTION", expectedRev: 0, expectedState: "EXECUTION" },
					{ kind: "REQUEST_VERIFICATION", expectedRev: 1, expectedState: "VERIFICATION" },
					{ kind: "RETURN_TO_EXECUTION", expectedRev: 2, expectedState: "EXECUTION" },
					{ kind: "BLOCK", expectedRev: 3, expectedState: "BLOCKED" },
					{ kind: "RESUME", expectedRev: 4, expectedState: "EXECUTION" },
					{ kind: "FAIL", expectedRev: 5, expectedState: "FAILED" },
				];

				for (let i = 0; i < nonPrivilegedKinds.length; i++) {
					const { kind, expectedRev, expectedState } = nonPrivilegedKinds[i];
					const transitionId = `t-${String(i + 1).padStart(3, "0")}`;

					result = runCli([
						"benchmark",
						"long-horizon",
						"execution",
						"transition",
						"--contract",
						contractPath,
						"--execution",
						execPath,
						"--transition-id",
						transitionId,
						"--expected-revision",
						String(expectedRev),
						"--kind",
						kind,
						"--format",
						"json",
						"--output",
						execPath,
					]);

					if (i === nonPrivilegedKinds.length - 1) {
						// FAIL is terminal but still valid
						expect(result.status).toBe(0);
					} else {
						expect(result.status).toBe(0);
					}

					const content = JSON.parse(readFileSync(execPath, "utf-8"));
					expect(content.state).toBe(expectedState);
				}
			} finally {
				cleanupTempDir(dir);
			}
		});
	});

	// =============================================================================
	// ESM-27: CLI stale transition leaves output unchanged
	// =============================================================================

	describe("ESM-27: CLI stale transition leaves output unchanged", () => {
		it("stale expectedRevision leaves file unchanged", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const execPath = resolve(dir, "exec.json");

				// Init and apply one transition
				let result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"exec-cli-003",
					"--format",
					"json",
					"--output",
					execPath,
				]);
				expect(result.status).toBe(0);

				result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					contractPath,
					"--execution",
					execPath,
					"--transition-id",
					"t-001",
					"--expected-revision",
					"0",
					"--kind",
					"START_EXECUTION",
					"--format",
					"json",
					"--output",
					execPath,
				]);
				expect(result.status).toBe(0);

				// Read current state
				const beforeContent = readFileSync(execPath, "utf-8");
				const beforeJson = JSON.parse(beforeContent);
				expect(beforeJson.state).toBe("EXECUTION");
				expect(beforeJson.revision).toBe(1);

				// Attempt stale transition (expectedRevision 0, but record is at 1)
				result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					contractPath,
					"--execution",
					execPath,
					"--transition-id",
					"t-002",
					"--expected-revision",
					"0",
					"--kind",
					"REQUEST_VERIFICATION",
					"--format",
					"json",
					"--output",
					execPath,
				]);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain("STALE_REVISION");

				// File unchanged
				const afterContent = readFileSync(execPath, "utf-8");
				expect(afterContent).toBe(beforeContent);
			} finally {
				cleanupTempDir(dir);
			}
		});
	});
}

// =============================================================================
// ESM-28: Deterministic output across child processes
// =============================================================================

export function registerExecutionDeterminismTests(): void {
	describe("ESM-28: deterministic output across child processes", () => {
		it("produces identical JSON for same init twice", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const out1 = resolve(dir, "exec1.json");
				const out2 = resolve(dir, "exec2.json");

				const result1 = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"det-exec-001",
					"--format",
					"json",
					"--output",
					out1,
				]);
				expect(result1.status).toBe(0);

				const result2 = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"det-exec-001",
					"--format",
					"json",
					"--output",
					out2,
				]);
				expect(result2.status).toBe(0);

				const content1 = readFileSync(out1, "utf-8");
				const content2 = readFileSync(out2, "utf-8");
				expect(content1).toBe(content2);
			} finally {
				cleanupTempDir(dir);
			}
		});

		it("produces identical output for same transition path twice", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const outPath = resolve(dir, "exec.json");

				// Path 1
				runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"det-exec-002",
					"--format",
					"json",
					"--output",
					outPath,
				]);
				runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					contractPath,
					"--execution",
					outPath,
					"--transition-id",
					"t-001",
					"--expected-revision",
					"0",
					"--kind",
					"START_EXECUTION",
					"--format",
					"json",
					"--output",
					outPath,
				]);
				const content1 = readFileSync(outPath, "utf-8");

				// Path 2 (same steps, different output file)
				const out2Path = resolve(dir, "exec2.json");
				runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"det-exec-002",
					"--format",
					"json",
					"--output",
					out2Path,
				]);
				runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					contractPath,
					"--execution",
					out2Path,
					"--transition-id",
					"t-001",
					"--expected-revision",
					"0",
					"--kind",
					"START_EXECUTION",
					"--format",
					"json",
					"--output",
					out2Path,
				]);
				const content2 = readFileSync(out2Path, "utf-8");
				expect(content1).toBe(content2);
			} finally {
				cleanupTempDir(dir);
			}
		});
	});
}

// =============================================================================
// CLI validation
// =============================================================================

export function registerExecutionCommandTests(): void {
	describe("CLI execution validate", () => {
		it("validates a valid execution record", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const execPath = resolve(dir, "exec.json");

				runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"exec-val-001",
					"--format",
					"json",
					"--output",
					execPath,
				]);

				const result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"validate",
					"--contract",
					contractPath,
					"--execution",
					execPath,
				]);
				expect(result.status).toBe(0);
				expect(result.stdout).toContain("valid");
			} finally {
				cleanupTempDir(dir);
			}
		});

		it("rejects invalid execution record", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const execPath = resolve(dir, "exec.json");

				// Write an invalid execution record
				writeFileSync(
					execPath,
					JSON.stringify({
						executionVersion: 1,
						executionId: "bad-exec",
						contractDigest: "wrong-digest",
						revision: 0,
						state: "EXECUTION",
						transitions: [],
					}),
				);

				const result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"validate",
					"--contract",
					contractPath,
					"--execution",
					execPath,
				]);
				expect(result.status).toBe(1);
			} finally {
				cleanupTempDir(dir);
			}
		});
	});

	// =============================================================================
	// CLI inspect
	// =============================================================================

	describe("CLI execution inspect", () => {
		it("inspects a valid record", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const execPath = resolve(dir, "exec.json");

				runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"exec-insp-001",
					"--format",
					"json",
					"--output",
					execPath,
				]);

				const result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"inspect",
					"--contract",
					contractPath,
					"--execution",
					execPath,
				]);
				expect(result.status).toBe(0);
				expect(result.stdout).toContain("PLANNING");
				expect(result.stdout).toContain("unavailable");
			} finally {
				cleanupTempDir(dir);
			}
		});

		it("never claims completion approved", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const execPath = resolve(dir, "exec.json");

				// Init
				runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"exec-insp-002",
					"--format",
					"json",
					"--output",
					execPath,
				]);

				const result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"inspect",
					"--contract",
					contractPath,
					"--execution",
					execPath,
				]);
				expect(result.stdout).toContain("unavailable");
				expect(result.stdout).not.toContain("COMPLETED");
			} finally {
				cleanupTempDir(dir);
			}
		});
	});

	// =============================================================================
	// CLI help
	// =============================================================================

	describe("CLI execution help", () => {
		it("shows help for execution commands", () => {
			const { status, stdout } = runCli(["benchmark", "long-horizon", "--help"]);
			expect(status).toBe(0);
			expect(stdout).toContain("execution init");
			expect(stdout).toContain("execution inspect");
			expect(stdout).toContain("execution validate");
			expect(stdout).toContain("execution transition");
		});
	});

	// =============================================================================
	// CLI error handling
	// =============================================================================

	describe("CLI execution error handling", () => {
		it("rejects missing --contract for init", () => {
			const { status } = runCli(["benchmark", "long-horizon", "execution", "init"]);
			expect(status).toBe(1);
		});

		it("rejects missing --execution-id for init", () => {
			const { status } = runCli([
				"benchmark",
				"long-horizon",
				"execution",
				"init",
				"--contract",
				resolve(FIXTURES, "M01-contract.json"),
			]);
			expect(status).toBe(1);
		});

		it("rejects invalid transition kind", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const execPath = resolve(dir, "exec.json");

				runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"exec-err-001",
					"--format",
					"json",
					"--output",
					execPath,
				]);

				const { status, stderr } = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					contractPath,
					"--execution",
					execPath,
					"--transition-id",
					"t-001",
					"--expected-revision",
					"0",
					"--kind",
					"INVALID_KIND",
				]);
				expect(status).toBe(1);
				expect(stderr).toContain("invalid transition kind");
			} finally {
				cleanupTempDir(dir);
			}
		});

		it("rejects missing --expected-revision for transition", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const execPath = resolve(dir, "exec.json");

				runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"exec-err-002",
					"--format",
					"json",
					"--output",
					execPath,
				]);

				const { status, stderr } = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					contractPath,
					"--execution",
					execPath,
					"--transition-id",
					"t-001",
					"--kind",
					"START_EXECUTION",
				]);
				expect(status).toBe(1);
				expect(stderr).toContain("--expected-revision");
			} finally {
				cleanupTempDir(dir);
			}
		});

		it("rejects non-existent execution file", () => {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const { status } = runCli([
				"benchmark",
				"long-horizon",
				"execution",
				"validate",
				"--contract",
				contractPath,
				"--execution",
				"/tmp/nonexistent-exec.json",
			]);
			expect(status).toBe(1);
		});
	});
}
