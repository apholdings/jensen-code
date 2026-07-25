/**
 * Long-horizon benchmark CLI exit-code contract tests.
 *
 * Tests the full CLI path using child_process to verify authoritative
 * exit codes, stdout, and stderr behavior.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const FIXTURES = resolve(__dirname, "..", "..", "src", "core", "benchmark", "fixtures");

/**
 * Run the benchmark CLI command via the development shell script.
 * Returns { stdout, stderr, status }.
 *
 * Uses --no-env to avoid requiring API keys.
 */
function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync("bash", [resolve(REPO_ROOT, "jensen-test.sh"), "--no-env", ...args], {
		cwd: REPO_ROOT,
		timeout: 30_000,
		encoding: "utf-8",
		env: {
			...process.env,
			// Ensure no API keys leak through
			ANTHROPIC_API_KEY: "",
			OPENAI_API_KEY: "",
		},
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status,
	};
}

// =============================================================================
// Exit-code contract tests
// =============================================================================

describe("C01 - Valid verified benchmark (G01)", () => {
	it("exits 0 with schema valid and gate true", () => {
		const { status } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G01-manifest.json"),
			"--run-report",
			resolve(FIXTURES, "G01-run.json"),
		]);
		expect(status).toBe(0);
	});

	it("reports PASS in completion gate verdict", () => {
		const { stdout } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G01-manifest.json"),
			"--run-report",
			resolve(FIXTURES, "G01-run.json"),
		]);
		expect(stdout).toContain("COMPLETION GATE");
		expect(stdout).toContain("Verdict");
		expect(stdout).toContain("PASS");
		expect(stdout).toContain("END OF REPORT");
	});
});

// =============================================================================

describe("C02 - Valid forbidden-action failure (G06)", () => {
	it("exits 0 with schema valid and gate false", () => {
		const { status } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G06-manifest.json"),
			"--run-report",
			resolve(FIXTURES, "G06-run.json"),
		]);
		expect(status).toBe(0);
	});

	it("reports FAIL in completion gate verdict", () => {
		const { stdout } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G06-manifest.json"),
			"--run-report",
			resolve(FIXTURES, "G06-run.json"),
		]);
		expect(stdout).toContain("COMPLETION GATE");
		expect(stdout).toContain("Verdict");
		expect(stdout).toContain("FAIL");
		expect(stdout).toContain("END OF REPORT");
	});
});

// =============================================================================

describe("C03 - Valid evidence-trust failure (G11)", () => {
	it("exits 0 with schema valid and gate false", () => {
		const { status } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G11-manifest.json"),
			"--run-report",
			resolve(FIXTURES, "G11-run.json"),
		]);
		expect(status).toBe(0);
	});

	it("reports FAIL in completion gate verdict", () => {
		const { stdout } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G11-manifest.json"),
			"--run-report",
			resolve(FIXTURES, "G11-run.json"),
		]);
		expect(stdout).toContain("COMPLETION GATE");
		expect(stdout).toContain("FAIL");
	});
});

// =============================================================================

describe("C04 - Dependency-cycle schema failure (G12)", () => {
	it("exits 1 with schema invalid and cycle message", () => {
		const { status, stdout } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G12-manifest.json"),
			"--run-report",
			resolve(FIXTURES, "G12-run.json"),
		]);
		expect(status).toBe(1);
		expect(stdout).toContain("SCHEMA VALIDATION");
		expect(stdout).toContain("FAIL");
		expect(stdout).toContain("cycle");
	});
});

// =============================================================================

describe("C05 - Duplicate evidence ID", () => {
	it("exits 1 with duplicate evidence message", () => {
		const manifest = {
			schemaVersion: 1,
			benchmarkId: "test-dup-ev",
			title: "test",
			category: "single-repository",
			repositoryFixture: { description: "test" },
			prompt: { text: "test" },
			requirements: [
				{
					id: "REQ-001",
					description: "do",
					source: "explicit-user",
					required: true,
					acceptanceCriteria: [],
					requiredEvidence: [{ type: "file-change", description: "file", minimumCount: 1 }],
				},
			],
		};
		const runReport = {
			schemaVersion: 1,
			runId: "test-run",
			benchmarkId: "test-dup-ev",
			agent: "test",
			model: "test",
			startedAt: "t",
			completedAt: "t",
			termination: { claimedTermination: "COMPLETED_AND_VERIFIED" },
			requirements: [
				{
					requirementId: "REQ-001",
					status: "SATISFIED",
					rationale: "done",
					evidenceIds: ["EV-DUP"],
				},
			],
			evidence: [
				{
					id: "EV-DUP",
					type: "file-change",
					requirementIds: ["REQ-001"],
					source: "test",
					summary: "test",
					authoritative: true,
					status: "pass",
				},
				{
					id: "EV-DUP",
					type: "file-change",
					requirementIds: ["REQ-001"],
					source: "test2",
					summary: "test2",
					authoritative: true,
					status: "pass",
				},
			],
			actions: [],
			artifacts: [],
		};

		const dir = mkdtempSync(resolve(tmpdir(), "bench-cli-test-"));
		const mPath = resolve(dir, "manifest.json");
		const rPath = resolve(dir, "run.json");
		writeFileSync(mPath, JSON.stringify(manifest));
		writeFileSync(rPath, JSON.stringify(runReport));

		try {
			const { status, stdout } = runCli([
				"benchmark",
				"long-horizon",
				"evaluate",
				"--manifest",
				mPath,
				"--run-report",
				rPath,
			]);
			expect(status).toBe(1);
			expect(stdout).toContain("Duplicate evidence id");
		} finally {
			unlinkSync(mPath);
			unlinkSync(rPath);
			rmdirSync(dir);
		}
	});
});

