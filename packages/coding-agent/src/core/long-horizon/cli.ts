/**
 * CLI handler for "jensen benchmark long-horizon" commands.
 *
 * Extends the benchmark CLI with mission contract and requirement ledger
 * management commands. All commands route before model selection and
 * provider loading.
 *
 * Trust Model (LH-1 hardened):
 *   - The generic CLI uses the UNTRUSTED context.
 *   - Payload role labels (--actor-type, --collector-type, reportedAuthority)
 *     are descriptive only — they NEVER grant privilege.
 *   - The generic CLI REJECTS privileged operations:
 *       SATISFIED transition → exit 1 TRUSTED_CONTEXT_REQUIRED
 *       Runtime NOT_APPLICABLE → exit 1 TRUSTED_CONTEXT_REQUIRED
 *       Authoritative evidence insertion → exit 1 UNTRUSTED_AUTHORITY_CLAIM
 *   - Trusted satisfaction is unavailable through the generic CLI.
 */

import chalk from "chalk";
import { randomBytes } from "crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { computeMissionContractDigest } from "./contract-digest.js";
import { inspectLedgerStructure } from "./ledger-summary.js";
import { validateMissionContract } from "./mission-contract-schema.js";
import {
	addLedgerEvidence,
	applyRequirementTransition,
	initializeRequirementLedger,
	inspectRequirementLedgerStructure,
} from "./requirement-ledger.js";
import { getUntrustedContext } from "./trusted-context.js";
import type {
	LedgerEvidenceRequest,
	MissionContractV1,
	RequirementLedgerV1,
	StructuralLedgerInspection,
	TransitionRequest,
	ValidationResult,
} from "./types.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

type GenericCliEvidence = LedgerEvidenceRequest["evidence"];

export type GenericCliEvidencePayloadValidation =
	| { readonly ok: true; readonly kind: "ordinary-agent-claim"; readonly evidence: GenericCliEvidence }
	| {
			readonly ok: false;
			readonly kind: "attempted-authority-claim";
			readonly code: "UNTRUSTED_AUTHORITY_CLAIM";
			readonly field: string;
	  }
	| {
			readonly ok: false;
			readonly kind: "malformed-evidence";
			readonly code: "MALFORMED_EVIDENCE";
			readonly field: string;
	  }
	| {
			readonly ok: false;
			readonly kind: "trusted-context-unavailable";
			readonly code: "TRUSTED_CONTEXT_REQUIRED";
			readonly field: string;
	  };

const SERIALIZED_TRUST_CONTEXT_KEYS: ReadonlySet<string> = new Set([
	"trustedvalidationcontext",
	"validationcontext",
	"trustedledgermutationcontext",
	"ledgermutationcontext",
	"mutationcontext",
	"principal",
	"principalid",
	"principalkind",
	"principals",
	"principalregistry",
	"capability",
	"capabilities",
	"capabilityregistry",
	"sourcegrant",
	"sourcegrants",
	"sourcegrantregistry",
	"verifiedprincipalid",
	"verifiedprincipalkind",
	"verifiedcapability",
]);

const AUTHORITY_KEYS: ReadonlySet<string> = new Set([
	"authority",
	"requestedauthority",
	"effectiveauthority",
	"authorityclassification",
	"requestedauthorityclassification",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function findSerializedTrustContext(value: unknown, path = "evidence"): string | undefined {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const found = findSerializedTrustContext(value[index], `${path}[${index}]`);
			if (found) return found;
		}
		return undefined;
	}
	if (!isRecord(value)) return undefined;

	for (const [key, nestedValue] of Object.entries(value)) {
		const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
		const nestedPath = `${path}.${key}`;
		if (SERIALIZED_TRUST_CONTEXT_KEYS.has(normalizedKey)) return nestedPath;
		const found = findSerializedTrustContext(nestedValue, nestedPath);
		if (found) return found;
	}
	return undefined;
}

