import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RequirementLedgerV1 } from "../../src/core/long-horizon/types.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const CLI_PATH = "packages/coding-agent/src/cli.ts";
const CONTRACT_PATH = resolve(
	REPO_ROOT,
	"packages",
	"coding-agent",
	"src",
	"core",
	"long-horizon",
	"fixtures",
	"M01-contract.json",
);

interface CliResult {
	readonly command: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly status: number | null;
}

interface LedgerSnapshot {
	readonly bytes: Buffer;
	readonly sha256: string;
	readonly revision: number;
	readonly evidenceCount: number;
	readonly temporarySiblings: string[];
}

function runCli(args: string[]): CliResult {
	const commandArgs = ["tsx", CLI_PATH, ...args];
	const result = spawnSync("npx", commandArgs, {
		cwd: REPO_ROOT,
		timeout: 30_000,
		encoding: "utf-8",
		env: {
			...process.env,
			ANTHROPIC_API_KEY: "",
			OPENAI_API_KEY: "",
			NO_COLOR: "1",
		},
	});
	return {
		command: `npx ${commandArgs.join(" ")}`,
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status,
	};
}

function initLedger(directory: string): string {
	const ledgerPath = resolve(directory, "ledger.json");
	const result = runCli([
		"benchmark",
		"long-horizon",
		"ledger",
		"init",
		"--contract",
		CONTRACT_PATH,
		"--format",
		"json",
		"--output",
		ledgerPath,
	]);
	expect(result.command).toContain("npx tsx packages/coding-agent/src/cli.ts");
	expect(result.status, result.stderr).toBe(0);
	return ledgerPath;
}

function snapshotLedger(ledgerPath: string): LedgerSnapshot {
	const bytes = readFileSync(ledgerPath);
	const ledger = JSON.parse(bytes.toString("utf-8")) as RequirementLedgerV1;
	const temporaryPrefix = `${basename(ledgerPath)}.tmp.`;
	return {
		bytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		revision: ledger.revision,
		evidenceCount: ledger.evidence.length,
		temporarySiblings: readdirSync(resolve(ledgerPath, "..")).filter((name) => name.startsWith(temporaryPrefix)),
	};
}

function baseEvidence(id: string): Record<string, unknown> {
	return {
		id,
		type: "agent-observation",
		requirementIds: ["REQ-001"],
		criterionIds: [],
		status: "unknown",
		source: "agent-observation",
		summary: "Ordinary agent claim",
		collectorType: "agent",
		reportedAuthority: false,
		authority: "agent-claim",
	};
}

function addEvidenceArgs(ledgerPath: string, evidencePath: string, expectedRevision: number): string[] {
	return [
		"benchmark",
		"long-horizon",
		"ledger",
		"add-evidence",
		"--contract",
		CONTRACT_PATH,
		"--ledger",
		ledgerPath,
		"--expected-revision",
		String(expectedRevision),
		"--evidence-input",
		evidencePath,
		"--format",
		"json",
		"--output",
		ledgerPath,
	];
}

function expectRejectedWithoutMutation(payload: Record<string, unknown>, expectedCode: string): CliResult {
	const directory = mkdtempSync(resolve(tmpdir(), "lh-cli-trust-"));
	try {
		const ledgerPath = initLedger(directory);
		const evidencePath = resolve(directory, "evidence.json");
		writeFileSync(evidencePath, JSON.stringify(payload), "utf-8");
		const before = snapshotLedger(ledgerPath);
		const result = runCli(addEvidenceArgs(ledgerPath, evidencePath, before.revision));
		const after = snapshotLedger(ledgerPath);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(expectedCode);
		expect(result.stdout).not.toContain('"revision"');
		expect(after.bytes.equals(before.bytes)).toBe(true);
		expect(after.sha256).toBe(before.sha256);
		expect(after.revision).toBe(before.revision);
		expect(after.evidenceCount).toBe(before.evidenceCount);
		expect(after.temporarySiblings).toEqual(before.temporarySiblings);
		expect(after.temporarySiblings).toEqual([]);
		return result;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/**
 * Long-horizon CLI trust-boundary contract tests (part 1 of 2).
 *
 * Exercises the generic CLI trust boundary with the full CLI child process.
 * Split out of the original single file so each vitest worker stays well under
 * the 60s RPC ceiling (vitest birpc DEFAULT_TIMEOUT) the many full-CLI spawns
 * can exceed under CI load. Coverage is unchanged.
 */

describe("generic CLI trust boundary", () => {
	it("CLI-TRUST-01 ordinary explicit agent-claim evidence succeeds", () => {
		const directory = mkdtempSync(resolve(tmpdir(), "lh-cli-trust-"));
		try {
			const ledgerPath = initLedger(directory);
			const evidencePath = resolve(directory, "evidence.json");
			writeFileSync(evidencePath, JSON.stringify(baseEvidence("EV-CLI-TRUST-01")), "utf-8");
			const before = snapshotLedger(ledgerPath);
			const result = runCli(addEvidenceArgs(ledgerPath, evidencePath, before.revision));
			const after = snapshotLedger(ledgerPath);
			const ledger = JSON.parse(after.bytes.toString("utf-8")) as RequirementLedgerV1;

			expect(result.status, result.stderr).toBe(0);
			expect(after.revision).toBe(before.revision + 1);
			expect(after.evidenceCount).toBe(before.evidenceCount + 1);
			expect(ledger.evidence[0]?.effectiveAuthority).toBe("agent-claim");
			expect(after.temporarySiblings).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("CLI-TRUST-02 reportedAuthority true is rejected", () => {
		expectRejectedWithoutMutation(
			{ ...baseEvidence("EV-CLI-TRUST-02"), reportedAuthority: true },
			"UNTRUSTED_AUTHORITY_CLAIM",
		);
	});

	it("CLI-TRUST-03 non-agent requested authority is rejected", () => {
		expectRejectedWithoutMutation(
			{ ...baseEvidence("EV-CLI-TRUST-03"), requestedAuthority: "test-result" },
			"UNTRUSTED_AUTHORITY_CLAIM",
		);
	});

	it("CLI-TRUST-04 trusted collector and authoritative source labels are rejected", () => {
		expectRejectedWithoutMutation(
			{
				...baseEvidence("EV-CLI-TRUST-04A"),
				collectorType: "trusted-collector",
			},
			"UNTRUSTED_AUTHORITY_CLAIM",
		);
		expectRejectedWithoutMutation(
			{ ...baseEvidence("EV-CLI-TRUST-04B"), source: "authoritative-test-runner" },
			"UNTRUSTED_AUTHORITY_CLAIM",
		);
	});

	it("CLI-TRUST-05 / CLI-T05 serialized fake TrustedValidationContext is rejected", () => {
		expectRejectedWithoutMutation(
			{
				...baseEvidence("EV-CLI-TRUST-05"),
				TrustedValidationContext: { trusted: true, boundContractDigest: "0".repeat(64) },
			},
			"TRUSTED_CONTEXT_REQUIRED",
		);
	});
});
