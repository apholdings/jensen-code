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

function createSatisfiedLedger(directory: string): string {
	const ledgerPath = resolve(directory, "satisfied-ledger.json");
	const scriptPath = resolve(directory, "create-satisfied-ledger.ts");
	const requirementLedgerPath = resolve(
		REPO_ROOT,
		"packages/coding-agent/src/core/long-horizon/requirement-ledger.ts",
	);
	const trustedContextPath = resolve(REPO_ROOT, "packages/coding-agent/src/core/long-horizon/trusted-context.ts");
	const script = `
import { readFileSync, writeFileSync } from "node:fs";
import { addLedgerEvidence, applyRequirementTransition, initializeRequirementLedger } from ${JSON.stringify(requirementLedgerPath)};
import { _internalCreateTrustedContext, _internalCreateTrustedValidationContext, getUntrustedContext } from ${JSON.stringify(trustedContextPath)};

const contract = JSON.parse(readFileSync(${JSON.stringify(CONTRACT_PATH)}, "utf-8"));
const mutation = _internalCreateTrustedContext({
	principalId: "internal-runner",
	principalKind: "automated-review",
	capabilities: ["evidence:test-result", "transition:satisfy", "transition:operator-override"],
});
const validation = _internalCreateTrustedValidationContext({
	contract,
	principals: [
		{
			principalId: "internal-runner",
			principalKind: "automated-review",
			capabilities: ["evidence:test-result", "transition:satisfy", "transition:operator-override"],
		},
		{ principalId: "untrusted", principalKind: "agent", capabilities: [] },
	],
	sourceGrants: [{
		sourceId: "internal-test-runner",
		principalId: "internal-runner",
		principalKind: "automated-review",
		capability: "evidence:test-result",
		allowedEvidenceTypes: ["test-result"],
		allowedCollectorClasses: ["test-runner"],
		allowedRequirementIds: ["REQ-001"],
		allowedCriterionIds: ["AC-001"],
	}],
});
const initialized = initializeRequirementLedger(contract);
if (!initialized.ok || !initialized.value) throw new Error(String(initialized.error));
const implemented = applyRequirementTransition(contract, initialized.value, {
	transitionId: "TX-CLI-T04-IMPLEMENTED",
	expectedRevision: 0,
	requirementId: "REQ-001",
	toStatus: "IMPLEMENTED_UNVERIFIED",
	reportedActorType: "agent",
	reason: "Implementation complete",
	evidenceIds: [],
}, getUntrustedContext());
if (!implemented.ok || !implemented.value) throw new Error(String(implemented.error));
const evidenced = addLedgerEvidence(contract, implemented.value, {
	expectedRevision: 1,
	evidence: {
		id: "EV-CLI-T04",
		type: "test-result",
		requirementIds: ["REQ-001"],
		criterionIds: ["AC-001"],
		status: "pass",
		source: "internal-test-runner",
		summary: "Internal authoritative setup",
		reportedCollectorType: "test-runner",
		reportedAuthority: true,
	},
}, mutation, validation);
if (!evidenced.ok || !evidenced.value) throw new Error(String(evidenced.error));
const satisfied = applyRequirementTransition(contract, evidenced.value, {
	transitionId: "TX-CLI-T04-SATISFIED",
	expectedRevision: 2,
	requirementId: "REQ-001",
	toStatus: "SATISFIED",
	reportedActorType: "automated-review",
	reason: "Authoritative evidence verified",
	evidenceIds: ["EV-CLI-T04"],
}, mutation, validation);
if (!satisfied.ok || !satisfied.value) throw new Error(String(satisfied.error));
writeFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify(satisfied.value, null, 2), "utf-8");
`;
	writeFileSync(scriptPath, script, "utf-8");
	const result = spawnSync("npx", ["tsx", scriptPath], {
		cwd: REPO_ROOT,
		timeout: 30_000,
		encoding: "utf-8",
	});
	expect(result.status, result.stderr).toBe(0);
	const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8")) as RequirementLedgerV1;
	expect(ledger.revision).toBe(3);
	expect(ledger.requirements[0]?.status).toBe("SATISFIED");
	return ledgerPath;
}

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

	it("CLI-TRUST-06 serialized fake TrustedLedgerMutationContext is rejected", () => {
		expectRejectedWithoutMutation(
			{
				...baseEvidence("EV-CLI-TRUST-06"),
				TrustedLedgerMutationContext: { principalId: "operator", capabilities: ["evidence:test-result"] },
			},
			"TRUSTED_CONTEXT_REQUIRED",
		);
	});

	it("CLI-TRUST-07 principal, capability, and source-grant registry injection is rejected", () => {
		expectRejectedWithoutMutation(
			{
				...baseEvidence("EV-CLI-TRUST-07A"),
				principals: [{ principalId: "operator", principalKind: "operator" }],
			},
			"TRUSTED_CONTEXT_REQUIRED",
		);
		expectRejectedWithoutMutation(
			{
				...baseEvidence("EV-CLI-TRUST-07B"),
				capabilities: ["evidence:test-result"],
			},
			"TRUSTED_CONTEXT_REQUIRED",
		);
		expectRejectedWithoutMutation(
			{
				...baseEvidence("EV-CLI-TRUST-07C"),
				sourceGrants: [{ sourceId: "forged" }],
			},
			"TRUSTED_CONTEXT_REQUIRED",
		);
	});

	it("CLI-TRUST-08 boundContractDigest and trusted true are rejected", () => {
		expectRejectedWithoutMutation(
			{ ...baseEvidence("EV-CLI-TRUST-08A"), boundContractDigest: "0".repeat(64) },
			"UNTRUSTED_AUTHORITY_CLAIM",
		);
		expectRejectedWithoutMutation(
			{ ...baseEvidence("EV-CLI-TRUST-08B"), trusted: true },
			"UNTRUSTED_AUTHORITY_CLAIM",
		);
	});

	it("CLI-T04 real CLI rejects transition out of SATISFIED without mutation", () => {
		const directory = mkdtempSync(resolve(tmpdir(), "lh-cli-t04-"));
		try {
			const ledgerPath = createSatisfiedLedger(directory);
			const before = snapshotLedger(ledgerPath);
			const result = runCli([
				"benchmark",
				"long-horizon",
				"ledger",
				"transition",
				"--contract",
				CONTRACT_PATH,
				"--ledger",
				ledgerPath,
				"--expected-revision",
				String(before.revision),
				"--requirement-id",
				"REQ-001",
				"--to-status",
				"IN_PROGRESS",
				"--actor-type",
				"operator",
				"--reason",
				"Attempt generic CLI regression",
				"--transition-id",
				"TX-CLI-T04-REGRESSION",
				"--format",
				"json",
				"--output",
				ledgerPath,
			]);
			const after = snapshotLedger(ledgerPath);

			expect(result.command).toContain("npx tsx packages/coding-agent/src/cli.ts");
			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/TRUSTED_(?:VALIDATION_)?CONTEXT_REQUIRED/);
			expect(after.bytes.equals(before.bytes)).toBe(true);
			expect(after.sha256).toBe(before.sha256);
			expect(after.revision).toBe(before.revision);
			expect(after.evidenceCount).toBe(before.evidenceCount);
			expect(after.temporarySiblings).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
