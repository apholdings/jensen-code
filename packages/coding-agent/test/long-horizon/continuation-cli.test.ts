/**
 * LH-3 Continuation Scheduler CLI tests.
 *
 * Real child-process tests that invoke the actual CLI via
 * npx tsx packages/coding-agent/src/cli.ts.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmdirSync, writeFileSync } from "fs";
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
	return mkdtempSync(resolve(tmpdir(), "lh3-cs-cli-"));
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

// =============================================================================
// Init
// =============================================================================

describe("CLI continuation init", () => {
	it("creates IDLE scheduler record at revision 0", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const schedulerPath = resolve(dir, "scheduler.json");

			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"init",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution-id",
				"exec-test-001",
				"--format",
				"json",
			]);
			expect(result.status).toBe(0);

			const record = JSON.parse(result.stdout);
			expect(record.schedulerVersion).toBe(1);
			expect(record.executionId).toBe("exec-test-001");
			expect(record.schedulerRevision).toBe(0);
			expect(record.state).toBe("IDLE");
			expect(record.events).toEqual([]);
			expect(record.historyDigest).toBeNull();
		} finally {
			cleanupTempDir(dir);
		}
	});

	it("rejects missing --scheduler", () => {
		const result = runCli([
			"benchmark",
			"long-horizon",
			"continuation",
			"init",
			"--contract",
			resolve(FIXTURES, "M01-contract.json"),
			"--execution-id",
			"test",
		]);
		expect(result.status).toBe(1);
	});
});

// =============================================================================
// Inspect
// =============================================================================

describe("CLI continuation inspect", () => {
	it("inspects a valid scheduler record", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const schedulerPath = resolve(dir, "scheduler.json");

			// Init
			let result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"init",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution-id",
				"exec-inspect",
				"--format",
				"json",
			]);
			expect(result.status).toBe(0);

			// Inspect
			result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"inspect",
				"--scheduler",
				schedulerPath,
				"--format",
				"json",
			]);
			expect(result.status).toBe(0);

			const inspection = JSON.parse(result.stdout);
			expect(inspection.valid).toBe(true);
			expect(inspection.state).toBe("IDLE");
			expect(inspection.schedulerRevision).toBe(0);
			expect(inspection.eventCount).toBe(0);
		} finally {
			cleanupTempDir(dir);
		}
	});

	it("reports ENOENT for missing scheduler", () => {
		const result = runCli([
			"benchmark",
			"long-horizon",
			"continuation",
			"inspect",
			"--scheduler",
			"/tmp/nonexistent-scheduler.json",
		]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("ENOENT");
	});
});

// =============================================================================
// Full lifecycle: schedule → dispatch → consume
// =============================================================================

describe("CLI full lifecycle", () => {
	it("completes schedule → dispatch → consume", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const schedulerPath = resolve(dir, "scheduler.json");
			const contractDigest = computeContractDigest(contractPath);

			// Create a minimal execution record
			const execPath = resolve(dir, "exec.json");
			writeFileSync(
				execPath,
				JSON.stringify({
					executionId: "exec-lifecycle",
					contractDigest,
					revision: 5,
				}),
			);

			// Init scheduler
			let result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"init",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution-id",
				"exec-lifecycle",
			]);
			expect(result.status).toBe(0);

			// Schedule
			result = runCli([
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
				"sched-001",
				"--expected-scheduler-revision",
				"0",
				"--expected-execution-revision",
				"5",
				"--format",
				"json",
			]);
			expect(result.status).toBe(0);
			const scheduleEvent = JSON.parse(result.stdout);
			expect(scheduleEvent.kind).toBe("SCHEDULE");
			expect(scheduleEvent.cycleId).toBe("sched-001");

			// Verify record on disk
			const record1 = JSON.parse(readFileSync(schedulerPath, "utf-8"));
			expect(record1.state).toBe("SCHEDULED");
			expect(record1.schedulerRevision).toBe(1);

			// Dispatch
			result = runCli([
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
				"disp-001",
				"--cycle-id",
				"sched-001",
				"--dispatched-continuation-id",
				"cont-001",
				"--expected-scheduler-revision",
				"1",
				"--format",
				"json",
			]);
			expect(result.status).toBe(0);
			const dispatchEvent = JSON.parse(result.stdout);
			expect(dispatchEvent.kind).toBe("DISPATCH");

			const record2 = JSON.parse(readFileSync(schedulerPath, "utf-8"));
			expect(record2.state).toBe("DISPATCHED");
			expect(record2.schedulerRevision).toBe(2);

			// Consume
			result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"consume",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"cons-001",
				"--cycle-id",
				"sched-001",
				"--dispatched-continuation-id",
				"cont-001",
				"--result-digest",
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"--expected-scheduler-revision",
				"2",
				"--format",
				"json",
			]);
			expect(result.status).toBe(0);
			const consumeEvent = JSON.parse(result.stdout);
			expect(consumeEvent.kind).toBe("CONSUME");
			expect(consumeEvent.resultDigest).toBe(
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			);

			const record3 = JSON.parse(readFileSync(schedulerPath, "utf-8"));
			expect(record3.state).toBe("IDLE");
			expect(record3.schedulerRevision).toBe(3);
		} finally {
			cleanupTempDir(dir);
		}
	});
});

// =============================================================================
// Cancel
// =============================================================================

describe("CLI cancel", () => {
	it("cancels an active SCHEDULED cycle", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const schedulerPath = resolve(dir, "scheduler.json");
			const contractDigest = computeContractDigest(contractPath);

			const execPath = resolve(dir, "exec.json");
			writeFileSync(
				execPath,
				JSON.stringify({
					executionId: "exec-cancel",
					contractDigest,
					revision: 10,
				}),
			);

			// Init + schedule
			let result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"init",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution-id",
				"exec-cancel",
			]);
			expect(result.status).toBe(0);

			result = runCli([
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
				"sched-cancel",
				"--expected-scheduler-revision",
				"0",
				"--expected-execution-revision",
				"5",
			]);
			expect(result.status).toBe(0);

			// Cancel
			result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"cancel",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"cancel-001",
				"--cycle-id",
				"sched-cancel",
				"--expected-scheduler-revision",
				"1",
				"--format",
				"json",
			]);
			expect(result.status).toBe(0);
			const cancelEvent = JSON.parse(result.stdout);
			expect(cancelEvent.kind).toBe("CANCEL");

			const record = JSON.parse(readFileSync(schedulerPath, "utf-8"));
			expect(record.state).toBe("IDLE");
		} finally {
			cleanupTempDir(dir);
		}
	});
});

// =============================================================================
// Abandon
// =============================================================================

describe("CLI abandon", () => {
	it("abandons a superseded cycle", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const schedulerPath = resolve(dir, "scheduler.json");
			const contractDigest = computeContractDigest(contractPath);

			const execPath = resolve(dir, "exec.json");
			writeFileSync(
				execPath,
				JSON.stringify({
					executionId: "exec-abandon",
					contractDigest,
					revision: 10, // > expectedExecutionRevision of 5
				}),
			);

			// Init + schedule
			let result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"init",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution-id",
				"exec-abandon",
			]);
			expect(result.status).toBe(0);

			result = runCli([
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
				"sched-abandon",
				"--expected-scheduler-revision",
				"0",
				"--expected-execution-revision",
				"5",
			]);
			expect(result.status).toBe(0);

			// Abandon (execution revision 10 > 5 → superseded)
			result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"abandon",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"abandon-001",
				"--cycle-id",
				"sched-abandon",
				"--expected-scheduler-revision",
				"1",
				"--format",
				"json",
			]);
			expect(result.status).toBe(0);
			const abandonEvent = JSON.parse(result.stdout);
			expect(abandonEvent.kind).toBe("ABANDON");

			const record = JSON.parse(readFileSync(schedulerPath, "utf-8"));
			expect(record.state).toBe("IDLE");
		} finally {
			cleanupTempDir(dir);
		}
	});

	it("rejects abandon when execution revision equals expected (not superseded)", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const schedulerPath = resolve(dir, "scheduler.json");
			const contractDigest = computeContractDigest(contractPath);

			const execPath = resolve(dir, "exec.json");
			writeFileSync(
				execPath,
				JSON.stringify({
					executionId: "exec-notsup",
					contractDigest,
					revision: 5, // same as expectedExecutionRevision
				}),
			);

			// Init + schedule
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
				"exec-notsup",
			]);
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
				"sched-ns",
				"--expected-scheduler-revision",
				"0",
				"--expected-execution-revision",
				"5",
			]);

			// Abandon should fail
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"abandon",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--event-id",
				"abandon-fail",
				"--cycle-id",
				"sched-ns",
				"--expected-scheduler-revision",
				"1",
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("CYCLE_NOT_SUPERSEDED");
		} finally {
			cleanupTempDir(dir);
		}
	});
});

// =============================================================================
// Validate
// =============================================================================

describe("CLI validate", () => {
	it("validates a scheduler record", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const schedulerPath = resolve(dir, "scheduler.json");
			const contractDigest = computeContractDigest(contractPath);

			const execPath = resolve(dir, "exec.json");
			writeFileSync(
				execPath,
				JSON.stringify({
					executionId: "exec-validate",
					contractDigest,
					revision: 0,
				}),
			);

			// Init
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
				"exec-validate",
			]);

			// Validate
			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"validate",
				"--scheduler",
				schedulerPath,
				"--contract",
				contractPath,
				"--execution",
				execPath,
				"--format",
				"json",
			]);
			expect(result.status).toBe(0);

			const validation = JSON.parse(result.stdout);
			expect(validation.valid).toBe(true);
			expect(validation.contractBound).toBe(true);
			expect(validation.executionBound).toBe(true);
			expect(validation.semanticValid).toBe(true);
		} finally {
			cleanupTempDir(dir);
		}
	});

	it("rejects contract digest mismatch", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const schedulerPath = resolve(dir, "scheduler.json");

			// Use a different digest in the execution record
			const execPath = resolve(dir, "exec.json");
			writeFileSync(
				execPath,
				JSON.stringify({
					executionId: "exec-bind",
					contractDigest: "wrong-digest-here",
					revision: 0,
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
				"exec-bind",
			]);

			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"validate",
				"--scheduler",
				schedulerPath,
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
// Error handling
// =============================================================================

describe("CLI error handling", () => {
	it("rejects stale scheduler revision", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const schedulerPath = resolve(dir, "scheduler.json");
			const contractDigest = computeContractDigest(contractPath);

			const execPath = resolve(dir, "exec.json");
			writeFileSync(
				execPath,
				JSON.stringify({
					executionId: "exec-stale",
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
				"exec-stale",
			]);
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

			// Try with stale revision
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
				"0", // stale — should be 1
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("STALE_SCHEDULER_REVISION");
		} finally {
			cleanupTempDir(dir);
		}
	});

	it("rejects invalid state for operation", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const schedulerPath = resolve(dir, "scheduler.json");
			const contractDigest = computeContractDigest(contractPath);

			const execPath = resolve(dir, "exec.json");
			writeFileSync(
				execPath,
				JSON.stringify({
					executionId: "exec-state",
					contractDigest,
					revision: 5,
				}),
			);

			// Init (IDLE@0)
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
				"exec-state",
			]);

			// Try to dispatch from IDLE
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
				"0",
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("INVALID_STATE");
		} finally {
			cleanupTempDir(dir);
		}
	});

	it("idempotent retry returns same event", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const schedulerPath = resolve(dir, "scheduler.json");
			const contractDigest = computeContractDigest(contractPath);

			const execPath = resolve(dir, "exec.json");
			writeFileSync(
				execPath,
				JSON.stringify({
					executionId: "exec-idem",
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
				"exec-idem",
			]);
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
				"idem-s",
				"--expected-scheduler-revision",
				"0",
				"--expected-execution-revision",
				"5",
			]);

			// Retry — should succeed with existing event (same fingerprint)
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
				"idem-s",
				"--expected-scheduler-revision",
				"0",
				"--expected-execution-revision",
				"5",
				"--format",
				"json",
			]);
			expect(result.status).toBe(0);

			const event = JSON.parse(result.stdout);
			expect(event.kind).toBe("SCHEDULE");
			expect(event.eventId).toBe("idem-s");

			// Record should still be at revision 1, not 2
			const record = JSON.parse(readFileSync(schedulerPath, "utf-8"));
			expect(record.schedulerRevision).toBe(1);
		} finally {
			cleanupTempDir(dir);
		}
	});

	it("rejects missing required arguments", () => {
		const result = runCli([
			"benchmark",
			"long-horizon",
			"continuation",
			"schedule",
			"--contract",
			resolve(FIXTURES, "M01-contract.json"),
		]);
		expect(result.status).toBe(1);
	});

	it("missing scheduler fails for dispatch", () => {
		const dir = createTempDir();
		try {
			const contractPath = resolve(FIXTURES, "M01-contract.json");
			const contractDigest = computeContractDigest(contractPath);

			const execPath = resolve(dir, "exec.json");
			writeFileSync(
				execPath,
				JSON.stringify({
					executionId: "exec-miss",
					contractDigest,
					revision: 5,
				}),
			);

			const result = runCli([
				"benchmark",
				"long-horizon",
				"continuation",
				"dispatch",
				"--scheduler",
				resolve(dir, "nonexistent.json"),
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
				"0",
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("ENOENT");
		} finally {
			cleanupTempDir(dir);
		}
	});
});
