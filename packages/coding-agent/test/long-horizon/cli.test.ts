/**
 * Long-horizon CLI exit-code contract tests.
 *
 * Tests the full CLI path using child_process to verify
 * authoritative exit codes, stdout, and stderr.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const FIXTURES = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures");

function extractLastLine(output: string): string {
	return output.trim().split("\n").pop() ?? "";
}

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
// Help test
// =============================================================================

describe("CLI help", () => {
	it("shows help for mission validate --help", () => {
		const { status, stdout } = runCli(["benchmark", "long-horizon", "mission", "validate", "--help"]);
		expect(status).toBe(0);
		expect(stdout).toContain("Usage:");
	});

	it("shows help for ledger init --help", () => {
		const { status, stdout } = runCli(["benchmark", "long-horizon", "ledger", "init", "--help"]);
		expect(status).toBe(0);
		expect(stdout).toContain("Usage:");
	});
});

// =============================================================================
// Mission validate
// =============================================================================

describe("CLI mission validate", () => {
	it("exits 0 for valid contract", () => {
		const { status, stdout } = runCli([
			"benchmark",
			"long-horizon",
			"mission",
			"validate",
			"--contract",
			resolve(FIXTURES, "M01-contract.json"),
		]);
		expect(status).toBe(0);
		expect(stdout).toContain("Contract is valid");
	});

	it("exits 1 for invalid contract", () => {
		const { status, stdout } = runCli([
			"benchmark",
			"long-horizon",
			"mission",
			"validate",
			"--contract",
			resolve(FIXTURES, "M04-contract.json"),
		]);
		expect(status).toBe(1);
		expect(stdout).toContain("Contract is invalid");
	});

	it("exits 1 for missing contract", () => {
		const { status } = runCli([
			"benchmark",
			"long-horizon",
			"mission",
			"validate",
			"--contract",
			"/tmp/nonexistent-contract.json",
		]);
		expect(status).toBe(1);
	});
});

// =============================================================================
// Mission digest
// =============================================================================

describe("CLI mission digest", () => {
	it("produces stable lowercase hex digest", () => {
		const r1 = runCli([
			"benchmark",
			"long-horizon",
			"mission",
			"digest",
			"--contract",
			resolve(FIXTURES, "M01-contract.json"),
		]);
		expect(r1.status).toBe(0);
		const d1 = extractLastLine(r1.stdout);

		const r2 = runCli([
			"benchmark",
			"long-horizon",
			"mission",
			"digest",
			"--contract",
			resolve(FIXTURES, "M01-contract.json"),
		]);
		expect(r2.status).toBe(0);
		const d2 = extractLastLine(r2.stdout);

		expect(d1).toBe(d2);
		expect(d1).toMatch(/^[0-9a-f]{64}$/);
	});
});

// =============================================================================
// Ledger init
// =============================================================================

describe("CLI ledger init", () => {
	it("exits 0 and creates valid ledger", () => {
		const dir = mkdtempSync(resolve(tmpdir(), "lh-cli-test-"));
		const outPath = resolve(dir, "ledger.json");

		try {
			const { status } = runCli([
				"benchmark",
				"long-horizon",
				"ledger",
				"init",
				"--contract",
				resolve(FIXTURES, "M01-contract.json"),
				"--format",
				"json",
				"--output",
				outPath,
			]);
			expect(status).toBe(0);

			const content = readFileSync(outPath, "utf-8");
			const ledger = JSON.parse(content);
			expect(ledger.revision).toBe(0);
			expect(ledger.ledgerVersion).toBe(1);
			expect(ledger.requirements).toBeDefined();
		} finally {
			try {
				unlinkSync(outPath);
			} catch {}
			try {
				rmdirSync(dir);
			} catch {}
		}
	});

	it("exits 1 for invalid contract", () => {
		const { status } = runCli([
			"benchmark",
			"long-horizon",
			"ledger",
			"init",
			"--contract",
			resolve(FIXTURES, "M04-contract.json"),
		]);
		expect(status).toBe(1);
	});
});

// =============================================================================
// Ledger validate
// =============================================================================

describe("CLI ledger validate", () => {
	it("exits 0 for valid ledger", () => {
		const dir = mkdtempSync(resolve(tmpdir(), "lh-cli-test-"));
		const ledPath = resolve(dir, "ledger.json");

		try {
			// Init ledger
			const ir = runCli([
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
			expect(ir.status).toBe(0);

			const vr = runCli([
				"benchmark",
				"long-horizon",
				"ledger",
				"validate",
				"--contract",
				resolve(FIXTURES, "M01-contract.json"),
				"--ledger",
				ledPath,
			]);
			expect(vr.status).toBe(0);
			expect(vr.stdout).toContain("Ledger structure is valid");
			expect(vr.stdout).toContain("Trusted provenance was not verified");
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
// Ledger transition
// =============================================================================

describe("CLI ledger transition", () => {
	it("valid transition: revision 0 -> 1", () => {
		const dir = mkdtempSync(resolve(tmpdir(), "lh-cli-test-"));
		const ledPath = resolve(dir, "ledger.json");

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

			// Transition
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
				"PENDING",
				"--actor-type",
				"agent",
				"--reason",
				"Starting work",
				"--transition-id",
				"TX-CLI-VALID-001",
				"--format",
				"json",
				"--output",
				ledPath,
			]);
			expect(r.status).toBe(0);

			const ledger = JSON.parse(readFileSync(ledPath, "utf-8"));
			expect(ledger.revision).toBe(1);
		} finally {
			try {
				unlinkSync(ledPath);
			} catch {}
			try {
				rmdirSync(dir);
			} catch {}
		}
	});

	it("stale transition exits 1", () => {
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
				"transition",
				"--contract",
				resolve(FIXTURES, "M01-contract.json"),
				"--ledger",
				ledPath,
				"--expected-revision",
				"5",
				"--requirement-id",
				"REQ-001",
				"--to-status",
				"PENDING",
				"--actor-type",
				"agent",
				"--reason",
				"Start",
				"--transition-id",
				"TX-CLI-STALE-001",
			]);
			expect(r.status).toBe(1);
		} finally {
			try {
				unlinkSync(ledPath);
			} catch {}
			try {
				rmdirSync(dir);
			} catch {}
		}
	});

	it("claim-only SATISFIED attempt exits 1", () => {
		const dir = mkdtempSync(resolve(tmpdir(), "lh-cli-test-"));
		const ledPath = resolve(dir, "ledger.json");

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
				"TX-CLI-CLAIM-001",
				"--format",
				"json",
				"--output",
				ledPath,
			]);
			expect(r.status).toBe(0);

			// Agent tries SATISFIED
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
				"agent",
				"--reason",
				"I claim done",
				"--transition-id",
				"TX-CLI-CLAIM-002",
			]);
			expect(r.status).toBe(1);
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
