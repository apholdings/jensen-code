import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

const FIXTURES = resolve(__dirname, "..", "..", "src", "core", "long-horizon", "fixtures");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(data: string): string {
	return createHash("sha256").update(data, "utf-8").digest("hex");
}

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
				// Unset all provider API keys — matching jensen-test.sh --no-env
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
		},
	);
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status,
	};
}

function createTempDir(): string {
	return mkdtempSync(resolve(tmpdir(), "lh2-cli-rev-"));
}

function cleanupTempDir(dir: string): void {
	try {
		rmdirSync(dir, { recursive: true });
	} catch {}
}

/** Check that no tmp sibling file was left behind. */
function countTempSiblings(dirPath: string, execPath: string): number {
	const entries = readdirSync(dirPath);
	const stem = resolve(execPath);
	let count = 0;
	for (const entry of entries) {
		const full = resolve(dirPath, entry);
		if (full !== stem && entry.startsWith(`${basename(execPath)}.`) && entry.includes(".tmp.")) {
			count++;
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Bootstrap: create a valid execution at revision 1 (state: EXECUTION)
// ---------------------------------------------------------------------------

function bootstrapExecutionAtRevision1(dir: string): { execPath: string; content: string; history: unknown[] } {
	const contractPath = resolve(FIXTURES, "M01-contract.json");
	const execPath = resolve(dir, "exec.json");

	// Init
	let r = runCli([
		"benchmark",
		"long-horizon",
		"execution",
		"init",
		"--contract",
		contractPath,
		"--execution-id",
		"rev-test-1",
		"--format",
		"json",
		"--output",
		execPath,
	]);
	if (r.status !== 0) {
		throw new Error(`init failed: exit ${r.status}, stderr: ${r.stderr}`);
	}

	// START_EXECUTION: revision 0 → revision 1
	r = runCli([
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
	if (r.status !== 0) {
		throw new Error(`START_EXECUTION failed: exit ${r.status}, stderr: ${r.stderr}`);
	}

	const content = readFileSync(execPath, "utf-8");
	const record = JSON.parse(content);

	if (record.state !== "EXECUTION" || record.revision !== 1) {
		throw new Error(`Expected EXECUTION@1, got ${record.state}@${record.revision}`);
	}

	return { execPath, content, history: [...record.transitions] };
}

// =============================================================================
// ESM-15 / ESM-27: Malformed --expected-revision matrix
// =============================================================================

export const malformedRevisionCases: ReadonlyArray<{
	readonly label: string;
	readonly value: string;
}> = [
	{ label: "decimal 1.0", value: "1.0" },
	{ label: "decimal 1.5", value: "1.5" },
	{ label: "scientific 1e0", value: "1e0" },
	{ label: "scientific 1E0", value: "1E0" },
	{ label: "leading plus +1", value: "+1" },
	{ label: "leading zero 01", value: "01" },
	{ label: "negative -1", value: "-1" },
	{ label: "above MAX_SAFE_INTEGER 9007199254740992", value: "9007199254740992" },
	{ label: "NaN", value: "NaN" },
	{ label: "Infinity", value: "Infinity" },
];

export function registerMalformedRevisionTests(values: typeof malformedRevisionCases): void {
	describe("ESM-15 / ESM-27 (expanded): malformed --expected-revision", () => {
		for (const { label, value } of values) {
			it(`rejects "${label}"`, () => {
				const dir = createTempDir();
				try {
					const { execPath, content, history } = bootstrapExecutionAtRevision1(dir);
					const contractPath = resolve(FIXTURES, "M01-contract.json");
					const beforeSha = sha256(content);

					const result = runCli([
						"benchmark",
						"long-horizon",
						"execution",
						"transition",
						"--contract",
						contractPath,
						"--execution",
						execPath,
						"--transition-id",
						`t-bad-${label.replace(/[^a-zA-Z0-9]/g, "-")}`,
						"--expected-revision",
						value,
						"--kind",
						"RETURN_TO_EXECUTION",
						"--format",
						"json",
						"--output",
						execPath,
					]);

					// Prove exit 1
					expect(result.status, `expected exit 1 for "${value}"`).toBe(1);

					// Prove invalid-expected-revision error
					expect(result.stderr, `expected invalid-expected-revision for "${value}"`).toContain(
						"invalid-expected-revision",
					);

					// Prove output bytes unchanged
					const afterContent = readFileSync(execPath, "utf-8");
					expect(afterContent, `output bytes unchanged for "${value}"`).toBe(content);

					// Prove SHA-256 unchanged
					const afterSha = sha256(afterContent);
					expect(afterSha, `SHA-256 unchanged for "${value}"`).toBe(beforeSha);

					// Prove revision unchanged
					const afterRecord = JSON.parse(afterContent);
					expect(afterRecord.revision, `revision unchanged for "${value}"`).toBe(1);

					// Prove history unchanged
					expect(afterRecord.transitions, `history unchanged for "${value}"`).toEqual(history);

					// Prove no temporary sibling
					expect(countTempSiblings(dir, execPath), `no temp sibling for "${value}"`).toBe(0);

					// Prove no provider initialization
					expect(result.stderr, `no provider init for "${value}"`).not.toContain("provider");
					expect(result.stdout, `no provider output for "${value}"`).toBe("");
				} finally {
					cleanupTempDir(dir);
				}
			});
		}
	});
}

// =============================================================================
// Parser ordering: malformed revision before ENOENT
// =============================================================================

export function registerRevisionParserOrderingTests(): void {
	describe("ESM-15: parser ordering — revision error before ENOENT", () => {
		it("malformed revision 1.5 errors before missing contract", () => {
			const dir = createTempDir();
			try {
				const execPath = resolve(dir, "exec.json");
				const nonexistentContract = resolve(dir, "does-not-exist.json");
				const nonexistentExec = resolve(dir, "also-missing.json");

				const result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					nonexistentContract,
					"--execution",
					nonexistentExec,
					"--transition-id",
					"t-parser-ord",
					"--expected-revision",
					"1.5",
					"--kind",
					"START_EXECUTION",
					"--format",
					"json",
					"--output",
					execPath,
				]);

				// Malformed revision is caught before even trying to read files
				expect(result.status).toBe(1);
				expect(result.stderr).toContain("invalid-expected-revision");
				expect(result.stderr).not.toContain("ENOENT");
				expect(result.stderr).not.toContain("not found");
			} finally {
				cleanupTempDir(dir);
			}
		});

		it("malformed revision 1.5 errors before missing execution", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const execPath = resolve(dir, "exec.json");
				const nonexistentExec = resolve(dir, "also-missing.json");

				const result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"transition",
					"--contract",
					contractPath,
					"--execution",
					nonexistentExec,
					"--transition-id",
					"t-parser-ord-2",
					"--expected-revision",
					"1.5",
					"--kind",
					"START_EXECUTION",
					"--format",
					"json",
					"--output",
					execPath,
				]);

				// Malformed revision caught before ENOENT for execution file
				expect(result.status).toBe(1);
				expect(result.stderr).toContain("invalid-expected-revision");
				expect(result.stderr).not.toContain("ENOENT");
				expect(result.stderr).not.toContain("not found");
			} finally {
				cleanupTempDir(dir);
			}
		});
	});
}