function findAuthorityClaim(value: unknown, path = "evidence"): string | undefined {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const found = findAuthorityClaim(value[index], `${path}[${index}]`);
			if (found) return found;
		}
		return undefined;
	}
	if (!isRecord(value)) return undefined;

	for (const [key, nestedValue] of Object.entries(value)) {
		const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
		const nestedPath = `${path}.${key}`;
		if (normalizedKey === "reportedauthority" && nestedValue === true) return nestedPath;
		if (AUTHORITY_KEYS.has(normalizedKey) && nestedValue !== "agent-claim") return nestedPath;
		if (normalizedKey === "trusted" && nestedValue === true) return nestedPath;
		if (normalizedKey === "boundcontractdigest") return nestedPath;
		if (
			(normalizedKey === "collectortype" ||
				normalizedKey === "reportedcollectortype" ||
				normalizedKey === "collectorclass") &&
			typeof nestedValue === "string" &&
			nestedValue.toLowerCase() === "trusted-collector"
		) {
			return nestedPath;
		}
		if (
			(normalizedKey === "source" || normalizedKey === "sourceid") &&
			typeof nestedValue === "string" &&
			/(?:^|[^a-z])(trusted|authoritative)(?:[^a-z]|$)/i.test(nestedValue)
		) {
			return nestedPath;
		}
		const found = findAuthorityClaim(nestedValue, nestedPath);
		if (found) return found;
	}
	return undefined;
}

/** Validate and normalize evidence accepted by the generic, untrusted CLI. */
export function validateGenericCliEvidencePayload(payload: unknown): GenericCliEvidencePayloadValidation {
	if (!isRecord(payload)) {
		return { ok: false, kind: "malformed-evidence", code: "MALFORMED_EVIDENCE", field: "evidence" };
	}

	const serializedContextField = findSerializedTrustContext(payload);
	if (serializedContextField) {
		return {
			ok: false,
			kind: "trusted-context-unavailable",
			code: "TRUSTED_CONTEXT_REQUIRED",
			field: serializedContextField,
		};
	}

	const authorityField = findAuthorityClaim(payload);
	if (authorityField) {
		return {
			ok: false,
			kind: "attempted-authority-claim",
			code: "UNTRUSTED_AUTHORITY_CLAIM",
			field: authorityField,
		};
	}

	if (typeof payload.id !== "string" || payload.id.trim().length === 0) {
		return { ok: false, kind: "malformed-evidence", code: "MALFORMED_EVIDENCE", field: "evidence.id" };
	}
	if (typeof payload.type !== "string" || payload.type.trim().length === 0) {
		return { ok: false, kind: "malformed-evidence", code: "MALFORMED_EVIDENCE", field: "evidence.type" };
	}
	if (!isStringArray(payload.requirementIds)) {
		return {
			ok: false,
			kind: "malformed-evidence",
			code: "MALFORMED_EVIDENCE",
			field: "evidence.requirementIds",
		};
	}
	if (payload.criterionIds !== undefined && !isStringArray(payload.criterionIds)) {
		return {
			ok: false,
			kind: "malformed-evidence",
			code: "MALFORMED_EVIDENCE",
			field: "evidence.criterionIds",
		};
	}
	if (payload.status !== undefined && !["pass", "fail", "unknown"].includes(String(payload.status))) {
		return { ok: false, kind: "malformed-evidence", code: "MALFORMED_EVIDENCE", field: "evidence.status" };
	}
	for (const field of ["source", "summary", "digest", "claimText"] as const) {
		if (payload[field] !== undefined && typeof payload[field] !== "string") {
			return { ok: false, kind: "malformed-evidence", code: "MALFORMED_EVIDENCE", field: `evidence.${field}` };
		}
	}
	if (payload.collectorType !== undefined && typeof payload.collectorType !== "string") {
		return {
			ok: false,
			kind: "malformed-evidence",
			code: "MALFORMED_EVIDENCE",
			field: "evidence.collectorType",
		};
	}
	if (payload.reportedAuthority !== undefined && typeof payload.reportedAuthority !== "boolean") {
		return {
			ok: false,
			kind: "malformed-evidence",
			code: "MALFORMED_EVIDENCE",
			field: "evidence.reportedAuthority",
		};
	}
	if (payload.metadata !== undefined && !isRecord(payload.metadata)) {
		return { ok: false, kind: "malformed-evidence", code: "MALFORMED_EVIDENCE", field: "evidence.metadata" };
	}

	return {
		ok: true,
		kind: "ordinary-agent-claim",
		evidence: {
			id: payload.id,
			type: payload.type,
			requirementIds: [...payload.requirementIds],
			criterionIds: payload.criterionIds === undefined ? [] : [...payload.criterionIds],
			status: (payload.status as "pass" | "fail" | "unknown" | undefined) ?? "unknown",
			source: (payload.source as string | undefined) ?? "",
			summary: (payload.summary as string | undefined) ?? "",
			digest: payload.digest as string | undefined,
			claimText: payload.claimText as string | undefined,
			reportedCollectorType:
				(payload.collectorType as GenericCliEvidence["reportedCollectorType"] | undefined) ?? "agent",
			reportedAuthority: false,
			metadata: payload.metadata,
		},
	};
}

