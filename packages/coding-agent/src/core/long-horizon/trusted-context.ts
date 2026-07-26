/**
 * Trusted Ledger Mutation & Validation Contexts.
 *
 * Implements the structural in-process capability boundary for the
 * Mission Contract and Requirement Ledger system, plus a trusted
 * validation registry for authoritative ledger replay.
 *
 * Mutation context: OPAQUE, BRANDED, SEPARATE — not serializable, not reconstructible.
 * Validation context: contains a trust registry for replay verification.
 *
 * This is NOT a cryptographic identity system. It is a structural boundary
 * that prevents serialized payloads from inventing authority, and prevents
 * stored provenance from self-authenticating.
 */

import { computeMissionContractDigest } from "./contract-digest.js";
import { validateMissionContract } from "./mission-contract-schema.js";
import type { EvidenceAuthorityClassification, EvidenceCollectorType, MissionContractV1 } from "./types.js";

// =============================================================================
// Opaque brands — private, unexported
// =============================================================================

const _trustedMutationContextBrand = Symbol("trustedMutationContextBrand");
const _trustedValidationContextBrand = Symbol("trustedValidationContextBrand");

// =============================================================================
// Module-private WeakSets as side-channel runtime brands
// =============================================================================

// Only objects registered here pass isTrustedMutationContext.
// No plain object, JSON round-trip, or Object.create can enter this set
// except through the internal trusted factory.
const _trustedMutationContextSet = new WeakSet<object>();

const _trustedValidationContextSet = new WeakSet<object>();

// Contract digest binding — only genuine trusted validation contexts
// are bound to their originating Mission Contract digest.
const _contractDigestMap = new WeakMap<object, string>();

// =============================================================================
// Principal kinds — attribution only, not authorization
// =============================================================================

/**
 * Verifiable principal identity classification.
 *
 * These are stored as provenance in the ledger for auditing.
 * They do NOT directly grant capabilities — capability sets are
 * assigned by the trusted factory separately.
 */
export type TrustedPrincipalKind = "agent" | "operator" | "trusted-collector" | "automated-review" | "system";

// =============================================================================
// Typed ledger capabilities — explicit authorization
// =============================================================================

export type LedgerCapability =
	| "evidence:repository-observation"
	| "evidence:command-result"
	| "evidence:test-result"
	| "evidence:runtime-observation"
	| "evidence:operator-confirmation"
	| "evidence:trusted-collector"
	| "transition:satisfy"
	| "transition:not-applicable"
	| "transition:operator-override";

export type EvidenceLedgerCapability = Extract<
	LedgerCapability,
	| "evidence:repository-observation"
	| "evidence:command-result"
	| "evidence:test-result"
	| "evidence:runtime-observation"
	| "evidence:operator-confirmation"
	| "evidence:trusted-collector"
>;

const ALL_CAPABILITIES: ReadonlySet<string> = new Set([
	"evidence:repository-observation",
	"evidence:command-result",
	"evidence:test-result",
	"evidence:runtime-observation",
	"evidence:operator-confirmation",
	"evidence:trusted-collector",
	"transition:satisfy",
	"transition:not-applicable",
	"transition:operator-override",
]);

const EVIDENCE_CAPABILITIES: ReadonlySet<string> = new Set([
	"evidence:repository-observation",
	"evidence:command-result",
	"evidence:test-result",
	"evidence:runtime-observation",
	"evidence:operator-confirmation",
	"evidence:trusted-collector",
]);

export function isEvidenceCapability(cap: string): cap is EvidenceLedgerCapability {
	return EVIDENCE_CAPABILITIES.has(cap);
}

const VALID_PRINCIPAL_KINDS: ReadonlySet<string> = new Set([
	"agent",
	"operator",
	"trusted-collector",
	"automated-review",
	"system",
]);

// =============================================================================
// Trusted Evidence Source Grants
// =============================================================================

/**
 * A trusted evidence-source grant binds a source identifier to:
 *   - An exact principal tuple (principalId + principalKind)
 *   - An evidence capability
 *   - Optional constraints on evidence type, collector class,
 *     requirement IDs, and criterion IDs.
 *
 * Sources are explicit grants, not derived from principal IDs.
 * A registered principal is NOT automatically a source.
 */
export interface TrustedEvidenceSourceGrant {
	readonly sourceId: string;

