/**
 * Mapping between Reliability Kernel verification kinds and the durable
 * Long-Horizon evidence/authority model.
 *
 * This single table keeps the runtime evidence type, the ledger evidence type,
 * the evidence authority classification, and the required trusted capability in
 * agreement so that deterministic verification evidence is always authoritative
 * (never an agent claim) and always satisfies the criterion's requiredEvidence.
 */

import type {
	EvidenceAuthorityClassification,
	EvidenceCollectorType,
	EvidenceLedgerCapability,
	EvidenceRequirement,
} from "../long-horizon/index.js";
import type { VerificationKind } from "./types.js";

export interface LedgerEvidenceMapping {
	/** Ledger evidence `type` string (matches the ledger's authority derivation). */
	ledgerType: string;
	authority: EvidenceAuthorityClassification;
	capability: EvidenceLedgerCapability;
	collector: EvidenceCollectorType;
}

/**
 * Trusted evidence source ids must be unique per grant (one source id → one
 * grant). We derive a stable, authority-scoped source id for runtime evidence.
 */
export function runtimeSourceId(authority: EvidenceAuthorityClassification): string {
	return `runtime:${authority}`;
}

export const VERIFICATION_EVIDENCE_MAP: Record<VerificationKind, LedgerEvidenceMapping> = {
	command: {
		ledgerType: "command-result",
		authority: "command-result",
		capability: "evidence:command-result",
		collector: "build-system",
	},
	test: {
		ledgerType: "test-result",
		authority: "test-result",
		capability: "evidence:test-result",
		collector: "test-runner",
	},
	build: {
		ledgerType: "build-result",
		authority: "command-result",
		capability: "evidence:command-result",
		collector: "build-system",
	},
	lint: {
		ledgerType: "runtime-observation",
		authority: "runtime-observation",
		capability: "evidence:runtime-observation",
		collector: "trusted-collector",
	},
	typecheck: {
		ledgerType: "runtime-observation",
		authority: "runtime-observation",
		capability: "evidence:runtime-observation",
		collector: "trusted-collector",
	},
	file_exists: {
		ledgerType: "file-change",
		authority: "repository-observation",
		capability: "evidence:repository-observation",
		collector: "repository-scanner",
	},
	file_absent: {
		ledgerType: "file-change",
		authority: "repository-observation",
		capability: "evidence:repository-observation",
		collector: "repository-scanner",
	},
	file_contains: {
		ledgerType: "file-change",
		authority: "repository-observation",
		capability: "evidence:repository-observation",
		collector: "repository-scanner",
	},
	search_no_matches: {
		ledgerType: "repository-state",
		authority: "repository-observation",
		capability: "evidence:repository-observation",
		collector: "repository-scanner",
	},
	git_diff_scope: {
		ledgerType: "file-change",
		authority: "repository-observation",
		capability: "evidence:repository-observation",
		collector: "repository-scanner",
	},
};

/**
 * Derive the durable ledger `requiredEvidence` for a verification kind. This is
 * what makes a criterion satisfiable only by authoritative, matching evidence.
 */
export function evidenceRequirementForKind(kind: VerificationKind): EvidenceRequirement[] {
	const mapping = VERIFICATION_EVIDENCE_MAP[kind];
	return [
		{
			allowedTypes: [mapping.ledgerType],
			minAuthority: mapping.authority,
			minPassingStatus: "pass",
		},
	];
}
