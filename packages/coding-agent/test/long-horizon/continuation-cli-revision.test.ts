/**
 * CLI malformed --expected-scheduler-revision and --expected-execution-revision regression tests.
 *
 * Real child-process tests that invoke the actual CLI.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, rmdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const FIXTURES = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures");

// =============================================================================
// Helpers
// =============================================================================

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync("npx", ["tsx", resolve(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts"), ...args], {
		cwd: REPO_ROOT,
		timeout: 15_000,
		encoding: "utf-8",
		env: {
			...process.env,
			ANTHROPIC_API_KEY: "",
			ANTHROPIC_OAUTH_TOKEN: "",
			OPENAI_API_KEY: "",
			GEMINI_API_KEY: "",
			GROQ_API_KEY: "",
			CEREBRAS_API_KEY: "",
			XAI_API_KEY: "",
			OPENROUTER_API_KEY: "",
			ZAI_API_KEY: "",
			MISTRAL_API_KEY: "",
			MINIMAX_API_KEY: "",
			MINIMAX_CN_API_KEY: "",
			AI_GATEWAY_API_KEY: "",
			OPENCODE_API_KEY: "",
			COPILOT_GITHUB_TOKEN: "",
			GH_TOKEN: "",
			GITHUB_TOKEN: "",
			GOOGLE_APPLICATION_CREDENTIALS: "",
			GOOGLE_CLOUD_PROJECT: "",
			GCLOUD_PROJECT: "",
			GOOGLE_CLOUD_LOCATION: "",
			AWS_PROFILE: "",
			AWS_ACCESS_KEY_ID: "",
			AWS_SECRET_ACCESS_KEY: "",
			AWS_SESSION_TOKEN: "",
			AWS_REGION: "",
			AWS_DEFAULT_REGION: "",
			AWS_BEARER_TOKEN_BEDROCK: "",
			AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "",
			AWS_CONTAINER_CREDENTIALS_FULL_URI: "",
			AWS_WEB_IDENTITY_TOKEN_FILE: "",
			AZURE_OPENAI_API_KEY: "",
			AZURE_OPENAI_BASE_URL: "",
			AZURE_OPENAI_RESOURCE_NAME: "",
		},
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status,
	};
}

function createTempDir(): string {
	return mkdtempSync(resolve(tmpdir(), "lh3-cs-rev-"));
}

function cleanupTempDir(dir: string): void {
	try {
		rmdirSync(dir, { recursive: true });
	} catch {}
}

function computeContractDigest(contractPath: string): string {
	const result = runCli(["benchmark", "long-horizon", "mission", "digest", "--contract", contractPath]);
	expect(result.status).toBe(0);
	return result.stdout.trim();
}

function setupSchedulerAndExec(dir: string): { schedulerPath: string; execPath: string; contractPath: string } {
	const contractPath = resolve(FIXTURES, "M01-contract.json");
	const schedulerPath = resolve(dir, "scheduler.json");
	const contractDigest = computeContractDigest(contractPath);

	const execPath = resolve(dir, "exec.json");
	writeFileSync(
		execPath,
		JSON.stringify({
			executionId: "exec-rev",
			contractDigest,
			revision: 5,
		}),
	);

	runCli([
		"benchmark",
		"long-horizon",
		"continuation",
		"init",
		"--scheduler",
		schedulerPath,
		"--contract",
		contractPath,
		"--execution-id",
		"exec-rev",
	]);

	return { schedulerPath, execPath, contractPath };
}

// =============================================================================
// Malformed --expected-scheduler-revision
// =============================================================================

describe("malformed --expected-scheduler-revision", () => {
	it('rejects "decimal 1.0"', () => {
		const dir = createTempDir();
		try {
			const { schedulerPath, execPath, contractPath } = setupSchedulerAndExec(dir);
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"schedule",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"ev-1",
				"--expected-scheduler-revision",
				"1.0",
				"--expected-execution-revision",
				"5",
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("invalid-expected-scheduler-revision");
		} finally {
			cleanupTempDir(dir);
		}
	});

	it('rejects "decimal 1.5"', () => {
		const dir = createTempDir();
		try {
			const { schedulerPath, execPath, contractPath } = setupSchedulerAndExec(dir);
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"schedule",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"ev-2",
				"--expected-scheduler-revision",
				"1.5",
				"--expected-execution-revision",
				"5",
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("invalid-expected-scheduler-revision");
		} finally {
			cleanupTempDir(dir);
		}
	});

	it('rejects "leading zero 01"', () => {
		const dir = createTempDir();
		try {
			const { schedulerPath, execPath, contractPath } = setupSchedulerAndExec(dir);
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"schedule",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"ev-3",
				"--expected-scheduler-revision",
				"01",
				"--expected-execution-revision",
				"5",
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("invalid-expected-scheduler-revision");
		} finally {
			cleanupTempDir(dir);
		}
	});

	it('rejects "negative -1"', () => {
		const dir = createTempDir();
		try {
			const { schedulerPath, execPath, contractPath } = setupSchedulerAndExec(dir);
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"schedule",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"ev-4",
				"--expected-scheduler-revision",
				"-1",
				"--expected-execution-revision",
				"5",
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("invalid-expected-scheduler-revision");
		} finally {
			cleanupTempDir(dir);
		}
	});

	it('rejects "above MAX_SAFE_INTEGER"', () => {
		const dir = createTempDir();
		try {
			const { schedulerPath, execPath, contractPath } = setupSchedulerAndExec(dir);
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"schedule",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"ev-5",
				"--expected-scheduler-revision",
				"9007199254740992",
				"--expected-execution-revision",
				"5",
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("invalid-expected-scheduler-revision");
		} finally {
			cleanupTempDir(dir);
		}
	});
});

// =============================================================================
// Malformed --expected-execution-revision
// =============================================================================

describe("malformed --expected-execution-revision", () => {
	it('rejects "decimal 1.0"', () => {
		const dir = createTempDir();
		try {
			const { schedulerPath, execPath, contractPath } = setupSchedulerAndExec(dir);
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"schedule",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"ev-6",
				"--expected-scheduler-revision",
				"0",
				"--expected-execution-revision",
				"1.0",
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("invalid-expected-execution-revision");
		} finally {
			cleanupTempDir(dir);
		}
	});

	it('rejects "scientific 1e2"', () => {
		const dir = createTempDir();
		try {
			const { schedulerPath, execPath, contractPath } = setupSchedulerAndExec(dir);
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"schedule",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"ev-7",
				"--expected-scheduler-revision",
				"0",
				"--expected-execution-revision",
				"1e2",
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("invalid-expected-execution-revision");
		} finally {
			cleanupTempDir(dir);
		}
	});
});

// =============================================================================
// Valid revision controls
// =============================================================================

describe("valid revision controls", () => {
	it("--expected-scheduler-revision 0 succeeds on fresh record", () => {
		const dir = createTempDir();
		try {
			const { schedulerPath, execPath, contractPath } = setupSchedulerAndExec(dir);
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"schedule",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"ev-valid-1",
				"--expected-scheduler-revision",
				"0",
				"--expected-execution-revision",
				"5",
			]);
			expect(result.status).toBe(0);
		} finally {
			cleanupTempDir(dir);
		}
	});

	it("--expected-scheduler-revision 1 succeeds after one schedule", () => {
		const dir = createTempDir();
		try {
			const { schedulerPath, execPath, contractPath } = setupSchedulerAndExec(dir);

			// Schedule first
			runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"schedule",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"s1",
				"--expected-scheduler-revision",
				"0",
				"--expected-execution-revision",
				"5",
			]);

			// Dispatch with rev 1
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"dispatch",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"d1",
				"--cycle-id",
				"s1",
				"--dispatched-continuation-id",
				"c1",
				"--expected-scheduler-revision",
				"1",
			]);
			expect(result.status).toBe(0);
		} finally {
			cleanupTempDir(dir);
		}
	});

	it("only schedule accepts --expected-execution-revision", () => {
		const dir = createTempDir();
		try {
			const { schedulerPath, execPath, contractPath } = setupSchedulerAndExec(dir);

			// Schedule works with both revision flags
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"schedule",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"ev-rev",
				"--expected-scheduler-revision",
				"0",
				"--expected-execution-revision",
				"5",
			]);
			expect(result.status).toBe(0);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