	/** The exact principal tuple that may use this source. */
	readonly principalId: string;
	readonly principalKind: TrustedPrincipalKind;

	/** The evidence capability this source is authorized under. */
	readonly capability: EvidenceLedgerCapability;

	/** Allowed evidence types. Must be non-empty. */
	readonly allowedEvidenceTypes: readonly string[];

	/** Optional collector class restrictions. */
	readonly allowedCollectorClasses?: readonly string[];

	/** Optional requirement ID restrictions. */
	readonly allowedRequirementIds?: readonly string[];

	/** Optional criterion ID restrictions. */
	readonly allowedCriterionIds?: readonly string[];
}

// =============================================================================
// Trusted Mutation Context
// =============================================================================

export interface TrustedLedgerMutationContext {
	readonly principalId: string;
	readonly principalKind: TrustedPrincipalKind;
	readonly capabilities: ReadonlySet<LedgerCapability>;
}

// =============================================================================
// Trusted Validation Context — separate from mutation context
// =============================================================================

/**
 * Source verification request carrying all available dimensions.
 */
export interface EvidenceSourceVerificationRequest {
	readonly sourceId: string;
	readonly principalId: string;
	readonly principalKind: TrustedPrincipalKind;
	readonly capability: string;
	readonly evidenceType: string;
	readonly collectorClass?: EvidenceCollectorType;
	readonly requirementIds: readonly string[];
	readonly criterionIds: readonly string[];
}

/**
 * Trusted validation context for authoritative ledger replay.
 *
 * Contains a registry of known principals and their capabilities,
 * plus explicit trusted evidence-source grants.
 * During validation, every stored verifiedPrincipalId, verifiedPrincipalKind,
 * and verifiedCapability is checked against this registry.
 * Stored provenance is NOT self-authenticating.
 *
 * This context is not serializable, not reconstructible from ledger JSON,
 * and not derivable from stored verified fields.
 */
export interface TrustedValidationContext {
	/**
	 * Verify that a principal exists and has the claimed kind.
	 */
	verifyPrincipal(principalId: string, principalKind: string): boolean;

	/**
	 * Verify that a principal was granted a specific capability.
	 * Requires exact (principalId, principalKind) match.
	 */
	verifyCapability(principalId: string, principalKind: string, capability: string): boolean;

	/**
	 * Verify an evidence source against its trusted grant.
	 * Checks source existence, principal binding, capability, evidence type,
	 * and optional collector/requirement/criterion constraints.
	 */
	verifyEvidenceSource(request: EvidenceSourceVerificationRequest): boolean;
}

// =============================================================================
// Untrusted mutation context — explicitly empty
// =============================================================================

const _untrustedMutation: TrustedLedgerMutationContext = (() => {
	const ctx: TrustedLedgerMutationContext = Object.freeze({
		principalId: "untrusted",
		principalKind: "agent" as const,
		capabilities: new Set<LedgerCapability>(),
	});
	_trustedMutationContextSet.add(ctx);
	return ctx;
})();

/**
 * The default untrusted context used by the generic CLI and
 * any caller that does not hold a trusted capability grant.
 */
export function getUntrustedContext(): TrustedLedgerMutationContext {
	return _untrustedMutation;
}

// =============================================================================
// Untrusted validation context — explicitly NOT a trusted context
// =============================================================================

/**
 * Structural inspection object — NOT a TrustedValidationContext.
 *
 * This object is structurally compatible with the TrustedValidationContext
 * interface for migration purposes, but is deliberately NOT added to the
 * trusted WeakSet. It does NOT pass isTrustedValidationContext() and
 * CANNOT be passed to authoritative validation APIs.
 *
 * Used only for structural ledger introspection (inspectRequirementLedgerStructure,
 * inspectLedgerStructure). Trusted validation requires a genuine
 * TrustedValidationContext from _internalCreateTrustedValidationContext.
 *
 * @deprecated Use inspectRequirementLedgerStructure or inspectLedgerStructure
 * for structural inspection. Remove once all callers have migrated to the
 * structural inspection API.
 */
const _untrustedValidation = Object.freeze({
	verifyPrincipal: () => true,
	verifyCapability: () => true,
	verifyEvidenceSource: () => true,
});

// Deliberately NOT added to _trustedValidationContextSet.
// isTrustedValidationContext() will return false for this object.