// =============================================================================

describe("C06 - Duplicate run result ID", () => {
	it("exits 1 with duplicate result message", () => {
		const manifest = {
			schemaVersion: 1,
			benchmarkId: "test-dup-rr",
			title: "test",
			category: "single-repository",
			repositoryFixture: { description: "test" },
			prompt: { text: "test" },
			requirements: [
				{
					id: "REQ-001",
					description: "do",
					source: "explicit-user",
					required: true,
					acceptanceCriteria: [],
				},
			],
		};
		const runReport = {
			schemaVersion: 1,
			runId: "test-run",
			benchmarkId: "test-dup-rr",
			agent: "test",
			model: "test",
			startedAt: "t",
			completedAt: "t",
			termination: { claimedTermination: "COMPLETED_AND_VERIFIED" },
			requirements: [
				{ requirementId: "REQ-001", status: "SATISFIED" },
				{ requirementId: "REQ-001", status: "FAILED" },
			],
			evidence: [],
			actions: [],
			artifacts: [],
		};

		const dir = mkdtempSync(resolve(tmpdir(), "bench-cli-test-"));
		const mPath = resolve(dir, "manifest.json");
		const rPath = resolve(dir, "run.json");
		writeFileSync(mPath, JSON.stringify(manifest));
		writeFileSync(rPath, JSON.stringify(runReport));

		try {
			const { status, stdout } = runCli([
				"benchmark",
				"long-horizon",
				"evaluate",
				"--manifest",
				mPath,
				"--run-report",
				rPath,
			]);
			expect(status).toBe(1);
			expect(stdout).toContain("Duplicate run requirement result id");
		} finally {
			unlinkSync(mPath);
			unlinkSync(rPath);
			rmdirSync(dir);
		}
	});
});

// =============================================================================

describe("C07 - Unknown schema version", () => {
	it("exits 1 with version error", () => {
		const manifest = {
			schemaVersion: 999,
			benchmarkId: "test-unk-schema",
			title: "test",
			category: "single-repository",
			repositoryFixture: { description: "test" },
			prompt: { text: "test" },
			requirements: [
				{
					id: "REQ-001",
					description: "do",
					source: "explicit-user",
					required: true,
					acceptanceCriteria: [],
				},
			],
		};
		const runReport = {
			schemaVersion: 1,
			runId: "test-run",
			benchmarkId: "test-unk-schema",
			agent: "test",
			model: "test",
			startedAt: "t",
			completedAt: "t",
			termination: { claimedTermination: "COMPLETED_AND_VERIFIED" },
			requirements: [{ requirementId: "REQ-001", status: "SATISFIED" }],
			evidence: [],
			actions: [],
			artifacts: [],
		};

		const dir = mkdtempSync(resolve(tmpdir(), "bench-cli-test-"));
		const mPath = resolve(dir, "manifest.json");
		const rPath = resolve(dir, "run.json");
		writeFileSync(mPath, JSON.stringify(manifest));
		writeFileSync(rPath, JSON.stringify(runReport));

		try {
			const { status, stdout } = runCli([
				"benchmark",
				"long-horizon",
				"evaluate",
				"--manifest",
				mPath,
				"--run-report",
				rPath,
			]);
			expect(status).toBe(1);
			expect(stdout).toContain("Unknown manifest schemaVersion");
		} finally {
			unlinkSync(mPath);
			unlinkSync(rPath);
			rmdirSync(dir);
		}
	});
});

// =============================================================================