// =============================================================================
// Entry point — called from benchmark handler
// =============================================================================

export interface LongHorizonCommandOptions {
	help?: boolean;
	format?: "text" | "json";
	output?: string;
	command?: string;

	// For ledger operations
	contract?: string;
	ledger?: string;
	requirementId?: string;
	toStatus?: string;
	expectedRevision?: number;
	actorType?: string;
	reason?: string;
	evidenceIds?: string[];
	blockerReference?: string;
	evidenceInput?: string;
	transitionId?: string;
}

export async function handleLongHorizonCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "benchmark") return false;
	if (args[1] !== "long-horizon") return false;

	const options = parseLongHorizonArgs(args);

	if (options.help) {
		printLongHorizonHelp();
		return true;
	}

	if (!options.command) {
		// No long-horizon subcommand matched — let the existing evaluate handler take over
		return false;
	}

	try {
		switch (options.command) {
			case "mission-validate":
				return await handleMissionValidate(options);
			case "mission-digest":
				return await handleMissionDigest(options);
			case "ledger-init":
				return await handleLedgerInit(options);
			case "ledger-validate":
				return await handleLedgerValidate(options);
			case "ledger-add-evidence":
				return await handleLedgerAddEvidence(options);
			case "ledger-transition":
				return await handleLedgerTransition(options);
			case "ledger-inspect":
				return await handleLedgerInspect(options);
			default:
				return false; // Let the existing benchmark handler take over
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Unknown error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}

// =============================================================================
// Argument parsing
// =============================================================================

function parseLongHorizonArgs(args: string[]): LongHorizonCommandOptions {
	const options: LongHorizonCommandOptions = {};
	let i = 2; // Skip "benchmark" and "long-horizon"

	while (i < args.length) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			options.help = true;
			i++;
			continue;
		}

		if (arg === "--format" && i + 1 < args.length) {
			const fmt = args[++i];
			if (fmt === "text" || fmt === "json") {
				options.format = fmt;
			} else {
				console.error(chalk.red(`Unknown format: ${fmt}`));
				process.exitCode = 1;
			}
			i++;
			continue;
		}

		if (arg === "--output" && i + 1 < args.length) {
			options.output = args[++i];
			i++;
			continue;
		}

		if (arg === "--contract" && i + 1 < args.length) {
			options.contract = args[++i];
			i++;
			continue;
		}

		if (arg === "--ledger" && i + 1 < args.length) {
			options.ledger = args[++i];
			i++;
			continue;
		}

		if (arg === "--requirement-id" && i + 1 < args.length) {
			options.requirementId = args[++i];
			i++;
			continue;
		}

		if (arg === "--to-status" && i + 1 < args.length) {
			options.toStatus = args[++i];
			i++;
			continue;
		}

		if (arg === "--expected-revision" && i + 1 < args.length) {
			const val = parseInt(args[++i], 10);
			if (!Number.isNaN(val)) options.expectedRevision = val;
			i++;
			continue;
		}

		if (arg === "--actor-type" && i + 1 < args.length) {
			options.actorType = args[++i];
			i++;
			continue;
		}

		if (arg === "--reason" && i + 1 < args.length) {
			options.reason = args[++i];
			i++;
			continue;
		}

		if (arg === "--evidence-ids" && i + 1 < args.length) {
			options.evidenceIds = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			i++;
			continue;
		}

		if (arg === "--blocker-reference" && i + 1 < args.length) {
			options.blockerReference = args[++i];
			i++;
			continue;
		}

		if (arg === "--evidence-input" && i + 1 < args.length) {
			options.evidenceInput = args[++i];
			i++;
			continue;
		}

		if (arg === "--transition-id" && i + 1 < args.length) {
			options.transitionId = args[++i];
			i++;
			continue;
		}

		// Subcommand detection
		if (arg === "mission") {
			if (i + 1 < args.length && args[i + 1] === "validate") {
				options.command = "mission-validate";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "digest") {
				options.command = "mission-digest";
				i += 2;
				continue;
			}
		}

		if (arg === "ledger") {
			if (i + 1 < args.length && args[i + 1] === "init") {
				options.command = "ledger-init";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "validate") {
				options.command = "ledger-validate";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "add-evidence") {
				options.command = "ledger-add-evidence";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "transition") {
				options.command = "ledger-transition";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "inspect") {
				options.command = "ledger-inspect";
				i += 2;
				continue;
			}
		}

		// "evaluate" subcommand — let existing handler take over
		if (arg === "evaluate") {
			return options; // No command set, fall through to existing handler
		}

		// Unknown
		i++;
	}

	return options;
}