/**
 * @deprecated Use inspectRequirementLedgerStructure() or inspectLedgerStructure()
 * for structural inspection. This function returns a structural-only object that
 * does NOT implement TrustedValidationContext and cannot be passed to
 * authoritative validation APIs.
 *
 * Will be removed when all callers have migrated to the structural API.
 */
export function getUntrustedValidationContext(): TrustedValidationContext {
	// Cast through unknown: this object is deliberately NOT a real
	// TrustedValidationContext (not in the WeakSet). The return type
	// is preserved for migration compatibility only.
	return _untrustedValidation as unknown as TrustedValidationContext;
}

// =============================================================================
// Type guards — check both Symbol AND WeakSet
// =============================================================================

/**
 * Returns true when the value was created by _internalCreateTrustedContext
 * or getUntrustedContext. Plain objects, JSON round-trips, and Object.assign
 * copies will always return false.
 */
export function isTrustedMutationContext(ctx: unknown): ctx is TrustedLedgerMutationContext {
	if (typeof ctx !== "object" || ctx === null) return false;
	return _trustedMutationContextSet.has(ctx);
}

/**
 * Returns true when the value was created by the internal validation
 * context factory or getUntrustedValidationContext.
 */
export function isTrustedValidationContext(ctx: unknown): ctx is TrustedValidationContext {
	if (typeof ctx !== "object" || ctx === null) return false;
	return _trustedValidationContextSet.has(ctx);
}

// =============================================================================
// Internal trusted mutation factory
// =============================================================================

export function _internalCreateTrustedContext(params: {
	principalId: string;
	principalKind: TrustedPrincipalKind;
	capabilities: LedgerCapability[];
}): TrustedLedgerMutationContext {
	const { principalId, principalKind, capabilities } = params;

	if (!principalId || principalId.trim().length === 0) {
		throw new Error("INVALID_TRUSTED_PRINCIPAL: principalId must be non-empty");
	}

	if (!VALID_PRINCIPAL_KINDS.has(principalKind)) {
		throw new Error(`INVALID_TRUSTED_PRINCIPAL: unknown principal kind "${principalKind}"`);
	}

	for (const cap of capabilities) {
		if (!ALL_CAPABILITIES.has(cap)) {
			throw new Error(`INVALID_TRUSTED_CAPABILITY: unknown capability "${cap}"`);
		}
	}

	const ctx: TrustedLedgerMutationContext = Object.freeze({
		principalId,
		principalKind,
		capabilities: new Set(capabilities),
	});

	_trustedMutationContextSet.add(ctx);
	return ctx;
}

// =============================================================================
// Trusted validation context — principal registry
// =============================================================================

/**
 * Create a trusted validation context from a set of known principals
 * and explicit trusted evidence-source grants, bound to one validated Mission Contract.
 *
 * THIS IS THE TRUST-MINTING BOUNDARY: every genuine TrustedValidationContext
 * is bound to exactly one Mission Contract digest. The factory itself:
 *   1. Validates the Mission Contract.
 *   2. Derives the authoritative canonical contract digest.
 *   3. Builds immutable requirement and criterion registries from the validated contract.
 *   4. Validates every source-grant requirement and criterion reference.
 *   5. Rejects invalid or ambiguous grants.
 *   6. Binds the resulting genuine validation context to that exact contract digest.
 *   7. Returns no usable trusted context on failure.
 *
 * Principals are identified by exact (id, kind) tuples with associated capabilities.
 * During replay, stored provenance is verified against this registry.
 *
 * Duplicate exact principal tuples are REJECTED.
 *
 * Same textual ID with different kinds is PERMITTED, but each tuple is treated
 * as completely independent. No capability sharing across kinds.
 *
 * Source IDs require explicit TrustedEvidenceSourceGrant entries.
 * Registered principals are NOT automatically sources.
 *
 * Standalone validators (validateSourceGrantCriterionIds) are diagnostic
 * conveniences. This factory is the mandatory enforcement boundary.
 *
 * @deprecated The legacy two-argument form (principals, sourceGrants) is no
 * longer supported for trusted context creation. Use the params-object form
 * with a contract parameter instead.
 */
