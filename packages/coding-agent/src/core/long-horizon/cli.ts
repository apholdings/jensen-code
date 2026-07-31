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
import {
	abandonContinuation,
	type ContinuationSchedulerRecord,
	cancelContinuation,
	consumeContinuation,
	dispatchContinuation,
	initializeContinuationScheduler,
	inspectContinuationScheduler,
	scheduleContinuation,
	validateContinuationScheduler,
} from "./continuation-scheduler.js";
import { computeMissionContractDigest } from "./contract-digest.js";
import {
	applyMissionExecutionTransition,
	initializeMissionExecution,
	inspectMissionExecution,
	type MissionExecutionRecordV1,
	type MissionExecutionTransitionKind,
	validateMissionExecutionRecord,
} from "./execution-state-machine.js";
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

// =============================================================================
// Strict expectedRevision parser
// =============================================================================

/**
 * Parse a string as a canonical non-negative integer suitable for use as
 * an expectedRevision value. Rejects:
 *  - decimals: "1.0", "12.5"
 *  - scientific notation: "1e2"
 *  - leading sign: "+1", "-1"
 *  - leading zeros: "01" (except "0" itself)
 *  - NaN, Infinity, -Infinity
 *  - empty or whitespace-only strings
 *  - values exceeding Number.MAX_SAFE_INTEGER
 *
 * Accepts only: "0", "1", "12", "9007199254740991"
 */
export function parseStrictNonNegativeInteger(raw: string): number | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "string") return undefined;

	// Reject empty or whitespace-only
	if (raw.length === 0) return undefined;
	if (raw.trim().length === 0) return undefined;

	// Must match canonical decimal: one or more digits, no leading sign, no leading zero except "0" itself
	if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
		return undefined;
	}

	const value = Number(raw);

	// Number() for canonical integer strings should equal the integer value;
	// additionally require integer and safe.
	if (!Number.isSafeInteger(value)) return undefined;
	if (value < 0) return undefined;

	return value;
}

