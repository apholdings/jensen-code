/**
 * Tool-call normalization & conservative repair subsystem types.
 *
 * The pipeline is provider-independent and deterministic:
 *
 *   raw provider output
 *   → candidate tool-call extraction
 *   → canonical name resolution
 *   → argument normalization
 *   → conservative repair
 *   → schema validation
 *   → effect & policy evaluation
 *   → execution
 *
 * Repair is CONSERVATIVE: it may normalize unambiguous representations but
 * must never invent semantic arguments. Ambiguous mutating calls fail closed.
 */

/** Unique id for each structured repair action. */
export type RepairId = string;

export type RepairConfidence = "deterministic";

/** Structured evidence produced by every applied repair. */
export interface ToolCallRepair {
	/** Unique id, generated deterministically from before/after hashes. */
	repairId: RepairId;
	/** Path to the repaired field (dot-separated), when scoped to a field. */
	field?: string;
	/** Machine-readable kind of the repair performed. */
	repairKind: string;
	/** SHA-256 hex of the canonicalized raw arguments BEFORE repair. */
	beforeHash: string;
	/** SHA-256 hex of the canonicalized arguments AFTER repair. */
	afterHash: string;
	confidence: RepairConfidence;
}

/** Exactly one classification for a validated/repaired tool call. */
export type RepairOutcomeKind =
	| "valid_without_repair"
	| "repaired_and_valid"
	| "invalid_repair_refused"
	| "invalid_schema"
	| "ambiguous";

/** Result of running a tool call through the normalization & repair pipeline. */
export interface NormalizedToolCall<TArgs = Record<string, unknown>> {
	/** Canonical tool name after alias resolution. */
	name: string;
	/** Original tool name as emitted by the provider. */
	rawName: string;
	/** Provider tool-call id, preserved when present. */
	toolCallId: string;
	/** Normalized, canonical arguments. */
	args: TArgs;
	outcome: RepairOutcomeKind;
	/** Repairs applied (empty when valid_without_repair). */
	repairs: ToolCallRepair[];
	/** Hash of the canonical pre-repair arguments. */
	rawHash: string;
	/** Hash of the canonical post-normalization arguments. */
	canonicalHash: string;
	/** Compatibility transform record for this call, if any. */
	compatibility?: SchemaCompatibilityRecord;
	/** Whether the call is still truncated / unrecoverable. */
	truncated?: TruncatedJsonOutcome;
}

/** Record of a schema compatibility transform applied before the provider. */
export interface SchemaCompatibilityRecord {
	transformId: string;
	appliedToProperties: string[];
	note?: string;
}

export type TruncatedJsonOutcome =
	| { status: "not_truncated" }
	| { status: "recovered"; continuationAttempts: number; beforeHash: string; afterHash: string }
	| { status: "unrecoverable"; reason: string; beforeHash: string };

/** Canonical schema descriptor narrowed to what validation/repair needs. */
export interface CanonicalJsonSchema {
	type?: string | string[];
	required?: string[];
	properties?: Record<string, CanonicalJsonSchema>;
	items?: CanonicalJsonSchema | CanonicalJsonSchema[];
	enum?: unknown[];
	oneOf?: CanonicalJsonSchema[];
	anyOf?: CanonicalJsonSchema[];
	nullable?: boolean;
	// JSON Schema draft keywords we preserve through flattening.
	additionalProperties?: boolean | CanonicalJsonSchema;
	$ref?: string;
}

/** How a schema was transformed for provider compatibility. */
export type SchemaCompatibilityTransform =
	| { transformId: "none" }
	| { transformId: "flatten-single-level"; note?: string }
	| { transformId: "wrap-nullable"; note?: string };

/** A tool schema pair: the canonical schema plus the provider-facing one. */
export interface SchemaEnvelope {
	canonical: CanonicalJsonSchema;
	providerFacing: CanonicalJsonSchema;
	transform: SchemaCompatibilityTransform;
	/** True when the schema could not be represented safely (fails explicitly). */
	unsupported?: boolean;
	/** Reason when unsupported. */
	unsupportedReason?: string;
}

/** Options controlling conservative repair behavior. */
export interface RepairOptions {
	maxRepairDepth?: number;
	maxTruncatedJsonBytes?: number;
	maxTruncatedJsonContinuations?: number;
	aliasMap?: Record<string, string>;
	allowSingletonToArray?: boolean;
	allowStringPrimitiveCoercion?: boolean;
	allowTruncatedContainerClose?: boolean;
	allowPathSeparatorNormalization?: boolean;
}

/**
 * Sentinel error for unrecoverable / ambiguous / invalid normalized calls so
 * the executor can fail closed without executing.
 */
export class ToolCallNormalizationError extends Error {
	readonly outcome: RepairOutcomeKind;
	readonly repair: ToolCallRepair | undefined;
	constructor(
		outcome: RepairOutcomeKind,
		message: string,
		readonly toolName: string,
		repair?: ToolCallRepair,
	) {
		super(message);
		this.name = "ToolCallNormalizationError";
		this.outcome = outcome;
		this.repair = repair;
	}
}