export function _internalCreateTrustedValidationContext(
	paramsOrContract:
		| {
				contract: MissionContractV1;
				principals: Array<{
					principalId: string;
					principalKind: TrustedPrincipalKind;
					capabilities: LedgerCapability[];
				}>;
				sourceGrants?: TrustedEvidenceSourceGrant[];
		  }
		| Array<{
				principalId: string;
				principalKind: TrustedPrincipalKind;
				capabilities: LedgerCapability[];
		  }>,
): TrustedValidationContext;
export function _internalCreateTrustedValidationContext(
	principals: Array<{
		principalId: string;
		principalKind: TrustedPrincipalKind;
		capabilities: LedgerCapability[];
	}>,
	sourceGrants?: TrustedEvidenceSourceGrant[],
): TrustedValidationContext;
export function _internalCreateTrustedValidationContext(
	paramsOrContract:
		| {
				contract: MissionContractV1;
				principals: Array<{
					principalId: string;
					principalKind: TrustedPrincipalKind;
					capabilities: LedgerCapability[];
				}>;
				sourceGrants?: TrustedEvidenceSourceGrant[];
		  }
		| Array<{
				principalId: string;
				principalKind: TrustedPrincipalKind;
				capabilities: LedgerCapability[];
		  }>,
): TrustedValidationContext {
	// Legacy call detection: if the first argument is an array, it's the old form.
	if (Array.isArray(paramsOrContract)) {
		throw new Error(
			"DEPRECATED: _internalCreateTrustedValidationContext(principals, sourceGrants) is no longer supported. " +
				"Use the params-object form: _internalCreateTrustedValidationContext({ contract, principals, sourceGrants }). " +
				"Every trusted validation context must be bound to a validated Mission Contract.",
		);
	}
	const { contract, principals, sourceGrants = [] } = paramsOrContract;

	// =========================================================================
	// Phase 0: Validate the Mission Contract itself
	// =========================================================================

	const contractValidation = validateMissionContract(contract);
	if (!contractValidation.valid) {
		throw new Error(`INVALID_MISSION_CONTRACT: ${contractValidation.errors.map((e) => e.message).join("; ")}`);
	}

	// =========================================================================
	// Phase 0b: Derive canonical contract digest
	// =========================================================================

	const contractDigest = computeMissionContractDigest(contract);

	// =========================================================================
	// Phase 0c: Build requirement and global criterion registries
	// =========================================================================

	const requirementIds = new Set<string>();
	const globalCriterionIds = new Set<string>();
	// Criterion-to-requirement mapping for cross-scope coherence
	const criterionToRequirement = new Map<string, string>();

	for (const req of contract.requirements) {
		requirementIds.add(req.id);
		for (const crit of req.acceptanceCriteria) {
			globalCriterionIds.add(crit.id);
			criterionToRequirement.set(crit.id, req.id);
		}
	}

	// =========================================================================
	// Validate and build principal lookup maps
	// =========================================================================

	const principalMap = new Map<string, { kind: string; caps: ReadonlySet<string> }>();

	for (const p of principals) {
		// Reject empty/whitespace IDs
		if (!p.principalId || p.principalId.trim().length === 0) {
			throw new Error(`INVALID_TRUSTED_PRINCIPAL: empty principalId`);
		}

		// Reject unknown kinds
		if (!VALID_PRINCIPAL_KINDS.has(p.principalKind)) {
			throw new Error(`INVALID_TRUSTED_PRINCIPAL: unknown kind "${p.principalKind}" for "${p.principalId}"`);
		}

		// Reject unknown capabilities
		for (const cap of p.capabilities) {
			if (!ALL_CAPABILITIES.has(cap)) {
				throw new Error(`INVALID_TRUSTED_CAPABILITY: unknown capability "${cap}" for "${p.principalId}"`);
			}
		}

		const key = `${p.principalId}:${p.principalKind}`;

		// Reject duplicate exact tuples
		if (principalMap.has(key)) {
			throw new Error(`DUPLICATE_TRUSTED_PRINCIPAL: "${key}" registered more than once`);
		}

		// Store immutable capability snapshot
		principalMap.set(
			key,
			Object.freeze({
				kind: p.principalKind,
				caps: new Set(p.capabilities),
			}),
		);
	}

	// =========================================================================
	// Validate and build source grant lookup
	// =========================================================================

	const sourceGrantMap = new Map<string, TrustedEvidenceSourceGrant>();

	for (let gi = 0; gi < sourceGrants.length; gi++) {
		const grant = sourceGrants[gi];

		// Reject empty source IDs
		if (!grant.sourceId || grant.sourceId.trim().length === 0) {
			throw new Error("INVALID_SOURCE_GRANT: empty sourceId");
		}

		// Reject duplicate source IDs (preferred: one source ID → one grant)
		if (sourceGrantMap.has(grant.sourceId)) {
			throw new Error(`DUPLICATE_SOURCE_GRANT: source "${grant.sourceId}" has conflicting grants`);
		}

		// Reject unknown principal tuple references
		const principalKey = `${grant.principalId}:${grant.principalKind}`;
		const principal = principalMap.get(principalKey);
		if (!principal) {
			throw new Error(
				`INVALID_SOURCE_GRANT: source "${grant.sourceId}" references unknown principal "${principalKey}"`,
			);
		}

		// Reject non-evidence capabilities on sources
		if (!EVIDENCE_CAPABILITIES.has(grant.capability)) {
			throw new Error(
				`INVALID_SOURCE_GRANT: source "${grant.sourceId}" has non-evidence capability "${grant.capability}"`,
			);
		}

		// Reject empty allowedEvidenceTypes
		if (!grant.allowedEvidenceTypes || grant.allowedEvidenceTypes.length === 0) {
			throw new Error(`INVALID_SOURCE_GRANT: source "${grant.sourceId}" has empty allowedEvidenceTypes`);
		}

		// Reject duplicate values inside arrays
		const evidenceTypes = new Set(grant.allowedEvidenceTypes);
		if (evidenceTypes.size !== grant.allowedEvidenceTypes.length) {
			throw new Error(`INVALID_SOURCE_GRANT: source "${grant.sourceId}" has duplicate evidence types`);
		}

		if (grant.allowedCollectorClasses) {
			const collectorSet = new Set(grant.allowedCollectorClasses);
			if (collectorSet.size !== grant.allowedCollectorClasses.length) {
				throw new Error(`INVALID_SOURCE_GRANT: source "${grant.sourceId}" has duplicate collector classes`);
			}
		}

		// =====================================================================
		// Validate allowedRequirementIds against the contract
		// =====================================================================
		if (grant.allowedRequirementIds) {
			const reqSeen = new Set<string>();
			for (let rj = 0; rj < grant.allowedRequirementIds.length; rj++) {
				const reqId = grant.allowedRequirementIds[rj];

				// Reject empty/whitespace
				if (!reqId || reqId.trim().length === 0) {
					throw new Error(`sourceGrants[${gi}].allowedRequirementIds[${rj}]: empty requirement ID reference`);
				}

				// Reject leading/trailing whitespace
				if (reqId !== reqId.trim()) {
					throw new Error(
						`sourceGrants[${gi}].allowedRequirementIds[${rj}]: requirement ID has leading/trailing whitespace: "${reqId}"`,
					);
				}

				// Reject unknown references
				if (!requirementIds.has(reqId)) {
					throw new Error(
						`sourceGrants[${gi}].allowedRequirementIds[${rj}]: Unknown requirement id reference: ${reqId}`,
					);
				}

				// Reject duplicates
				if (reqSeen.has(reqId)) {
					throw new Error(
						`sourceGrants[${gi}].allowedRequirementIds[${rj}]: duplicate requirement ID reference: ${reqId}`,
					);
				}
				reqSeen.add(reqId);
			}

			// Additional: reject duplicate requirement IDs via Set check (handled above)
		}

		// =====================================================================
		// Validate allowedCriterionIds against the global criterion registry
		// =====================================================================
		if (grant.allowedCriterionIds) {
			const critSeen = new Set<string>();
			for (let cj = 0; cj < grant.allowedCriterionIds.length; cj++) {
				const critId = grant.allowedCriterionIds[cj];

				// Reject empty criterion IDs
				if (critId.length === 0) {
					throw new Error(`sourceGrants[${gi}].allowedCriterionIds[${cj}]: empty criterion ID reference`);
				}

				// Reject whitespace-only criterion IDs
				if (critId.trim().length === 0) {
					throw new Error(
						`sourceGrants[${gi}].allowedCriterionIds[${cj}]: whitespace-only criterion ID reference`,
					);
				}

				// Reject leading/trailing whitespace
				if (critId !== critId.trim()) {
					throw new Error(
						`sourceGrants[${gi}].allowedCriterionIds[${cj}]: criterion ID has leading/trailing whitespace: "${critId}"`,
					);
				}

				// Reject unknown criterion references
				if (!globalCriterionIds.has(critId)) {
					throw new Error(
						`sourceGrants[${gi}].allowedCriterionIds[${cj}]: Unknown acceptance criterion id reference: ${critId}`,
					);
				}

				// Reject duplicates
				if (critSeen.has(critId)) {
					throw new Error(
						`sourceGrants[${gi}].allowedCriterionIds[${cj}]: duplicate criterion ID reference: ${critId}`,
					);
				}
				critSeen.add(critId);
			}

			// =================================================================
			// Cross-scope coherence: when both allowedRequirementIds and
			// allowedCriterionIds are declared, every criterion must belong
			// to one of the allowed requirements.
			// =================================================================
			if (grant.allowedRequirementIds && grant.allowedRequirementIds.length > 0) {
				const allowedReqSet = new Set(grant.allowedRequirementIds);
				for (const critId of grant.allowedCriterionIds) {
					const owningReq = criterionToRequirement.get(critId);
					if (owningReq && !allowedReqSet.has(owningReq)) {
						throw new Error(
							`sourceGrants[${gi}]: criterion "${critId}" belongs to requirement "${owningReq}" which is not in the allowedRequirementIds`,
						);
					}
				}
			}
		}

		const frozenGrant: TrustedEvidenceSourceGrant = Object.freeze({
			...grant,
			allowedEvidenceTypes: Object.freeze([...grant.allowedEvidenceTypes]),
			allowedCollectorClasses:
				grant.allowedCollectorClasses === undefined ? undefined : Object.freeze([...grant.allowedCollectorClasses]),
			allowedRequirementIds:
				grant.allowedRequirementIds === undefined ? undefined : Object.freeze([...grant.allowedRequirementIds]),
			allowedCriterionIds:
				grant.allowedCriterionIds === undefined ? undefined : Object.freeze([...grant.allowedCriterionIds]),
		});
		sourceGrantMap.set(frozenGrant.sourceId, frozenGrant);
	}

	// =========================================================================
	// Build frozen context
	// =========================================================================

	const ctx: TrustedValidationContext = Object.freeze({
		verifyPrincipal(principalId: string, principalKind: string): boolean {
			const key = `${principalId}:${principalKind}`;
			return principalMap.has(key);
		},

		verifyCapability(principalId: string, principalKind: string, capability: string): boolean {
			// Exact tuple match only — no cross-kind borrowing
			const key = `${principalId}:${principalKind}`;
			const entry = principalMap.get(key);
			if (!entry) return false;
			return entry.caps.has(capability);
		},

		verifyEvidenceSource(request: EvidenceSourceVerificationRequest): boolean {
			// Source must exist
			const grant = sourceGrantMap.get(request.sourceId);
			if (!grant) return false;

			// Source must belong to the acting principal tuple
			if (grant.principalId !== request.principalId) return false;
			if (grant.principalKind !== request.principalKind) return false;

			// Source grant capability must match
			if (grant.capability !== request.capability) return false;

			// Evidence type must be allowed
			if (!grant.allowedEvidenceTypes.includes(request.evidenceType)) return false;

			// Collector class must be allowed when constrained
			if (
				grant.allowedCollectorClasses &&
				request.collectorClass &&
				!grant.allowedCollectorClasses.includes(request.collectorClass)
			) {
				return false;
			}

			// Requirement restrictions when declared
			if (grant.allowedRequirementIds && request.requirementIds.length > 0) {
				for (const reqId of request.requirementIds) {
					if (!grant.allowedRequirementIds.includes(reqId)) return false;
				}
			}

			// Criterion restrictions when declared
			if (grant.allowedCriterionIds && request.criterionIds.length > 0) {
				for (const critId of request.criterionIds) {
					if (!grant.allowedCriterionIds.includes(critId)) return false;
				}
			}

			return true;
		},
	});

	// =========================================================================
	// Phase final: Brand context AND bind to contract digest
	// Only after every validation gate passes.
	// =========================================================================

	_contractDigestMap.set(ctx, contractDigest);
	_trustedValidationContextSet.add(ctx);
	return ctx;
}

