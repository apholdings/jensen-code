/**
 * Deterministic SHA-256 contract digest.
 *
 * Computes a cryptographic hash of a MissionContractV1 for
 * binding the Requirement Ledger to an exact contract revision.
 *
 * The digest covers every semantically relevant contract field.
 * Metadata is excluded from the digest (by default).
 */

import { createHash } from "crypto";
import { toCanonicalJson } from "./canonical-json.js";
import type { MissionContractV1 } from "./types.js";

/**
 * Compute a deterministic SHA-256 digest of a mission contract.
 *
 * Returns a lowercase hexadecimal string.
 */
export function computeMissionContractDigest(contract: MissionContractV1): string {
	// Build a canonicalized representation of the contract,
	// excluding metadata (which is non-semantic).
	const canonical = canonicalizeContract(contract);
	const json = toCanonicalJson(canonical);

	const hash = createHash("sha256");
	hash.update(json, "utf-8");
	return hash.digest("hex");
}

/**
 * Produce a canonical contract representation for hashing.
 * Excludes metadata and normalizes field ordering.
 */
function canonicalizeContract(contract: MissionContractV1): unknown {
	return {
		contractVersion: contract.contractVersion,
		missionId: contract.missionId,
		revision: contract.revision,
		title: contract.title,
		objective: contract.objective,
		workstreams: contract.workstreams.map(canonicalizeWorkstream),
		requirements: contract.requirements.map(canonicalizeRequirement),
		constraints: contract.constraints.map(canonicalizeConstraint),
		forbiddenActions: contract.forbiddenActions.map(canonicalizeForbiddenAction),
		evidencePolicy: canonicalizeEvidencePolicy(contract.evidencePolicy),
	};
}

function canonicalizeWorkstream(ws: {
	id: string;
	title: string;
	description?: string;
	parentId?: string;
	order?: number;
}): unknown {
	const result: Record<string, unknown> = { id: ws.id, title: ws.title };
	if (ws.description !== undefined) result.description = ws.description;
	if (ws.parentId !== undefined) result.parentId = ws.parentId;
	if (ws.order !== undefined) result.order = ws.order;
	return result;
}

function canonicalizeRequirement(req: {
	id: string;
	workstreamId: string;
	kind: "EXPLICIT" | "INFERRED";
	statement: string;
	rationale?: string;
	sourceRefs: string[];
	dependencies: string[];
	acceptanceCriteria: Array<{
		id: string;
		statement: string;
		requiredEvidence: Array<{
			allowedTypes?: string[];
			minAuthority?: string;
			requiredCollectorClass?: string;
			minPassingStatus?: string;
		}>;
	}>;
	initialApplicability?: string;
}): unknown {
	const result: Record<string, unknown> = {
		id: req.id,
		workstreamId: req.workstreamId,
		kind: req.kind,
		statement: req.statement,
		sourceRefs: [...req.sourceRefs].sort(),
		dependencies: [...req.dependencies].sort(),
		acceptanceCriteria: req.acceptanceCriteria.map(canonicalizeCriterion),
	};
	if (req.rationale !== undefined) result.rationale = req.rationale;
	if (req.initialApplicability !== undefined) result.initialApplicability = req.initialApplicability;
	return result;
}

function canonicalizeCriterion(crit: {
	id: string;
	statement: string;
	requiredEvidence: Array<{
		allowedTypes?: string[];
		minAuthority?: string;
		requiredCollectorClass?: string;
		minPassingStatus?: string;
	}>;
}): unknown {
	return {
		id: crit.id,
		statement: crit.statement,
		requiredEvidence: crit.requiredEvidence.map(canonicalizeEvidenceRequirement),
	};
}

function canonicalizeEvidenceRequirement(evReq: {
	allowedTypes?: string[];
	minAuthority?: string;
	requiredCollectorClass?: string;
	minPassingStatus?: string;
}): unknown {
	const result: Record<string, unknown> = {};
	if (evReq.allowedTypes !== undefined && evReq.allowedTypes.length > 0) {
		result.allowedTypes = [...evReq.allowedTypes].sort();
	}
	if (evReq.minAuthority !== undefined) result.minAuthority = evReq.minAuthority;
	if (evReq.requiredCollectorClass !== undefined) result.requiredCollectorClass = evReq.requiredCollectorClass;
	if (evReq.minPassingStatus !== undefined) result.minPassingStatus = evReq.minPassingStatus;
	return result;
}

function canonicalizeConstraint(con: {
	id: string;
	kind: string;
	statement: string;
	sourceRefs: string[];
	severity: string;
}): unknown {
	return {
		id: con.id,
		kind: con.kind,
		statement: con.statement,
		sourceRefs: [...con.sourceRefs].sort(),
		severity: con.severity,
	};
}

function canonicalizeForbiddenAction(fa: {
	id: string;
	statement: string;
	sourceRefs: string[];
	severity: string;
	matchHint?: string;
}): unknown {
	const result: Record<string, unknown> = {
		id: fa.id,
		statement: fa.statement,
		sourceRefs: [...fa.sourceRefs].sort(),
		severity: fa.severity,
	};
	if (fa.matchHint !== undefined) result.matchHint = fa.matchHint;
	return result;
}

function canonicalizeEvidencePolicy(policy: {
	authoritativeSources: string[];
	rules?: Array<{
		id: string;
		description: string;
		allowedTypes?: string[];
		minAuthority?: string;
		requiredCollectorClass?: string;
	}>;
}): unknown {
	const result: Record<string, unknown> = {
		authoritativeSources: [...policy.authoritativeSources].sort(),
	};
	if (policy.rules && policy.rules.length > 0) {
		result.rules = policy.rules.map((r) => canonicalizePolicyRule(r));
	}
	return result;
}

function canonicalizePolicyRule(rule: {
	id: string;
	description: string;
	allowedTypes?: string[];
	minAuthority?: string;
	requiredCollectorClass?: string;
}): unknown {
	const result: Record<string, unknown> = { id: rule.id, description: rule.description };
	if (rule.allowedTypes !== undefined && rule.allowedTypes.length > 0) {
		result.allowedTypes = [...rule.allowedTypes].sort();
	}
	if (rule.minAuthority !== undefined) result.minAuthority = rule.minAuthority;
	if (rule.requiredCollectorClass !== undefined) result.requiredCollectorClass = rule.requiredCollectorClass;
	return result;
}