// =============================================================================
// Valid revision controls: revision 0 succeeds, revision 1 succeeds
// =============================================================================

export function registerValidRevisionControlTests(): void {
	describe("ESM-15 / ESM-27: valid --expected-revision controls", () => {
		it("--expected-revision 0 succeeds at state PLANNING", () => {
			const dir = createTempDir();
			try {
				const contractPath = resolve(FIXTURES, "M01-contract.json");
				const execPath = resolve(dir, "exec.json");

				// Init (PLANNING, revision 0)
				let result = runCli([
					"benchmark",
					"long-horizon",
					"execution",
					"init",
					"--contract",
					contractPath,
					"--execution-id",
					"rev-ctrl-1",
					"--format",
					"json",
					"--output",
					execPath,
				]);
				expect(result.status, "init succeeded").toBe(0);

				const initContent = readFileSync(execPath, "utf-8");
				const initRecord = JSON.parse(initContent);
				expect(initRecord.revision).toBe(0);

				// START_EXECUTION with --expected-revision 0
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
				expect(result.status, "transition with rev 0 succeeded").toBe(0);

				const txContent = readFileSync(execPath, "utf-8");
				const txRecord = JSON.parse(txContent);
				expect(txRecord.state).toBe("EXECUTION");
				expect(txRecord.revision).toBe(1);
				expect(txRecord.transitions.length).toBe(1);

				// No provider initialization
				expect(result.stderr, "no provider init").not.toContain("provider");
			} finally {
				cleanupTempDir(dir);
			}
		});

		it("--expected-revision 1 succeeds at state EXECUTION", () => {
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
					"rev-ctrl-2",
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

				const content = readFileSync(execPath, "utf-8");
				const record = JSON.parse(content);
				expect(record.revision).toBe(1);

				// REQUEST_VERIFICATION with --expected-revision 1
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
				expect(result.status, "transition with rev 1 succeeded").toBe(0);

				const txContent = readFileSync(execPath, "utf-8");
				const txRecord = JSON.parse(txContent);
				expect(txRecord.state).toBe("VERIFICATION");
				expect(txRecord.revision).toBe(2);
				expect(txRecord.transitions.length).toBe(2);

				// No provider initialization
				expect(result.stderr, "no provider init").not.toContain("provider");
			} finally {
				cleanupTempDir(dir);
			}
		});
	});
}