/**
 * Retrieve the contract digest bound to a TrustedValidationContext.
 *
 * Returns undefined when the object is not a genuine trusted context.
 * This is an internal function — not exposed through the public API index.
 */
export function _getBoundContractDigest(ctx: TrustedValidationContext): string | undefined {
	return _contractDigestMap.get(ctx);
}

// =============================================================================
// Capability check helpers
// =============================================================================

export function contextHasCapability(ctx: TrustedLedgerMutationContext, capability: LedgerCapability): boolean {
	return ctx.capabilities.has(capability);
}

export function contextHasAnyCapability(ctx: TrustedLedgerMutationContext, capabilities: LedgerCapability[]): boolean {
	return capabilities.some((c) => ctx.capabilities.has(c));
}

// =============================================================================
// Evidence capability to authority classification mapping
// =============================================================================

export function capabilityToAuthority(capability: LedgerCapability): EvidenceAuthorityClassification | undefined {
	switch (capability) {
		case "evidence:repository-observation":
			return "repository-observation";
		case "evidence:command-result":
			return "command-result";
		case "evidence:test-result":
			return "test-result";
		case "evidence:runtime-observation":
			return "runtime-observation";
		case "evidence:operator-confirmation":
			return "operator-confirmation";
		case "evidence:trusted-collector":
			return "trusted-collector";
		default:
			return undefined;
	}
}