// =============================================================================
// Utilities
// =============================================================================

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

	// For execution operations
	execution?: string;
	executionId?: string;
	kind?: string;

	// For continuation scheduler operations
	scheduler?: string;
	eventId?: string;
	cycleId?: string;
	dispatchedContinuationId?: string;
	resultDigest?: string;
	expectedSchedulerRevision?: number;
	expectedExecutionRevision?: number;
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
			case "execution-init":
				return await handleExecutionInit(options);
			case "execution-inspect":
				return await handleExecutionInspect(options);
			case "execution-validate":
				return await handleExecutionValidate(options);
			case "execution-transition":
				return await handleExecutionTransition(options);
			case "continuation-init":
				return await handleContinuationInit(options);
			case "continuation-inspect":
				return await handleContinuationInspect(options);
			case "continuation-validate":
				return await handleContinuationValidate(options);
			case "continuation-schedule":
				return await handleContinuationSchedule(options);
			case "continuation-dispatch":
				return await handleContinuationDispatch(options);
			case "continuation-consume":
				return await handleContinuationConsume(options);
			case "continuation-cancel":
				return await handleContinuationCancel(options);
			case "continuation-abandon":
				return await handleContinuationAbandon(options);
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
			const raw = args[++i];
			const parsed = parseStrictNonNegativeInteger(raw);
			if (parsed === undefined) {
				// Store a sentinel so the handler can produce a typed error
				(options as LongHorizonCommandOptions & { _invalidExpectedRevision?: string })._invalidExpectedRevision =
					raw;
			} else {
				options.expectedRevision = parsed;
			}
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

		if (arg === "--execution" && i + 1 < args.length) {
			options.execution = args[++i];
			i++;
			continue;
		}

		if (arg === "--execution-id" && i + 1 < args.length) {
			options.executionId = args[++i];
			i++;
			continue;
		}

		if (arg === "--kind" && i + 1 < args.length) {
			options.kind = args[++i];
			i++;
			continue;
		}

		if (arg === "--scheduler" && i + 1 < args.length) {
			options.scheduler = args[++i];
			i++;
			continue;
		}

		if (arg === "--event-id" && i + 1 < args.length) {
			options.eventId = args[++i];
			i++;
			continue;
		}

		if (arg === "--cycle-id" && i + 1 < args.length) {
			options.cycleId = args[++i];
			i++;
			continue;
		}

		if (arg === "--dispatched-continuation-id" && i + 1 < args.length) {
			options.dispatchedContinuationId = args[++i];
			i++;
			continue;
		}

		if (arg === "--result-digest" && i + 1 < args.length) {
			options.resultDigest = args[++i];
			i++;
			continue;
		}

		if (arg === "--expected-scheduler-revision" && i + 1 < args.length) {
			const raw = args[++i];
			const parsed = parseStrictNonNegativeInteger(raw);
			if (parsed === undefined) {
				(
					options as LongHorizonCommandOptions & { _invalidExpectedSchedulerRevision?: string }
				)._invalidExpectedSchedulerRevision = raw;
			} else {
				options.expectedSchedulerRevision = parsed;
			}
			i++;
			continue;
		}

		if (arg === "--expected-execution-revision" && i + 1 < args.length) {
			const raw = args[++i];
			const parsed = parseStrictNonNegativeInteger(raw);
			if (parsed === undefined) {
				(
					options as LongHorizonCommandOptions & { _invalidExpectedExecutionRevision?: string }
				)._invalidExpectedExecutionRevision = raw;
			} else {
				options.expectedExecutionRevision = parsed;
			}
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

		if (arg === "execution") {
			if (i + 1 < args.length && args[i + 1] === "init") {
				options.command = "execution-init";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "inspect") {
				options.command = "execution-inspect";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "validate") {
				options.command = "execution-validate";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "transition") {
				options.command = "execution-transition";
				i += 2;
				continue;
			}
		}

		if (arg === "continuation") {
			if (i + 1 < args.length && args[i + 1] === "init") {
				options.command = "continuation-init";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "inspect") {
				options.command = "continuation-inspect";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "validate") {
				options.command = "continuation-validate";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "schedule") {
				options.command = "continuation-schedule";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "dispatch") {
				options.command = "continuation-dispatch";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "consume") {
				options.command = "continuation-consume";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "cancel") {
				options.command = "continuation-cancel";
				i += 2;
				continue;
			}
			if (i + 1 < args.length && args[i + 1] === "abandon") {
				options.command = "continuation-abandon";
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

${chalk.bold("Execution State Machine Commands:")}
  execution init       Initialize a mission execution record (starts in PLANNING)
  execution inspect    Inspect an execution record structurally (untrusted)
  execution validate   Validate an execution record against its contract
  execution transition Apply a state transition to an execution record

${chalk.bold("Continuation Scheduler Commands:")}
  continuation init      Initialize a continuation scheduler record (IDLE@0)
  continuation inspect   Inspect a scheduler record structurally (no contract/execution)
  continuation validate  Validate scheduler against contract and execution record
  continuation schedule  Schedule a continuation cycle (IDLE → SCHEDULED)
  continuation dispatch  Dispatch a continuation (SCHEDULED → DISPATCHED)
  continuation consume   Consume a dispatched continuation (DISPATCHED → IDLE)
  continuation cancel    Cancel an active cycle (SCHEDULED/DISPATCHED → IDLE)
  continuation abandon   Abandon a superseded cycle (SCHEDULED/DISPATCHED → IDLE)

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

// =============================================================================
// Continuation Scheduler Commands
// =============================================================================

function readSchedulerFile(path: string): ContinuationSchedulerRecord | null {
	const raw = readFileContent(path);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as ContinuationSchedulerRecord;
	} catch {
		console.error(chalk.red("Error parsing scheduler record JSON"));
		process.exitCode = 1;
		return null;
	}
}

function readExecutionForBinding(
	execPath: string,
	contractDigest: string,
): { executionId: string; revision: number } | null {
	const raw = readFileContent(execPath);
	if (!raw) return null;
	try {
		const record = JSON.parse(raw);
		if (typeof record.executionId !== "string" || record.executionId.trim().length === 0) {
			console.error(chalk.red("Error: execution record missing executionId"));
			process.exitCode = 1;
			return null;
		}
		if (typeof record.contractDigest !== "string" || record.contractDigest !== contractDigest) {
			console.error(chalk.red("Error: contract digest mismatch between contract and execution record"));
			process.exitCode = 1;
			return null;
		}
		if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
			console.error(chalk.red("Error: execution record has invalid revision"));
			process.exitCode = 1;
			return null;
		}
		return { executionId: record.executionId, revision: record.revision };
	} catch {
		console.error(chalk.red("Error parsing execution record JSON"));
		process.exitCode = 1;
		return null;
	}
}

function writeSchedulerAtomic(path: string, data: string): boolean {
	const outputPath = resolve(path);
	if (outputPath.includes("..")) {
		console.error(chalk.red("Error: --scheduler path must not contain '..'"));
		process.exitCode = 1;
		return false;
	}

	const dir = dirname(outputPath);
	if (!existsSync(dir)) {
		console.error(chalk.red(`Error: directory ${dir} does not exist`));
		process.exitCode = 1;
		return false;
	}

	const tmpPath = `${outputPath}.tmp.${randomBytes(4).toString("hex")}`;
	try {
		writeFileSync(tmpPath, data, "utf-8");
		renameSync(tmpPath, outputPath);
		return true;
	} catch (err: unknown) {
		try {
			unlinkSync(tmpPath);
		} catch {}
		const message = err instanceof Error ? err.message : "Unknown error";
		console.error(chalk.red(`Error writing scheduler: ${message}`));
		process.exitCode = 1;
		return false;
	}
}

async function handleContinuationInit(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.scheduler || !options.contract || !options.executionId) {
		console.error(chalk.red("Error: --scheduler, --contract, and --execution-id are required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;

	const contractDigest = computeMissionContractDigest(contract);

	const record = initializeContinuationScheduler(options.executionId, contractDigest);
	const json = JSON.stringify(record, null, 2);
	if (!writeSchedulerAtomic(options.scheduler, json)) return true;

	const format = options.format ?? "text";
	if (format === "json") {
		console.log(json);
	} else {
		console.log(`Scheduler initialized: ${options.scheduler}`);
		console.log(`  executionId: ${record.executionId}`);
		console.log(`  contractDigest: ${record.contractDigest}`);
		console.log(`  state: ${record.state}`);
		console.log(`  revision: ${record.schedulerRevision}`);
	}
	return true;
}

async function handleContinuationInspect(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.scheduler) {
		console.error(chalk.red("Error: --scheduler is required"));
		process.exitCode = 1;
		return true;
	}

	if (!existsSync(resolve(options.scheduler))) {
		console.error(chalk.red("Error: ENOENT: scheduler file not found"));
		process.exitCode = 1;
		return true;
	}

	const record = readSchedulerFile(options.scheduler);
	if (!record) return true;

	const inspection = inspectContinuationScheduler(record);
	const format = options.format ?? "text";

	if (format === "json") {
		console.log(JSON.stringify(inspection, null, 2));
	} else {
		if (inspection.valid) {
			console.log(chalk.bold("Continuation Scheduler Inspection (structural)"));
			console.log(`${"Execution ID".padEnd(28)} ${inspection.executionId}`);
			console.log(`${"Contract Digest".padEnd(28)} ${inspection.contractDigest}`);
			console.log(`${"State".padEnd(28)} ${inspection.state}`);
			console.log(`${"Revision".padEnd(28)} ${inspection.schedulerRevision}`);
			console.log(`${"Event Count".padEnd(28)} ${inspection.eventCount}`);
			console.log(`${"History Digest".padEnd(28)} ${inspection.historyDigest ?? "(none)"}`);
		} else {
			console.log(chalk.red(`Invalid: ${inspection.error}`));
		}
	}

	if (!inspection.valid) process.exitCode = 1;
	return true;
}

async function handleContinuationValidate(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.scheduler || !options.contract || !options.execution) {
		console.error(chalk.red("Error: --scheduler, --contract, and --execution are required"));
		process.exitCode = 1;
		return true;
	}

	if (!existsSync(resolve(options.scheduler))) {
		console.error(chalk.red("Error: ENOENT: scheduler file not found"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;
	const contractDigest = computeMissionContractDigest(contract);

	const record = readSchedulerFile(options.scheduler);
	if (!record) return true;

	const execBinding = readExecutionForBinding(options.execution, contractDigest);
	if (!execBinding) return true;

	const result = validateContinuationScheduler(record, contractDigest, execBinding.executionId, execBinding.revision);
	const format = options.format ?? "text";

	if (format === "json") {
		console.log(JSON.stringify(result, null, 2));
	} else {
		if (result.valid) {
			console.log(chalk.green("Continuation scheduler is valid"));
		} else {
			console.log(chalk.red(`Invalid: ${result.error}`));
		}
		console.log(`${"Contract Bound".padEnd(28)} ${result.contractBound ? "Yes" : "No"}`);
		console.log(`${"Execution Bound".padEnd(28)} ${result.executionBound ? "Yes" : "No"}`);
		console.log(`${"Semantic Valid".padEnd(28)} ${result.semanticValid ? "Yes" : "No"}`);
	}

	if (!result.valid) process.exitCode = 1;
	return true;
}

async function handleContinuationSchedule(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.scheduler || !options.contract || !options.execution || !options.eventId) {
		console.error(chalk.red("Error: --scheduler, --contract, --execution, and --event-id are required"));
		process.exitCode = 1;
		return true;
	}

	const invalidSchedulerRev = (options as LongHorizonCommandOptions & { _invalidExpectedSchedulerRevision?: string })
		._invalidExpectedSchedulerRevision;
	if (invalidSchedulerRev !== undefined) {
		console.error(
			chalk.red(
				`Error: invalid-expected-scheduler-revision: "${invalidSchedulerRev}" is not a valid non-negative integer`,
			),
		);
		process.exitCode = 1;
		return true;
	}
	if (options.expectedSchedulerRevision === undefined) {
		console.error(chalk.red("Error: --expected-scheduler-revision is required"));
		process.exitCode = 1;
		return true;
	}

	const invalidExecRev = (options as LongHorizonCommandOptions & { _invalidExpectedExecutionRevision?: string })
		._invalidExpectedExecutionRevision;
	if (invalidExecRev !== undefined) {
		console.error(
			chalk.red(
				`Error: invalid-expected-execution-revision: "${invalidExecRev}" is not a valid non-negative integer`,
			),
		);
		process.exitCode = 1;
		return true;
	}
	if (options.expectedExecutionRevision === undefined) {
		console.error(chalk.red("Error: --expected-execution-revision is required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;
	const contractDigest = computeMissionContractDigest(contract);

	const execBinding = readExecutionForBinding(options.execution, contractDigest);
	if (!execBinding) return true;

	let record: ContinuationSchedulerRecord | null = null;
	if (existsSync(resolve(options.scheduler))) {
		record = readSchedulerFile(options.scheduler);
		if (!record) return true;
		// Contract binding
		if (record.contractDigest !== contractDigest) {
			console.error(chalk.red("Error: CONTRACT_DIGEST_MISMATCH"));
			process.exitCode = 1;
			return true;
		}
		// Execution binding
		if (record.executionId !== execBinding.executionId) {
			console.error(chalk.red("Error: execution ID mismatch"));
			process.exitCode = 1;
			return true;
		}
	} else {
		// Missing scheduler — allowed only with expectedSchedulerRevision 0
		if (options.expectedSchedulerRevision !== 0) {
			console.error(
				chalk.red("Error: ENOENT: scheduler file not found; expectedSchedulerRevision must be 0 for init"),
			);
			process.exitCode = 1;
			return true;
		}
		// Construct in memory: IDLE with execution binding
		record = initializeContinuationScheduler(execBinding.executionId, contractDigest);
	}

	const result = scheduleContinuation(record, {
		eventId: options.eventId,
		expectedSchedulerRevision: options.expectedSchedulerRevision,
		expectedExecutionRevision: options.expectedExecutionRevision,
	});

	if (!result.ok) {
		console.error(chalk.red(`Error: ${result.code ? `${result.code}: ` : ""}${result.error}`));
		process.exitCode = 1;
		return true;
	}

	// Atomic persistence
	const json = JSON.stringify(result.record, null, 2);
	if (!writeSchedulerAtomic(options.scheduler, json)) return true;

	const format = options.format ?? "text";
	if (format === "json") {
		console.log(JSON.stringify(result.event, null, 2));
	} else {
		console.log(chalk.green(`Scheduled: ${result.event!.eventId}`));
		console.log(`  state: ${result.record!.state}`);
		console.log(`  revision: ${result.record!.schedulerRevision}`);
	}
	return true;
}

async function handleContinuationDispatch(options: LongHorizonCommandOptions): Promise<boolean> {
	if (
		!options.scheduler ||
		!options.contract ||
		!options.execution ||
		!options.eventId ||
		!options.cycleId ||
		!options.dispatchedContinuationId
	) {
		console.error(
			chalk.red(
				"Error: --scheduler, --contract, --execution, --event-id, --cycle-id, and --dispatched-continuation-id are required",
			),
		);
		process.exitCode = 1;
		return true;
	}

	const invalidSchedulerRev = (options as LongHorizonCommandOptions & { _invalidExpectedSchedulerRevision?: string })
		._invalidExpectedSchedulerRevision;
	if (invalidSchedulerRev !== undefined) {
		console.error(
			chalk.red(
				`Error: invalid-expected-scheduler-revision: "${invalidSchedulerRev}" is not a valid non-negative integer`,
			),
		);
		process.exitCode = 1;
		return true;
	}
	if (options.expectedSchedulerRevision === undefined) {
		console.error(chalk.red("Error: --expected-scheduler-revision is required"));
		process.exitCode = 1;
		return true;
	}

	const record = readSchedulerFileSafe(options.scheduler);
	if (!record) return true;

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;
	const contractDigest = computeMissionContractDigest(contract);

	const execBinding = readExecutionForBinding(options.execution, contractDigest);
	if (!execBinding) return true;

	// Contract and execution binding
	if (record.contractDigest !== contractDigest) {
		console.error(chalk.red("Error: CONTRACT_DIGEST_MISMATCH"));
		process.exitCode = 1;
		return true;
	}
	if (record.executionId !== execBinding.executionId) {
		console.error(chalk.red("Error: execution ID mismatch"));
		process.exitCode = 1;
		return true;
	}

	const result = dispatchContinuation(record, {
		eventId: options.eventId,
		cycleId: options.cycleId,
		expectedSchedulerRevision: options.expectedSchedulerRevision,
		dispatchedContinuationId: options.dispatchedContinuationId,
	});

	if (!result.ok) {
		console.error(chalk.red(`Error: ${result.code ? `${result.code}: ` : ""}${result.error}`));
		process.exitCode = 1;
		return true;
	}

	const json = JSON.stringify(result.record, null, 2);
	if (!writeSchedulerAtomic(options.scheduler, json)) return true;

	const format = options.format ?? "text";
	if (format === "json") {
		console.log(JSON.stringify(result.event, null, 2));
	} else {
		console.log(chalk.green(`Dispatched: ${result.event!.eventId}`));
		console.log(`  state: ${result.record!.state}`);
		console.log(`  revision: ${result.record!.schedulerRevision}`);
	}
	return true;
}

async function handleContinuationConsume(options: LongHorizonCommandOptions): Promise<boolean> {
	if (
		!options.scheduler ||
		!options.contract ||
		!options.execution ||
		!options.eventId ||
		!options.cycleId ||
		!options.dispatchedContinuationId ||
		!options.resultDigest
	) {
		console.error(
			chalk.red(
				"Error: --scheduler, --contract, --execution, --event-id, --cycle-id, --dispatched-continuation-id, and --result-digest are required",
			),
		);
		process.exitCode = 1;
		return true;
	}

	const invalidSchedulerRev = (options as LongHorizonCommandOptions & { _invalidExpectedSchedulerRevision?: string })
		._invalidExpectedSchedulerRevision;
	if (invalidSchedulerRev !== undefined) {
		console.error(
			chalk.red(
				`Error: invalid-expected-scheduler-revision: "${invalidSchedulerRev}" is not a valid non-negative integer`,
			),
		);
		process.exitCode = 1;
		return true;
	}
	if (options.expectedSchedulerRevision === undefined) {
		console.error(chalk.red("Error: --expected-scheduler-revision is required"));
		process.exitCode = 1;
		return true;
	}

	const record = readSchedulerFileSafe(options.scheduler);
	if (!record) return true;

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;
	const contractDigest = computeMissionContractDigest(contract);

	const execBinding = readExecutionForBinding(options.execution, contractDigest);
	if (!execBinding) return true;

	if (record.contractDigest !== contractDigest) {
		console.error(chalk.red("Error: CONTRACT_DIGEST_MISMATCH"));
		process.exitCode = 1;
		return true;
	}
	if (record.executionId !== execBinding.executionId) {
		console.error(chalk.red("Error: execution ID mismatch"));
		process.exitCode = 1;
		return true;
	}

	const result = consumeContinuation(record, {
		eventId: options.eventId,
		cycleId: options.cycleId,
		expectedSchedulerRevision: options.expectedSchedulerRevision,
		dispatchedContinuationId: options.dispatchedContinuationId,
		resultDigest: options.resultDigest,
	});

	if (!result.ok) {
		console.error(chalk.red(`Error: ${result.code ? `${result.code}: ` : ""}${result.error}`));
		process.exitCode = 1;
		return true;
	}

	const json = JSON.stringify(result.record, null, 2);
	if (!writeSchedulerAtomic(options.scheduler, json)) return true;

	const format = options.format ?? "text";
	if (format === "json") {
		console.log(JSON.stringify(result.event, null, 2));
	} else {
		console.log(chalk.green(`Consumed: ${result.event!.eventId}`));
		console.log(`  state: ${result.record!.state}`);
		console.log(`  revision: ${result.record!.schedulerRevision}`);
	}
	return true;
}

async function handleContinuationCancel(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.scheduler || !options.contract || !options.execution || !options.eventId || !options.cycleId) {
		console.error(chalk.red("Error: --scheduler, --contract, --execution, --event-id, and --cycle-id are required"));
		process.exitCode = 1;
		return true;
	}

	const invalidSchedulerRev = (options as LongHorizonCommandOptions & { _invalidExpectedSchedulerRevision?: string })
		._invalidExpectedSchedulerRevision;
	if (invalidSchedulerRev !== undefined) {
		console.error(
			chalk.red(
				`Error: invalid-expected-scheduler-revision: "${invalidSchedulerRev}" is not a valid non-negative integer`,
			),
		);
		process.exitCode = 1;
		return true;
	}
	if (options.expectedSchedulerRevision === undefined) {
		console.error(chalk.red("Error: --expected-scheduler-revision is required"));
		process.exitCode = 1;
		return true;
	}

	const record = readSchedulerFileSafe(options.scheduler);
	if (!record) return true;

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;
	const contractDigest = computeMissionContractDigest(contract);

	const execBinding = readExecutionForBinding(options.execution, contractDigest);
	if (!execBinding) return true;

	if (record.contractDigest !== contractDigest) {
		console.error(chalk.red("Error: CONTRACT_DIGEST_MISMATCH"));
		process.exitCode = 1;
		return true;
	}
	if (record.executionId !== execBinding.executionId) {
		console.error(chalk.red("Error: execution ID mismatch"));
		process.exitCode = 1;
		return true;
	}

	const result = cancelContinuation(
		record,
		{
			eventId: options.eventId,
			cycleId: options.cycleId,
			expectedSchedulerRevision: options.expectedSchedulerRevision,
		},
		execBinding.revision,
	);

	if (!result.ok) {
		console.error(chalk.red(`Error: ${result.code ? `${result.code}: ` : ""}${result.error}`));
		process.exitCode = 1;
		return true;
	}

	const json = JSON.stringify(result.record, null, 2);
	if (!writeSchedulerAtomic(options.scheduler, json)) return true;

	const format = options.format ?? "text";
	if (format === "json") {
		console.log(JSON.stringify(result.event, null, 2));
	} else {
		console.log(chalk.green(`Cancelled: ${result.event!.eventId}`));
		console.log(`  state: ${result.record!.state}`);
		console.log(`  revision: ${result.record!.schedulerRevision}`);
	}
	return true;
}

async function handleContinuationAbandon(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.scheduler || !options.contract || !options.execution || !options.eventId || !options.cycleId) {
		console.error(chalk.red("Error: --scheduler, --contract, --execution, --event-id, and --cycle-id are required"));
		process.exitCode = 1;
		return true;
	}

	const invalidSchedulerRev = (options as LongHorizonCommandOptions & { _invalidExpectedSchedulerRevision?: string })
		._invalidExpectedSchedulerRevision;
	if (invalidSchedulerRev !== undefined) {
		console.error(
			chalk.red(
				`Error: invalid-expected-scheduler-revision: "${invalidSchedulerRev}" is not a valid non-negative integer`,
			),
		);
		process.exitCode = 1;
		return true;
	}
	if (options.expectedSchedulerRevision === undefined) {
		console.error(chalk.red("Error: --expected-scheduler-revision is required"));
		process.exitCode = 1;
		return true;
	}

	const record = readSchedulerFileSafe(options.scheduler);
	if (!record) return true;

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;
	const contractDigest = computeMissionContractDigest(contract);

	const execBinding = readExecutionForBinding(options.execution, contractDigest);
	if (!execBinding) return true;

	if (record.contractDigest !== contractDigest) {
		console.error(chalk.red("Error: CONTRACT_DIGEST_MISMATCH"));
		process.exitCode = 1;
		return true;
	}
	if (record.executionId !== execBinding.executionId) {
		console.error(chalk.red("Error: execution ID mismatch"));
		process.exitCode = 1;
		return true;
	}

	const result = abandonContinuation(
		record,
		{
			eventId: options.eventId,
			cycleId: options.cycleId,
			expectedSchedulerRevision: options.expectedSchedulerRevision,
		},
		execBinding.revision,
	);

	if (!result.ok) {
		console.error(chalk.red(`Error: ${result.code ? `${result.code}: ` : ""}${result.error}`));
		process.exitCode = 1;
		return true;
	}

	const json = JSON.stringify(result.record, null, 2);
	if (!writeSchedulerAtomic(options.scheduler, json)) return true;

	const format = options.format ?? "text";
	if (format === "json") {
		console.log(JSON.stringify(result.event, null, 2));
	} else {
		console.log(chalk.green(`Abandoned: ${result.event!.eventId}`));
		console.log(`  state: ${result.record!.state}`);
		console.log(`  revision: ${result.record!.schedulerRevision}`);
	}
	return true;
}

/** Read scheduler file, printing ENOENT on missing. */
function readSchedulerFileSafe(path: string): ContinuationSchedulerRecord | null {
	if (!existsSync(resolve(path))) {
		console.error(chalk.red("Error: ENOENT: scheduler file not found"));
		process.exitCode = 1;
		return null;
	}
	return readSchedulerFile(path);
}

// =============================================================================
// Execution State Machine Commands
// =============================================================================

const VALID_EXECUTION_KINDS: ReadonlySet<string> = new Set([
	"START_EXECUTION",
	"REQUEST_VERIFICATION",
	"RETURN_TO_EXECUTION",
	"REQUEST_COMPLETION_REVIEW",
	"RETURN_TO_VERIFICATION",
	"APPROVE_COMPLETION",
	"BLOCK",
	"RESUME",
	"FAIL",
	"CANCEL",
]);

async function handleExecutionInit(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.contract || !options.executionId) {
		console.error(chalk.red("Error: --contract and --execution-id are required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;

	let record: MissionExecutionRecordV1;
	try {
		record = initializeMissionExecution(contract, options.executionId);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Unknown error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}

	const format = options.format ?? "text";
	writeExecutionOutput(record, options, format);
	return true;
}

async function handleExecutionInspect(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.contract || !options.execution) {
		console.error(chalk.red("Error: --contract and --execution are required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;

	const record = readExecutionFile(options.execution);
	if (!record) return true;

	const inspection = inspectMissionExecution(contract, record);
	const format = options.format ?? "text";

	if (format === "json") {
		const output = JSON.stringify(inspection, null, 2);
		writeOutput(output, options);
	} else {
		if (inspection.valid) {
			console.log(chalk.bold("Execution Record Inspection (structural only)"));
			console.log(`${"Execution ID".padEnd(28)} ${inspection.executionId}`);
			console.log(`${"Contract Digest".padEnd(28)} ${inspection.contractDigest}`);
			console.log(`${"State".padEnd(28)} ${inspection.state}`);
			console.log(`${"Revision".padEnd(28)} ${inspection.revision}`);
			console.log(`${"Transition Count".padEnd(28)} ${inspection.transitionCount}`);
			if (inspection.blockedFromState) {
				console.log(`${"Blocked From".padEnd(28)} ${inspection.blockedFromState}`);
			}
			console.log(
				`${chalk.yellow("Completion Approved".padEnd(28))} ${chalk.yellow("unavailable (trusted context required)")}`,
			);
		} else {
			console.log(chalk.red(`Invalid: ${inspection.error}`));
			process.exitCode = 1;
		}
	}

	if (!inspection.valid) process.exitCode = 1;
	return true;
}

async function handleExecutionValidate(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.contract || !options.execution) {
		console.error(chalk.red("Error: --contract and --execution are required"));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;

	const record = readExecutionFile(options.execution);
	if (!record) return true;

	const result = validateMissionExecutionRecord(contract, record);
	const format = options.format ?? "text";

	if (format === "json") {
		const output = JSON.stringify(result, null, 2);
		writeOutput(output, options);
	} else {
		if (result.valid) {
			console.log(chalk.green("Execution record is valid"));
		} else {
			console.log(chalk.red(`Invalid: ${result.error}`));
		}
	}

	if (!result.valid) process.exitCode = 1;
	return true;
}

async function handleExecutionTransition(options: LongHorizonCommandOptions): Promise<boolean> {
	if (!options.contract || !options.execution || !options.transitionId || !options.kind) {
		console.error(chalk.red("Error: --contract, --execution, --transition-id, and --kind are required"));
		process.exitCode = 1;
		return true;
	}
	if (options.expectedRevision === undefined) {
		const invalidRev = (options as LongHorizonCommandOptions & { _invalidExpectedRevision?: string })
			._invalidExpectedRevision;
		if (invalidRev !== undefined) {
			console.error(
				chalk.red(`Error: invalid-expected-revision: "${invalidRev}" is not a valid non-negative integer`),
			);
		} else {
			console.error(chalk.red("Error: --expected-revision is required"));
		}
		process.exitCode = 1;
		return true;
	}

	if (!VALID_EXECUTION_KINDS.has(options.kind)) {
		console.error(chalk.red(`Error: invalid transition kind: "${options.kind}"`));
		process.exitCode = 1;
		return true;
	}

	const contract = readContractFileAndParse(options.contract);
	if (!contract) return true;

	const record = readExecutionFile(options.execution);
	if (!record) return true;

	// APPROVE_COMPLETION requires trusted context — the generic CLI cannot mint one.
	// Reject atomically before any mutation.
	if (options.kind === "APPROVE_COMPLETION") {
		console.error(
			chalk.red(
				"Error: TRUSTED_VALIDATION_CONTEXT_REQUIRED: APPROVE_COMPLETION requires a trusted validation context (not available through generic CLI)",
			),
		);
		process.exitCode = 1;
		return true;
	}

	const result = applyMissionExecutionTransition(contract, record, {
		transitionId: options.transitionId,
		expectedRevision: options.expectedRevision,
		kind: options.kind as MissionExecutionTransitionKind,
	});

	if (!result.ok) {
		console.error(chalk.red(`Error: ${result.code ? `${result.code}: ` : ""}${result.error}`));
		process.exitCode = 1;
		return true;
	}

	const format = options.format ?? "text";
	writeExecutionOutput(result.record, options, format);
	return true;
}

// =============================================================================
// Execution file I/O
// =============================================================================

function readExecutionFile(path: string): MissionExecutionRecordV1 | null {
	const raw = readFileContent(path);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as MissionExecutionRecordV1;
		return parsed;
	} catch {
		console.error(chalk.red("Error parsing execution record JSON"));
		process.exitCode = 1;
		return null;
	}
}

function writeExecutionOutput(
	record: MissionExecutionRecordV1,
	options: LongHorizonCommandOptions,
	format: "text" | "json",
): void {
	if (format === "json") {
		const output = JSON.stringify(record, null, 2);
		writeOutput(output, options);
	} else {
		const lines = [
			`Execution: ${record.executionId}`,
			`Contract Digest: ${record.contractDigest}`,
			`State: ${record.state}`,
			`Revision: ${record.revision}`,
			`Transitions: ${record.transitions.length}`,
		];
		if (record.blockedFromState) {
			lines.push(`Blocked From: ${record.blockedFromState}`);
		}
		const text = lines.join("\n");
		writeOutput(text, options);
	}
}