// =============================================================================
// Help
// =============================================================================

function printLongHorizonHelp(): void {
	console.log(`${chalk.bold("Usage:")} jensen benchmark long-horizon <command> [options]

${chalk.bold("Mission Contract Commands:")}
  mission validate     Validate a mission contract JSON file
  mission digest       Compute the deterministic SHA-256 digest of a mission contract

${chalk.bold("Requirement Ledger Commands:")}
  ledger init          Initialize a requirement ledger from a mission contract
  ledger validate      Validate a requirement ledger against its contract
  ledger add-evidence  Add an evidence record to the ledger (append-only)
  ledger transition    Apply a state transition to a requirement
  ledger inspect       Display a summary of the ledger

${chalk.bold("Common Options:")}
  --contract <path>           Path to mission contract JSON file
  --ledger <path>             Path to requirement ledger JSON file
  --format <text|json>        Output format (default: text)
  --output <path>             Write output to file
  --expected-revision <num>   Expected ledger revision (for mutation commands)
  --requirement-id <id>       Requirement ID to operate on
  --to-status <status>        Target status for transition
  --actor-type <type>         Descriptive actor type (agent, etc.) — NOT authorization
  --reason <text>             Reason for the operation
  --evidence-ids <id1,id2>    Comma-separated evidence IDs
  --blocker-reference <text>  Blocker reference for BLOCKED transitions
  --evidence-input <path>     Path to evidence JSON for add-evidence

${chalk.yellow.bold("Trust Model:")}
  The generic CLI is UNTRUSTED. Payload role labels are descriptive only.
  SATISFIED and runtime NOT_APPLICABLE require a trusted context (not available via CLI).
  Unknown semantic fields in contract JSON are rejected.

${chalk.bold("Examples:")}
  jensen benchmark long-horizon mission validate --contract contract.json
  jensen benchmark long-horizon mission digest --contract contract.json
  jensen benchmark long-horizon ledger init --contract contract.json --output ledger.json
  jensen benchmark long-horizon ledger validate --contract contract.json --ledger ledger.json
  jensen benchmark long-horizon ledger transition --contract contract.json --ledger ledger.json --expected-revision 0 --requirement-id REQ-001 --to-status PENDING --reason "Starting work"

${chalk.bold("Exit Codes:")}
  0   Valid operation completed
  1   Invalid contract, ledger, rejected transition, stale revision, read error, parse error, trust error, output-write error, unknown command
`);
}

// =============================================================================
// Command: mission validate
// =============================================================================

