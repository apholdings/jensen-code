/**
 * Long-horizon CLI exit-code contract tests (authoritative evidence).
 *
 * Tests the full CLI path using child_process to verify
 * authoritative exit codes, stdout, and stderr.
 *
 * Split out of cli.test.ts so each vitest worker stays well under the 60s
 * RPC ceiling (vitest birpc DEFAULT_TIMEOUT) that the full-CLI spawns can
 * exceed under CI load. Test coverage is unchanged.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const FIXTURES = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures");

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync("bash", [resolve(REPO_ROOT, "jensen-test.sh"), "--no-env", ...args], {
		cwd: REPO_ROOT,
		timeout: 15_000,
		encoding: "utf-8",
		env: {
			...process.env,
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
// Authoritative evidence SATISFIED flow
// =============================================================================

describe("CLI authoritative-evidence SATISFIED flow", () => {
	it("rejects explicit authoritative evidence before SATISFIED", { timeout: 15000 }, () => {
		const dir = mkdtempSync(resolve(tmpdir(), "lh-cli-test-"));
		const ledPath = resolve(dir, "ledger.json");
		const evPath = resolve(dir, "evidence.json");

		try {
			// Init
			let r = runCli([
				"benchmark",
				"long-horizon",
				"ledger",
				"init",
				"--contract",
				resolve(FIXTURES, "M01-contract.json"),
				"--format",
				"json",
				"--output",
				ledPath,
			]);
			expect(r.status).toBe(0);

			// IMPLEMENTED_UNVERIFIED
			r = runCli([
				"benchmark",
				"long-horizon",
				"ledger",
				"transition",
				"--contract",
				resolve(FIXTURES, "M01-contract.json"),
				"--ledger",
				ledPath,
				"--expected-revision",
				"0",
				"--requirement-id",
				"REQ-001",
				"--to-status",
				"IMPLEMENTED_UNVERIFIED",
				"--actor-type",
				"agent",
				"--reason",
				"Done",
				"--transition-id",
				"TX-CLI-AUTH-001",
				"--format",
				"json",
				"--output",
				ledPath,
			]);
			expect(r.status).toBe(0);

			// Generic CLI must reject explicit authoritative evidence.
			const evidence = {
				id: "EV-TEST",
				type: "test-result",
				requirementIds: ["REQ-001"],
				criterionIds: ["AC-001"],
				collectorType: "test-runner",
				reportedAuthority: true,
				status: "pass",
				source: "npm test",
				summary: "All tests pass",
			};
			writeFileSync(evPath, JSON.stringify(evidence));

			r = runCli([
				"benchmark",
				"long-horizon",
				"ledger",
				"add-evidence",
				"--contract",
				resolve(FIXTURES, "M01-contract.json"),
				"--ledger",
				ledPath,
				"--expected-revision",
				"1",
				"--evidence-input",
				evPath,
				"--format",
				"json",
				"--output",
				ledPath,
			]);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("UNTRUSTED_AUTHORITY_CLAIM");
			const unchangedLedger = JSON.parse(readFileSync(ledPath, "utf-8"));
			expect(unchangedLedger.revision).toBe(1);
			expect(unchangedLedger.evidence).toHaveLength(0);

			// Operator SATISFIED remains unavailable through generic CLI.
			// Generic CLI is UNTRUSTED — SATISFIED requires trusted context
			r = runCli([
				"benchmark",
				"long-horizon",
				"ledger",
				"transition",
				"--contract",
				resolve(FIXTURES, "M01-contract.json"),
				"--ledger",
				ledPath,
				"--expected-revision",
				"1",
				"--requirement-id",
				"REQ-001",
				"--to-status",
				"SATISFIED",
				"--actor-type",
				"operator",
				"--reason",
				"Verified by tests",
				"--evidence-ids",
				"EV-TEST",
				"--transition-id",
				"TX-CLI-AUTH-002",
				"--format",
				"json",
				"--output",
				ledPath,
			]);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("untrusted context");
		} finally {
			try {
				unlinkSync(ledPath);
			} catch {}
			try {
				unlinkSync(evPath);
			} catch {}
			try {
				rmdirSync(dir);
			} catch {}
		}
	});
});

// =============================================================================
// Ledger inspect
// =============================================================================

describe("CLI ledger inspect", () => {
	it("exits 0 for incomplete mission", () => {
		const dir = mkdtempSync(resolve(tmpdir(), "lh-cli-test-"));
		const ledPath = resolve(dir, "ledger.json");

		try {
			let r = runCli([
				"benchmark",
				"long-horizon",
				"ledger",
				"init",
				"--contract",
				resolve(FIXTURES, "M01-contract.json"),
				"--format",
				"json",
				"--output",
				ledPath,
			]);
			expect(r.status).toBe(0);

			r = runCli([
				"benchmark",
				"long-horizon",
				"ledger",
				"inspect",
				"--contract",
				resolve(FIXTURES, "M01-contract.json"),
				"--ledger",
				ledPath,
			]);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("Ledger Inspection (structural only)");
			expect(r.stdout).toContain("Completion Candidate");
			expect(r.stdout).toContain("unavailable");
		} finally {
			try {
				unlinkSync(ledPath);
			} catch {}
			try {
				rmdirSync(dir);
			} catch {}
		}
	});
});

// =============================================================================
// Invalid output path
// =============================================================================

describe("CLI invalid output path", () => {
	it("exits 1 for nonexistent directory", () => {
		const { status } = runCli([
			"benchmark",
			"long-horizon",
			"ledger",
			"init",
			"--contract",
			resolve(FIXTURES, "M01-contract.json"),
			"--output",
			"/nonexistent-dir/ledger.json",
		]);
		expect(status).toBe(1);
	});
});

// =============================================================================
// Malformed JSON
// =============================================================================

describe("CLI malformed JSON", () => {
	it("exits 1 for malformed contract", () => {
		const dir = mkdtempSync(resolve(tmpdir(), "lh-cli-test-"));
		const cPath = resolve(dir, "bad.json");
		writeFileSync(cPath, "not json {{{");

		try {
			const { status } = runCli(["benchmark", "long-horizon", "mission", "validate", "--contract", cPath]);
			expect(status).toBe(1);
		} finally {
			try {
				unlinkSync(cPath);
			} catch {}
			try {
				rmdirSync(dir);
			} catch {}
		}
	});
});

// =============================================================================
// Provider isolation
// =============================================================================

describe("CLI provider isolation", () => {
	it("does not hit model initialization or interactive mode", () => {
		const { status, stdout } = runCli([
			"benchmark",
			"long-horizon",
			"mission",
			"validate",
			"--contract",
			resolve(FIXTURES, "M01-contract.json"),
		]);
		expect(status).toBe(0);
		expect(stdout).not.toContain("Model scope");
		expect(stdout).not.toContain("No models available");
	});
});