export function deriveEffectiveAuthority(
	ctx: TrustedLedgerMutationContext,
	evidenceType: string,
): EvidenceAuthorityClassification {
	const hasEvidenceCap =
		ctx.capabilities.has("evidence:test-result") ||
		ctx.capabilities.has("evidence:command-result") ||
		ctx.capabilities.has("evidence:repository-observation") ||
		ctx.capabilities.has("evidence:runtime-observation") ||
		ctx.capabilities.has("evidence:operator-confirmation") ||
		ctx.capabilities.has("evidence:trusted-collector");

	if (!hasEvidenceCap) {
		return "agent-claim";
	}

	const typeMap: Record<string, { cap: LedgerCapability; authority: EvidenceAuthorityClassification }> = {
		"test-result": { cap: "evidence:test-result", authority: "test-result" },
		"build-result": { cap: "evidence:command-result", authority: "command-result" },
		"command-result": { cap: "evidence:command-result", authority: "command-result" },
		"file-change": { cap: "evidence:repository-observation", authority: "repository-observation" },
		commit: { cap: "evidence:repository-observation", authority: "repository-observation" },
		"repository-state": { cap: "evidence:repository-observation", authority: "repository-observation" },
		"runtime-observation": { cap: "evidence:runtime-observation", authority: "runtime-observation" },
		"operator-confirmation": { cap: "evidence:operator-confirmation", authority: "operator-confirmation" },
		artifact: { cap: "evidence:trusted-collector", authority: "trusted-collector" },
	};

	const mapping = typeMap[evidenceType];
	if (mapping && ctx.capabilities.has(mapping.cap)) {
		return mapping.authority;
	}

	if (ctx.capabilities.has("evidence:trusted-collector")) {
		return "trusted-collector";
	}

	return "agent-claim";
}