async function handleMissionValidate(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.contract) {
		console.error(chalk.red("Error: --contract is required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFile(options.contract);
	if (!contract) return true;

	const result = validateMissionContract(contract);
	const format = options.format ?? "text";

	if (format === "json") {
		const output = JSON.stringify(result, null, 2);
		writeOutput(output, options);
	} else {
		printTextValidationResult(result);
	}

	if (!result.valid) {
		process.exitCode = 1;
	}

	return true;
}

// =============================================================================
// Command: mission digest
// =============================================================================

async function handleMissionDigest(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.contract) {
		console.error(chalk.red("Error: --contract is required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;

	const digest = computeMissionContractDigest(contract);
	const format = options.format ?? "text";

	if (format === "json") {
		const output = JSON.stringify({ digest }, null, 2);
		writeOutput(output, options);
	} else {
		console.log(digest);
	}

	return true;
}

// =============================================================================
// Command: ledger init
// =============================================================================

async function handleLedgerInit(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.contract) {
		console.error(chalk.red("Error: --contract is required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;

	const result = initializeRequirementLedger(contract);
	if (!result.ok) {
		console.error(chalk.red(`Error: ${result.error}`));
		process.exitCode = 1;
		return true;
	}

	const _format = options.format ?? "text";
	writeLedgerOutput(result.value!, options);

	return true;
}

// =============================================================================
// Command: ledger validate
// =============================================================================

async function handleLedgerValidate(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.contract) {
		console.error(chalk.red("Error: --contract is required"));
		process.exitCode = 1;
		return true;
	}
	if (!options.ledger) {
		console.error(chalk.red("Error: --ledger is required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;

	const ledger = readLedgerFile(options.ledger);
	if (!ledger) return true;

	// Route through structural inspection only.
	// The generic CLI cannot perform authoritative validation.
	// Trusted provenance is NOT verified here.
	const inspection = inspectRequirementLedgerStructure(contract, ledger);
	const format = options.format ?? "text";

	if (format === "json") {
		const output = JSON.stringify(
			{
				structurallyValid: inspection.structurallyValid,
				trustVerified: false,
				completionCandidate: "unavailable",
				error: inspection.structurallyValid ? undefined : "Ledger structure is invalid",
			},
			null,
			2,
		);
		writeOutput(output, options);
	} else {
		if (inspection.structurallyValid) {
			console.log(chalk.green("Ledger structure is valid."));
			console.log(chalk.yellow("Trusted provenance was not verified."));
		} else {
			console.log(chalk.red("Ledger structure is invalid."));
		}
	}

	if (!inspection.structurallyValid) process.exitCode = 1;
	return true;
}

// =============================================================================
// Command: ledger add-evidence
// =============================================================================

async function handleLedgerAddEvidence(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.contract || !options.ledger || !options.evidenceInput) {
		console.error(chalk.red("Error: --contract, --ledger, and --evidence-input are required"));
		process.exitCode = 1;
		return true;
	}
	if (options.expectedRevision === undefined) {
		console.error(chalk.red("Error: --expected-revision is required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;

	const ledger = readLedgerFile(options.ledger);
	if (!ledger) return true;

	const evidenceRaw = readFileContent(options.evidenceInput);
	if (!evidenceRaw) return true;

	let evidenceData: unknown;
	try {
		evidenceData = JSON.parse(evidenceRaw);
	} catch {
		console.error(chalk.red("Error parsing evidence input"));
		process.exitCode = 1;
		return true;
	}

	const payloadValidation = validateGenericCliEvidencePayload(evidenceData);
	if (!payloadValidation.ok) {
		console.error(chalk.red(`Error: ${payloadValidation.code}: ${payloadValidation.field}`));
		process.exitCode = 1;
		return true;
	}

	// Use UNTRUSTED context — the generic CLI never provides trusted capabilities
	const untrustedCtx = getUntrustedContext();

	const request: LedgerEvidenceRequest = {
		expectedRevision: options.expectedRevision,
		evidence: payloadValidation.evidence,
	};

	const result = addLedgerEvidence(contract, ledger, request, untrustedCtx);
	if (!result.ok) {
		console.error(chalk.red(`Error: ${result.code ? `${result.code}: ` : ""}${result.error}`));
		process.exitCode = 1;
		return true;
	}

	writeLedgerOutput(result.value!, options);
	return true;
}

// =============================================================================
// Command: ledger transition
// =============================================================================

async function handleLedgerTransition(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.contract || !options.ledger || !options.requirementId || !options.toStatus || !options.transitionId) {
		console.error(
			chalk.red("Error: --contract, --ledger, --requirement-id, --to-status, and --transition-id are required"),
		);
		process.exitCode = 1;
		return true;
	}
	if (options.expectedRevision === undefined) {
		console.error(chalk.red("Error: --expected-revision is required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;

	const ledger = readLedgerFile(options.ledger);
	if (!ledger) return true;

	const validStatuses = new Set([
		"UNASSESSED",
		"PENDING",
		"IN_PROGRESS",
		"IMPLEMENTED_UNVERIFIED",
		"SATISFIED",
		"BLOCKED",
		"NOT_APPLICABLE",
		"FAILED",
	]);
	if (!validStatuses.has(options.toStatus)) {
		console.error(chalk.red(`Error: invalid to-status: ${options.toStatus}`));
		process.exitCode = 1;
		return true;
	}

	// Warning: the CLI is untrusted. SATISFIED and runtime NOT_APPLICABLE will be rejected.
	if (options.toStatus === "SATISFIED" || options.toStatus === "NOT_APPLICABLE") {
		// Check if this is a runtime NOT_APPLICABLE (not initial contract)
		const isRuntimeNa = options.toStatus === "NOT_APPLICABLE";
		if (options.toStatus === "SATISFIED" || isRuntimeNa) {
			// Let the core API reject it with a proper error
		}
	}

	// Use UNTRUSTED context — the generic CLI never provides trusted capabilities
	const untrustedCtx = getUntrustedContext();

	const request: TransitionRequest = {
		transitionId: options.transitionId,
		expectedRevision: options.expectedRevision,
		requirementId: options.requirementId,
		toStatus: options.toStatus as TransitionRequest["toStatus"],
		// Descriptive only — NOT authorization
		reportedActorType: options.actorType ?? "agent",
		reason: options.reason ?? "",
		evidenceIds: options.evidenceIds ?? [],
		blockerReference: options.blockerReference,
	};

	const result = applyRequirementTransition(contract, ledger, request, untrustedCtx);
	if (!result.ok) {
		console.error(chalk.red(`Error: ${result.code ? `${result.code}: ` : ""}${result.error}`));
		process.exitCode = 1;
		return true;
	}

	writeLedgerOutput(result.value!, options);
	return true;
}

// =============================================================================
// Command: ledger inspect
// =============================================================================

async function handleLedgerInspect(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.contract || !options.ledger) {
		console.error(chalk.red("Error: --contract and --ledger are required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;

	const ledger = readLedgerFile(options.ledger);
	if (!ledger) return true;

	const summary = inspectLedgerStructure(contract, ledger);
	const format = options.format ?? "text";

	if (format === "json") {
		const output = JSON.stringify(summary, null, 2);
		writeOutput(output, options);
	} else {
		printTextStructuralInspection(summary);
	}

	return true;
}

// =============================================================================
// File I/O utilities
// =============================================================================

function readFileContent(path: string): string | null {
	try {
		const raw = readFileSync(path, "utf-8");
		if (Buffer.byteLength(raw, "utf-8") > MAX_FILE_SIZE) {
			console.error(chalk.red("Error: file exceeds 10MB limit"));
			process.exitCode = 1;
			return null;
		}
		return raw;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Unknown error";
		console.error(chalk.red(`Error reading file ${path}: ${message}`));
		process.exitCode = 1;
		return null;
	}
}

function readContractFile(path: string): unknown | null {
	const raw = readFileContent(path);
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		console.error(chalk.red("Error parsing contract JSON"));
		process.exitCode = 1;
		return null;
	}
}

function readContractFileAndParse(path: string): MissionContractV1 | null {
	const raw = readFileContent(path);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as MissionContractV1;
	} catch {
		console.error(chalk.red("Error parsing contract JSON"));
		process.exitCode = 1;
		return null;
	}
}

function readLedgerFile(path: string): RequirementLedgerV1 | null {
	const raw = readFileContent(path);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as RequirementLedgerV1;
	} catch {
		console.error(chalk.red("Error parsing ledger JSON"));
		process.exitCode = 1;
		return null;
	}
}

function writeOutput(data: string, options: LongHorizonCommandOptions): void {
	if (options.output) {
		writeFileAtomic(options.output, data);
	} else {
		console.log(data);
	}
}

function writeLedgerOutput(ledger: RequirementLedgerV1, options: LongHorizonCommandOptions): void {
	const format = options.format ?? "text";
	if (format === "json") {
		const output = JSON.stringify(ledger, null, 2);
		writeOutput(output, options);
	} else {
		const lines = [
			`Ledger revision: ${ledger.revision}`,
			...ledger.requirements.map((entry) => `  ${entry.requirementId}: ${entry.status}`),
		];
		const text = lines.join("\n");
		writeOutput(text, options);
	}
}

// =============================================================================
// Atomic file write
// =============================================================================

function writeFileAtomic(path: string, data: string): void {
	const outputPath = resolve(path);
	if (outputPath.includes("..")) {
		console.error(chalk.red("Error: --output path must not contain '..'"));
		process.exitCode = 1;
		return;
	}

	const dir = dirname(outputPath);
	if (!existsSync(dir)) {
		console.error(chalk.red(`Error: directory ${dir} does not exist`));
		process.exitCode = 1;
		return;
	}

	const tmpPath = `${outputPath}.tmp.${randomBytes(4).toString("hex")}`;
	try {
		writeFileSync(tmpPath, data, "utf-8");
		renameSync(tmpPath, outputPath);
	} catch (err: unknown) {
		// Clean up temp file on failure
		try {
			unlinkSync(tmpPath);
		} catch {}
		const message = err instanceof Error ? err.message : "Unknown error";
		console.error(chalk.red(`Error writing output: ${message}`));
		process.exitCode = 1;
	}
}

// =============================================================================
// Text formatting
// =============================================================================

function printTextValidationResult(result: ValidationResult): void {
	if (result.valid) {
		console.log(chalk.green("Contract is valid"));
	} else {
		console.log(chalk.red(`Contract is invalid (${result.errors.length} errors):`));
		for (const err of result.errors) {
			console.log(chalk.red(`  ${err.message}`));
		}
	}
}

function printTextStructuralInspection(summary: StructuralLedgerInspection): void {
	console.log(`${chalk.bold("Ledger Inspection (structural only)")}`);
	console.log(`${"Mission".padEnd(28)} ${summary.missionId}`);
	console.log(`${"Contract Digest".padEnd(28)} ${summary.contractDigest}`);
	console.log(`${"Ledger Revision".padEnd(28)} ${summary.ledgerRevision}`);
	console.log(`${"Total Requirements".padEnd(28)} ${summary.totalRequirements}`);
	console.log(`${"Applicable Requirements".padEnd(28)} ${summary.applicableRequirements}`);
	console.log(`${"Structurally Valid".padEnd(28)} ${summary.structurallyValid ? "Yes" : "No"}`);
	console.log(
		`${chalk.yellow("Completion Candidate".padEnd(28))} ${chalk.yellow("unavailable (trusted context required)")}`,
	);
	console.log("");

	console.log(chalk.bold("State Counts:"));
	for (const [state, count] of Object.entries(summary.stateCounts).sort(([a], [b]) => a.localeCompare(b))) {
		console.log(`  ${state.padEnd(24)} ${count}`);
	}
	console.log("");

	if (summary.blockedRequirements.length > 0) {
		console.log(chalk.yellow(`Blocked: ${summary.blockedRequirements.join(", ")}`));
	}
	if (summary.failedRequirements.length > 0) {
		console.log(chalk.red(`Failed: ${summary.failedRequirements.join(", ")}`));
	}
}