describe("C08 - Malformed JSON", () => {
	it("exits 1 with parse error", () => {
		const dir = mkdtempSync(resolve(tmpdir(), "bench-cli-test-"));
		const mPath = resolve(dir, "manifest.json");
		const rPath = resolve(dir, "run.json");
		writeFileSync(mPath, "not json at all {{{");
		writeFileSync(rPath, '{"valid": "json"}');

		try {
			const { status, stderr } = runCli([
				"benchmark",
				"long-horizon",
				"evaluate",
				"--manifest",
				mPath,
				"--run-report",
				rPath,
			]);
			expect(status).toBe(1);
			// Malformed JSON produces a CLI stderr error, not an evaluation report
			expect(stderr).toContain("Error reading manifest");
		} finally {
			unlinkSync(mPath);
			unlinkSync(rPath);
			rmdirSync(dir);
		}
	});
});

// =============================================================================

describe("C09 - Missing manifest file", () => {
	it("exits 1 with read error", () => {
		const { status, stderr } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			"/tmp/nonexistent-manifest-xyz.json",
			"--run-report",
			resolve(FIXTURES, "G01-run.json"),
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("Error reading manifest");
	});
});

// =============================================================================

describe("C10 - Missing run report file", () => {
	it("exits 1 with read error", () => {
		const { status, stderr } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G01-manifest.json"),
			"--run-report",
			"/tmp/nonexistent-run-xyz.json",
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("Error reading run report");
	});
});

// =============================================================================

describe("C11 - Invalid output destination", () => {
	it("exits 1 with write error", () => {
		const { status, stderr } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G01-manifest.json"),
			"--run-report",
			resolve(FIXTURES, "G01-run.json"),
			"--output",
			"/root/should-not-write-here.txt",
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("Error writing output");
	});
});

// =============================================================================

describe("C12 - Valid --output", () => {
	it("exits 0 with valid output written", () => {
		const dir = mkdtempSync(resolve(tmpdir(), "bench-cli-test-"));
		const outPath = resolve(dir, "output.txt");

		try {
			const { status } = runCli([
				"benchmark",
				"long-horizon",
				"evaluate",
				"--manifest",
				resolve(FIXTURES, "G01-manifest.json"),
				"--run-report",
				resolve(FIXTURES, "G01-run.json"),
				"--output",
				outPath,
			]);
			expect(status).toBe(0);

			const content = readFileSync(outPath, "utf-8");
			expect(content).toContain("LONG-HORIZON BENCHMARK EVALUATION REPORT");
			expect(content).toContain("COMPLETION GATE");
			expect(content).toContain("PASS");
		} finally {
			try {
				unlinkSync(outPath);
			} catch {}
			try {
				rmdirSync(dir);
			} catch {}
		}
	});
});

// =============================================================================

describe("C13 - Text and JSON invalid-schema parity (G12)", () => {
	it("both text and JSON expose schema invalidity and exit 1", () => {
		// Text format
		const text = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G12-manifest.json"),
			"--run-report",
			resolve(FIXTURES, "G12-run.json"),
			"--format",
			"text",
		]);
		expect(text.status).toBe(1);
		expect(text.stdout).toContain("SCHEMA VALIDATION");
		expect(text.stdout).toContain("FAIL");
		expect(text.stdout).toContain("cycle");

		// JSON format
		const json = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G12-manifest.json"),
			"--run-report",
			resolve(FIXTURES, "G12-run.json"),
			"--format",
			"json",
		]);
		expect(json.status).toBe(1);
		// Strip stdout noise from the dev launcher script
		const stdout = json.stdout.replace("Running without API keys...\n", "").trim();
		const parsed = JSON.parse(stdout);
		expect(parsed.schemaValidation.valid).toBe(false);
		expect(parsed.schemaValidation.errors.some((e: string) => e.includes("cycle"))).toBe(true);
	});
});

// =============================================================================

describe("C14 - No provider initialization", () => {
	it("completes without hitting provider or interactive mode", () => {
		const { status, stdout, stderr } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G01-manifest.json"),
			"--run-report",
			resolve(FIXTURES, "G01-run.json"),
		]);
		expect(status).toBe(0);
		expect(stdout).toContain("END OF REPORT");
		// Should not contain any model-related initialization messages
		expect(stdout).not.toContain("Model scope");
		expect(stderr).not.toContain("No models available");
	});
});

// =============================================================================

describe("Missing required CLI arguments", () => {
	it("exits 1 when --manifest is missing", () => {
		const { status, stderr } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--run-report",
			resolve(FIXTURES, "G01-run.json"),
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("--manifest is required");
	});

	it("exits 1 when --run-report is missing", () => {
		const { status, stderr } = runCli([
			"benchmark",
			"long-horizon",
			"evaluate",
			"--manifest",
			resolve(FIXTURES, "G01-manifest.json"),
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("--run-report is required");
	});
});