// =============================================================================
// Source requirement helper — determines if a source is required
// =============================================================================

/**
 * Returns true when a non-empty source is required for the given evidence
 * and authority context. A missing/empty source must fail closed.
 */
export function isSourceRequiredForEvidence(params: {
	effectiveAuthority: EvidenceAuthorityClassification;
	contractAuthoritativeSources?: readonly EvidenceAuthorityClassification[];
	criterionRequiredEvidence?: {
		allowedTypes?: string[];
		minAuthority?: EvidenceAuthorityClassification;
		requiredCollectorClass?: string;
		minPassingStatus?: "pass";
	};
}): boolean {
	// Source is required when effective authority is a non-agent-claim type
	if (params.effectiveAuthority !== "agent-claim") return true;

	// Source is required when contract declares authoritative sources
	if (params.contractAuthoritativeSources && params.contractAuthoritativeSources.length > 0) {
		// The contract requires authoritative evidence types — if the evidence
		// type matches one of these, a source is required
		if (params.contractAuthoritativeSources.includes(params.effectiveAuthority)) {
			return true;
		}
	}

	// Source is required when criterion demands it (minAuthority, collector class)
	if (params.criterionRequiredEvidence) {
		if (
			params.criterionRequiredEvidence.minAuthority &&
			params.criterionRequiredEvidence.minAuthority !== "agent-claim"
		) {
			return true;
		}
		if (params.criterionRequiredEvidence.requiredCollectorClass) {
			return true;
		}
	}

	return false;
}
