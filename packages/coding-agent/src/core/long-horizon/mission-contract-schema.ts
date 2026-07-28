/**
 * Mission Contract v1 schema validation.
 *
 * Deterministic, fail-closed validation of MissionContractV1 documents.
 * Rejects duplicates, cycles, unknown refs, missing rationale, and
 * UNKNOWN SEMANTIC FIELDS.
 *
 * Only `metadata` may contain arbitrary unknown keys.
 */

import {
	ACCEPTANCE_CRITERION_KEYS,
	type AcceptanceCriterion,
	CONSTRAINT_KEYS,
	EVIDENCE_POLICY_KEYS,
	EVIDENCE_POLICY_RULE_KEYS,
	EVIDENCE_REQUIREMENT_KEYS,
	FORBIDDEN_ACTION_KEYS,
	MAX_CONSTRAINT_ID_LENGTH,
	MAX_CRITERION_ID_LENGTH,
	MAX_FORBIDDEN_ACTION_ID_LENGTH,
	MAX_RATIONALE_LENGTH,
	MAX_REQUIREMENT_ID_LENGTH,
	MAX_REQUIREMENT_STATEMENT_LENGTH,
	MAX_WORKSTREAM_ID_LENGTH,
	MISSION_CONTRACT_TOP_LEVEL_KEYS,
	type MissionRequirement,
	type MissionWorkstream,
	REQUIREMENT_KEYS,
	type RequirementKind,
	type ValidationResult,
	WORKSTREAM_KEYS,
} from "./types.js";

// =============================================================================
// Maximum counts
// =============================================================================

const MAX_WORKSTREAMS = 200;
const MAX_REQUIREMENTS = 500;
const MAX_CONSTRAINTS = 200;
const MAX_FORBIDDEN_ACTIONS = 200;
const MAX_CRITERIA_PER_REQUIREMENT = 100;
const MAX_DEPENDENCIES_PER_REQUIREMENT = 50;
const MAX_EVIDENCE_RULES = 50;

export function validateMissionContract(input: unknown): ValidationResult {
	const errors: string[] = [];

	if (input === null || input === undefined) {
		return { valid: false, errors: [{ path: "$", message: "Input must be a non-null object" }] };
	}

	if (typeof input !== "object") {
		return { valid: false, errors: [{ path: "$", message: "Input must be an object" }] };
	}

	const c = input as Record<string, unknown>;

	// =========================================================================
	// STRICT TOP-LEVEL KEY VALIDATION — rejects unknown semantic fields
	// Only `metadata` may contain arbitrary unknown keys.
	// =========================================================================
	for (const key of Object.keys(c)) {
		if (!MISSION_CONTRACT_TOP_LEVEL_KEYS.has(key)) {
			errors.push(`Unknown top-level field: "${key}"`);
		}
	}

	// contractVersion
	if (c.contractVersion !== 1) {
		errors.push("contractVersion must be 1");
	}

	// missionId
	if (typeof c.missionId !== "string" || c.missionId.length === 0) {
		errors.push("missionId must be a non-empty string");
	} else if (c.missionId !== c.missionId.trim()) {
		errors.push("missionId must not have leading/trailing whitespace");
	} else if (c.missionId.length > 128) {
		errors.push("missionId must not exceed 128 characters");
	}

	// revision
	if (
		typeof c.revision !== "number" ||
		!Number.isFinite(c.revision) ||
		c.revision < 0 ||
		!Number.isInteger(c.revision)
	) {
		errors.push("revision must be a non-negative integer");
	}

	// title
	if (typeof c.title !== "string" || c.title.length === 0) {
		errors.push("title must be a non-empty string");
	}

	// objective
	if (typeof c.objective !== "string") {
		errors.push("objective must be a string");
	}

	// metadata validation
	if (c.metadata !== undefined) {
		if (typeof c.metadata !== "object" || c.metadata === null || Array.isArray(c.metadata)) {
			errors.push("metadata must be an object when present");
		}
	}

	// Validate sub-objects
	const workstreamErrors = validateWorkstreams(c.workstreams);
	errors.push(...workstreamErrors);

	const workstreamIds = collectWorkstreamIds(c.workstreams);

	const requirementErrors = validateRequirements(c.requirements, workstreamIds);
	errors.push(...requirementErrors);

	const requirementIds = collectRequirementIds(c.requirements);

	// Validate cross-references between requirements and source refs
	errors.push(...validateRequirementSourceRefs(c.requirements, c.metadata as Record<string, unknown> | undefined));

	// =========================================================================
	// GLOBAL CRITERION ID REGISTRY — acceptance-criterion IDs are globally
	// unique across the entire Mission Contract, not just within a single
	// requirement. A criterion ID must identify exactly one criterion.
	// =========================================================================
	const { errors: globalCritErrors, globalCriterionIds } = validateGlobalCriterionIds(c.requirements);
	errors.push(...globalCritErrors);

	// =========================================================================
	// CRITERION REFERENCE VALIDATION — validate every criterion ID reference
	// in the contract against the global criterion registry.
	// =========================================================================
	const refErrors = validateCriterionReferences(c, globalCriterionIds);
	errors.push(...refErrors);

	// Validate constraint IDs
	const constraintErrors = validateConstraints(c.constraints);
	errors.push(...constraintErrors);

	// Validate forbidden action IDs
	const forbiddenErrors = validateForbiddenActions(c.forbiddenActions);
	errors.push(...forbiddenErrors);

	// Validate evidence policy
	const policyErrors = validateEvidencePolicy(c.evidencePolicy, requirementIds);
	errors.push(...policyErrors);

	// Validate requirement dependency DAG
	if (Array.isArray(c.requirements)) {
		errors.push(...validateRequirementDAG(c.requirements as MissionRequirement[]));
	}

	const valid = errors.length === 0;
	return {
		valid,
		errors: errors.map((message) => ({ path: "$", message })),
	};
}

// =============================================================================
// Workstreams
// =============================================================================

function collectWorkstreamIds(workstreams: unknown): Set<string> {
	const ids = new Set<string>();
	if (Array.isArray(workstreams)) {
		for (const ws of workstreams) {
			if (ws && typeof ws === "object" && typeof (ws as Record<string, unknown>).id === "string") {
				ids.add((ws as Record<string, unknown>).id as string);
			}
		}
	}
	return ids;
}

function collectRequirementIds(requirements: unknown): Set<string> {
	const ids = new Set<string>();
	if (Array.isArray(requirements)) {
		for (const r of requirements) {
			if (r && typeof r === "object" && typeof (r as Record<string, unknown>).id === "string") {
				ids.add((r as Record<string, unknown>).id as string);
			}
		}
	}
	return ids;
}

function validateStringField(
	value: unknown,
	name: string,
	maxLength: number,
	prefix: string,
	errors: string[],
	allowEmpty: boolean = false,
): void {
	if (typeof value !== "string") {
		errors.push(`${prefix}.${name} must be a string`);
		return;
	}
	if (!allowEmpty && value.length === 0) {
		errors.push(`${prefix}.${name} must be non-empty`);
	}
	if (value !== value.trim()) {
		errors.push(`${prefix}.${name} must not have leading/trailing whitespace`);
	}
	if (value.length > maxLength) {
		errors.push(`${prefix}.${name} exceeds maximum length of ${maxLength}`);
	}
}

function validateIntegerField(value: unknown, name: string, min: number, prefix: string, errors: string[]): void {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
		errors.push(`${prefix}.${name} must be a finite integer`);
		return;
	}
	if (value < min) {
		errors.push(`${prefix}.${name} must be >= ${min}`);
	}
}

function checkUnknownFields(
	obj: Record<string, unknown>,
	allowedKeys: ReadonlySet<string>,
	prefix: string,
	errors: string[],
): void {
	for (const key of Object.keys(obj)) {
		if (!allowedKeys.has(key)) {
			errors.push(`${prefix}: unknown field "${key}"`);
		}
	}
}

function validateWorkstreams(workstreams: unknown): string[] {
	const errors: string[] = [];

	if (!Array.isArray(workstreams)) {
		errors.push("workstreams must be an array");
		return errors;
	}

	if (workstreams.length === 0) {
		errors.push("workstreams must contain at least one workstream");
		return errors;
	}

	if (workstreams.length > MAX_WORKSTREAMS) {
		errors.push(`workstreams must not exceed ${MAX_WORKSTREAMS} entries`);
	}

	const ids = new Set<string>();
	const workstreamsTyped: MissionWorkstream[] = [];

	for (let i = 0; i < workstreams.length; i++) {
		const ws = workstreams[i];
		const prefix = `workstreams[${i}]`;
		if (!ws || typeof ws !== "object") {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		const w = ws as Record<string, unknown>;

		// Strict unknown field check
		checkUnknownFields(w, WORKSTREAM_KEYS, prefix, errors);

		validateStringField(w.id, "id", MAX_WORKSTREAM_ID_LENGTH, prefix, errors);
		validateStringField(w.title, "title", 256, prefix, errors);
		if (w.description !== undefined && typeof w.description !== "string") {
			errors.push(`${prefix}.description must be a string`);
		}
		if (w.parentId !== undefined) {
			if (typeof w.parentId !== "string") {
				errors.push(`${prefix}.parentId must be a string`);
			} else if (w.parentId !== w.parentId.trim()) {
				errors.push(`${prefix}.parentId must not have leading/trailing whitespace`);
			}
		}
		if (w.order !== undefined) {
			validateIntegerField(w.order, "order", 0, prefix, errors);
		}

		// Duplicate check
		if (typeof w.id === "string") {
			if (ids.has(w.id)) {
				errors.push(`Duplicate workstream id: ${w.id}`);
			} else {
				ids.add(w.id);
			}
		}

		workstreamsTyped.push({
			id: w.id as string,
			title: w.title as string,
			description: w.description as string | undefined,
			parentId: w.parentId as string | undefined,
			order: w.order as number | undefined,
		});
	}

	// Validate parent references (after all IDs collected)
	for (let i = 0; i < workstreamsTyped.length; i++) {
		const ws = workstreamsTyped[i];
		const prefix = `workstreams[${i}]`;
		if (ws.parentId !== undefined) {
			if (!ids.has(ws.parentId)) {
				errors.push(`${prefix}.parentId references unknown workstream: ${ws.parentId}`);
			}
			if (ws.parentId === ws.id) {
				errors.push(`${prefix}.parentId cannot reference itself`);
			}
		}
	}

	// Validate workstream hierarchy is acyclic
	errors.push(...validateWorkstreamDAG(workstreamsTyped));

	return errors;
}

function validateWorkstreamDAG(workstreams: MissionWorkstream[]): string[] {
	const errors: string[] = [];

	const adjacency = new Map<string, string[]>();
	const inDegree = new Map<string, number>();

	for (const ws of workstreams) {
		adjacency.set(ws.id, []);
		inDegree.set(ws.id, 0);
	}

	for (const ws of workstreams) {
		if (ws.parentId) {
			const children = adjacency.get(ws.parentId);
			if (children) {
				children.push(ws.id);
				inDegree.set(ws.id, (inDegree.get(ws.id) ?? 0) + 1);
			}
		}
	}

	// Kahn's algorithm
	const queue: string[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) queue.push(id);
	}

	let processed = 0;
	while (queue.length > 0) {
		const node = queue.shift()!;
		processed++;
		for (const child of adjacency.get(node) ?? []) {
			const deg = (inDegree.get(child) ?? 1) - 1;
			inDegree.set(child, deg);
			if (deg === 0) queue.push(child);
		}
	}

	if (processed < workstreams.length) {
		const cycleNodes = Array.from(inDegree.entries())
			.filter(([, deg]) => deg > 0)
			.map(([id]) => id);
		errors.push(`Workstream hierarchy cycle detected involving: ${cycleNodes.join(", ")}`);
	}

	return errors;
}

// =============================================================================
// Requirements
// =============================================================================

function validateRequirements(requirements: unknown, workstreamIds: Set<string>): string[] {
	const errors: string[] = [];

	if (!Array.isArray(requirements)) {
		errors.push("requirements must be an array");
		return errors;
	}

	if (requirements.length === 0) {
		errors.push("requirements must contain at least one requirement");
		return errors;
	}

	if (requirements.length > MAX_REQUIREMENTS) {
		errors.push(`requirements must not exceed ${MAX_REQUIREMENTS} entries`);
	}

	const ids = new Set<string>();
	const reqs: MissionRequirement[] = [];

	for (let i = 0; i < requirements.length; i++) {
		const r = requirements[i];
		const prefix = `requirements[${i}]`;
		if (!r || typeof r !== "object") {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		const req = r as Record<string, unknown>;

		// Strict unknown field check
		checkUnknownFields(req, REQUIREMENT_KEYS, prefix, errors);

		// id
		validateStringField(req.id, "id", MAX_REQUIREMENT_ID_LENGTH, prefix, errors);
		if (typeof req.id === "string") {
			if (ids.has(req.id)) {
				errors.push(`Duplicate requirement id: ${req.id}`);
			} else if (req.id.length > 0) {
				ids.add(req.id);
			}
		}

		// workstreamId
		validateStringField(req.workstreamId, "workstreamId", MAX_WORKSTREAM_ID_LENGTH, prefix, errors);
		if (typeof req.workstreamId === "string" && req.workstreamId.length > 0 && !workstreamIds.has(req.workstreamId)) {
			errors.push(`${prefix}.workstreamId references unknown workstream: ${req.workstreamId}`);
		}

		// kind
		const kind = req.kind;
		if (kind !== "EXPLICIT" && kind !== "INFERRED") {
			errors.push(`${prefix}.kind must be "EXPLICIT" or "INFERRED"`);
		}

		// EXPLICIT / INFERRED provenance
		if (kind === "INFERRED" && !req.rationale) {
			errors.push(`${prefix}: INFERRED requirement must include a rationale`);
		}

		// statement
		validateStringField(req.statement, "statement", MAX_REQUIREMENT_STATEMENT_LENGTH, prefix, errors);

		// rationale
		if (req.rationale !== undefined) {
			if (typeof req.rationale !== "string") {
				errors.push(`${prefix}.rationale must be a string`);
			} else if (req.rationale.length > MAX_RATIONALE_LENGTH) {
				errors.push(`${prefix}.rationale exceeds maximum length of ${MAX_RATIONALE_LENGTH}`);
			}
		}

		// sourceRefs
		if (!Array.isArray(req.sourceRefs)) {
			errors.push(`${prefix}.sourceRefs must be an array`);
		} else {
			for (let j = 0; j < req.sourceRefs.length; j++) {
				if (typeof req.sourceRefs[j] !== "string") {
					errors.push(`${prefix}.sourceRefs[${j}] must be a string`);
				}
			}
		}

		// dependencies
		if (!Array.isArray(req.dependencies)) {
			errors.push(`${prefix}.dependencies must be an array`);
		} else if (req.dependencies.length > MAX_DEPENDENCIES_PER_REQUIREMENT) {
			errors.push(`${prefix}.dependencies must not exceed ${MAX_DEPENDENCIES_PER_REQUIREMENT}`);
		} else {
			const depSet = new Set<string>();
			for (let j = 0; j < req.dependencies.length; j++) {
				if (typeof req.dependencies[j] !== "string") {
					errors.push(`${prefix}.dependencies[${j}] must be a string`);
				} else {
					if (depSet.has(req.dependencies[j])) {
						errors.push(`${prefix}.dependencies contains duplicate: ${req.dependencies[j]}`);
					}
					depSet.add(req.dependencies[j]);
				}
			}
		}

		// acceptanceCriteria
		errors.push(...validateAcceptanceCriteria(req.acceptanceCriteria, req.workstreamId, req.kind, prefix));

		// initialApplicability
		if (req.initialApplicability !== undefined) {
			if (req.initialApplicability !== "APPLICABLE" && req.initialApplicability !== "NOT_APPLICABLE") {
				errors.push(`${prefix}.initialApplicability must be "APPLICABLE" or "NOT_APPLICABLE"`);
			}
			if (req.initialApplicability === "NOT_APPLICABLE" && !req.rationale) {
				errors.push(`${prefix}: NOT_APPLICABLE initial applicability must have rationale`);
			}
		}

		reqs.push({
			id: req.id as string,
			workstreamId: req.workstreamId as string,
			kind: kind as RequirementKind,
			statement: req.statement as string,
			rationale: req.rationale as string | undefined,
			sourceRefs: (req.sourceRefs as string[]) ?? [],
			dependencies: (req.dependencies as string[]) ?? [],
			acceptanceCriteria: (req.acceptanceCriteria as AcceptanceCriterion[]) ?? [],
			initialApplicability: req.initialApplicability as "APPLICABLE" | "NOT_APPLICABLE" | undefined,
		});
	}

	// Validate cross-requirement references after all IDs collected
	for (let i = 0; i < reqs.length; i++) {
		const req = reqs[i];
		const prefix = `requirements[${i}]`;
		for (const depId of req.dependencies) {
			if (!ids.has(depId)) {
				errors.push(`${prefix}.dependencies references unknown requirement: ${depId}`);
			}
			if (depId === req.id) {
				errors.push(`${prefix}.dependencies cannot reference itself`);
			}
		}
	}

	return errors;
}

function validateRequirementSourceRefs(
	requirements: unknown,
	_metadata: Record<string, unknown> | undefined,
): string[] {
	const errors: string[] = [];
	if (!Array.isArray(requirements)) return errors;

	// If contract has enumerated source entries in metadata, validate refs
	// For now we just check sourceRefs are strings (handled above)
	return errors;
}

// =============================================================================
// Acceptance Criteria
// =============================================================================

function validateAcceptanceCriteria(
	criteria: unknown,
	_workstreamId: unknown,
	kind: unknown,
	prefix: string,
): string[] {
	const errors: string[] = [];

	if (!Array.isArray(criteria)) {
		errors.push(`${prefix}.acceptanceCriteria must be an array`);
		return errors;
	}

	if (criteria.length > MAX_CRITERIA_PER_REQUIREMENT) {
		errors.push(`${prefix}.acceptanceCriteria must not exceed ${MAX_CRITERIA_PER_REQUIREMENT}`);
	}

	const ids = new Set<string>();

	for (let j = 0; j < criteria.length; j++) {
		const c = criteria[j];
		const critPrefix = `${prefix}.acceptanceCriteria[${j}]`;
		if (!c || typeof c !== "object") {
			errors.push(`${critPrefix} must be an object`);
			continue;
		}
		const crit = c as Record<string, unknown>;

		// Strict unknown field check
		checkUnknownFields(crit, ACCEPTANCE_CRITERION_KEYS, critPrefix, errors);

		validateStringField(crit.id, "id", MAX_CRITERION_ID_LENGTH, critPrefix, errors);
		if (typeof crit.id === "string" && crit.id.length > 0) {
			if (ids.has(crit.id)) {
				errors.push(`Duplicate acceptance criterion id: ${crit.id}`);
			} else {
				ids.add(crit.id);
			}
		}

		validateStringField(crit.statement, "statement", 2048, critPrefix, errors);

		// requiredEvidence
		if (!Array.isArray(crit.requiredEvidence)) {
			errors.push(`${critPrefix}.requiredEvidence must be an array`);
		} else {
			if (crit.requiredEvidence.length === 0 && kind === "EXPLICIT") {
				// A criterion with no evidence is only valid if classified as operator judgment
				// For now we allow it but warn in documentation
			}
			for (let k = 0; k < crit.requiredEvidence.length; k++) {
				const evReq = crit.requiredEvidence[k];
				const evPrefix = `${critPrefix}.requiredEvidence[${k}]`;
				if (!evReq || typeof evReq !== "object") {
					errors.push(`${evPrefix} must be an object`);
					continue;
				}
				const ev = evReq as Record<string, unknown>;

				// Strict unknown field check
				checkUnknownFields(ev, EVIDENCE_REQUIREMENT_KEYS, evPrefix, errors);

				if (ev.allowedTypes !== undefined && !Array.isArray(ev.allowedTypes)) {
					errors.push(`${evPrefix}.allowedTypes must be an array`);
				}
				if (ev.minAuthority !== undefined && typeof ev.minAuthority !== "string") {
					errors.push(`${evPrefix}.minAuthority must be a string`);
				}
				if (ev.requiredCollectorClass !== undefined && typeof ev.requiredCollectorClass !== "string") {
					errors.push(`${evPrefix}.requiredCollectorClass must be a string`);
				}
			}
		}
	}

	return errors;
}

// =============================================================================
// Constraints
// =============================================================================

function validateConstraints(constraints: unknown): string[] {
	const errors: string[] = [];

	if (!Array.isArray(constraints)) {
		errors.push("constraints must be an array");
		return errors;
	}

	if (constraints.length > MAX_CONSTRAINTS) {
		errors.push(`constraints must not exceed ${MAX_CONSTRAINTS} entries`);
	}

	const ids = new Set<string>();
	const validKinds = new Set(["REQUIRED", "LIMIT", "ENVIRONMENT", "PROCESS", "SECURITY", "COMPATIBILITY"]);

	for (let i = 0; i < constraints.length; i++) {
		const c = constraints[i];
		const prefix = `constraints[${i}]`;
		if (!c || typeof c !== "object") {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		const con = c as Record<string, unknown>;

		// Strict unknown field check
		checkUnknownFields(con, CONSTRAINT_KEYS, prefix, errors);

		validateStringField(con.id, "id", MAX_CONSTRAINT_ID_LENGTH, prefix, errors);
		if (typeof con.id === "string" && con.id.length > 0) {
			if (ids.has(con.id)) {
				errors.push(`Duplicate constraint id: ${con.id}`);
			} else {
				ids.add(con.id);
			}
		}

		if (typeof con.kind !== "string" || !validKinds.has(con.kind)) {
			errors.push(`${prefix}.kind must be one of: REQUIRED, LIMIT, ENVIRONMENT, PROCESS, SECURITY, COMPATIBILITY`);
		}

		validateStringField(con.statement, "statement", 2048, prefix, errors);

		if (!Array.isArray(con.sourceRefs)) {
			errors.push(`${prefix}.sourceRefs must be an array`);
		}

		if (con.severity !== "error" && con.severity !== "warning") {
			errors.push(`${prefix}.severity must be "error" or "warning"`);
		}
	}

	return errors;
}

// =============================================================================
// Forbidden Actions
// =============================================================================

function validateForbiddenActions(actions: unknown): string[] {
	const errors: string[] = [];

	if (!Array.isArray(actions)) {
		errors.push("forbiddenActions must be an array");
		return errors;
	}

	if (actions.length > MAX_FORBIDDEN_ACTIONS) {
		errors.push(`forbiddenActions must not exceed ${MAX_FORBIDDEN_ACTIONS} entries`);
	}

	const ids = new Set<string>();

	for (let i = 0; i < actions.length; i++) {
		const a = actions[i];
		const prefix = `forbiddenActions[${i}]`;
		if (!a || typeof a !== "object") {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		const fa = a as Record<string, unknown>;

		// Strict unknown field check
		checkUnknownFields(fa, FORBIDDEN_ACTION_KEYS, prefix, errors);

		validateStringField(fa.id, "id", MAX_FORBIDDEN_ACTION_ID_LENGTH, prefix, errors);
		if (typeof fa.id === "string" && fa.id.length > 0) {
			if (ids.has(fa.id)) {
				errors.push(`Duplicate forbidden action id: ${fa.id}`);
			} else {
				ids.add(fa.id);
			}
		}

		validateStringField(fa.statement, "statement", 2048, prefix, errors);

		if (!Array.isArray(fa.sourceRefs)) {
			errors.push(`${prefix}.sourceRefs must be an array`);
		}

		if (fa.severity !== "error" && fa.severity !== "warning") {
			errors.push(`${prefix}.severity must be "error" or "warning"`);
		}
	}

	return errors;
}

// =============================================================================
// Evidence Policy
// =============================================================================

function validateEvidencePolicy(policy: unknown, _requirementIds: Set<string>): string[] {
	const errors: string[] = [];

	if (!policy || typeof policy !== "object") {
		errors.push("evidencePolicy must be an object");
		return errors;
	}

	const p = policy as Record<string, unknown>;

	// Strict unknown field check
	checkUnknownFields(p, EVIDENCE_POLICY_KEYS, "evidencePolicy", errors);

	if (!Array.isArray(p.authoritativeSources)) {
		errors.push("evidencePolicy.authoritativeSources must be an array");
	}

	if (p.rules !== undefined) {
		if (!Array.isArray(p.rules)) {
			errors.push("evidencePolicy.rules must be an array");
		} else {
			if (p.rules.length > MAX_EVIDENCE_RULES) {
				errors.push(`evidencePolicy.rules must not exceed ${MAX_EVIDENCE_RULES} entries`);
			}
			const ruleIds = new Set<string>();
			for (let i = 0; i < p.rules.length; i++) {
				const rule = p.rules[i];
				const rulePrefix = `evidencePolicy.rules[${i}]`;
				if (!rule || typeof rule !== "object") {
					errors.push(`${rulePrefix} must be an object`);
					continue;
				}
				const r = rule as Record<string, unknown>;

				// Strict unknown field check
				checkUnknownFields(r, EVIDENCE_POLICY_RULE_KEYS, rulePrefix, errors);

				validateStringField(r.id, "id", MAX_CRITERION_ID_LENGTH, rulePrefix, errors);
				if (typeof r.id === "string" && r.id.length > 0) {
					if (ruleIds.has(r.id)) {
						errors.push(`Duplicate evidence policy rule id: ${r.id}`);
					} else {
						ruleIds.add(r.id);
					}
				}
			}
		}
	}

	return errors;
}

// =============================================================================
// Global Criterion ID validation — globally unique across all requirements
// =============================================================================

/**
 * Builds the global criterion ID registry and validates uniqueness.
 * Returns both duplicate errors and the set of all valid, non-empty criterion IDs.
 */
function validateGlobalCriterionIds(requirements: unknown): { errors: string[]; globalCriterionIds: Set<string> } {
	const errors: string[] = [];
	const globalCriterionIds = new Set<string>();

	if (!Array.isArray(requirements)) return { errors, globalCriterionIds };

	const globalIdMap = new Map<string, { reqIdx: number; critIdx: number }>();

	for (let i = 0; i < requirements.length; i++) {
		const r = requirements[i];
		if (!r || typeof r !== "object") continue;
		const req = r as Record<string, unknown>;
		const criteria = req.acceptanceCriteria;
		if (!Array.isArray(criteria)) continue;

		for (let j = 0; j < criteria.length; j++) {
			const c = criteria[j];
			if (!c || typeof c !== "object") continue;
			const crit = c as Record<string, unknown>;
			const critId = crit.id;

			// Empty or whitespace-only IDs are caught by per-criterion validation above.
			// We only register non-empty IDs here.
			if (typeof critId !== "string" || critId.length === 0) continue;

			globalCriterionIds.add(critId);

			const existing = globalIdMap.get(critId);
			if (existing) {
				errors.push(
					`Duplicate acceptance criterion id: ${critId}` +
						` (requirements[${existing.reqIdx}].acceptanceCriteria[${existing.critIdx}] and requirements[${i}].acceptanceCriteria[${j}])`,
				);
			} else {
				globalIdMap.set(critId, { reqIdx: i, critIdx: j });
			}
		}
	}

	return { errors, globalCriterionIds };
}

// =============================================================================
// Criterion Reference Validation — validate every criterion ID reference
// in the contract against the global criterion registry.
// =============================================================================

/**
 * Validates that every criterion ID reference in the Mission Contract
 * resolves to exactly one acceptance criterion in the global registry.
 *
 * This pass inspects all contract fields that reference criterion IDs:
 * - evidencePolicy.authoritativeSources[*] (EvidenceAuthorityClassification[] — no criterion IDs in v1)
 * - evidencePolicy.rules[*] (EvidencePolicyRule[] — no criterion IDs in v1)
 * - Any future fields with criterion references are checked here.
 *
 * v1: No contract fields reference criterion IDs beyond the acceptance criteria
 * themselves (which are the registry). This function is wired in for future
 * compatibility and to ensure the global registry is available for external
 * validation (e.g., trusted source grant criterion IDs).
 */
export function validateCriterionReferences(
	_contract: Record<string, unknown>,
	_globalCriterionIds: ReadonlySet<string>,
): string[] {
	const errors: string[] = [];

	// v1: The Mission Contract has no fields that reference criterion IDs
	// other than acceptanceCriteria[].id (which are the registry entries).
	// evidencePolicy.authoritativeSources is EvidenceAuthorityClassification[]
	// (flat strings like "test-result") — no criterion IDs.
	// evidencePolicy.rules[*] has no criterion ID fields.
	//
	// This function is intentionally wired but currently a no-op.
	// If future schema versions add criterion references to the contract,
	// validation logic goes here.
	void _contract;
	void _globalCriterionIds;

	return errors;
}

/**
 * Validates criterion IDs in external trusted evidence source grants
 * against the global criterion registry from the Mission Contract.
 *
 * Unlike the contract-level validateCriterionReferences (which inspects
 * contract fields), this validates TrustedEvidenceSourceGrant entries
 * used in createTrustedValidationContext.
 *
 * Returns deterministic, ordered errors with precise JSON paths.
 */
export function validateSourceGrantCriterionIds(
	grants: ReadonlyArray<{
		readonly sourceId: string;
		readonly allowedCriterionIds?: readonly string[];
	}>,
	globalCriterionIds: ReadonlySet<string>,
): string[] {
	const errors: string[] = [];

	for (let i = 0; i < grants.length; i++) {
		const grant = grants[i];
		if (!grant.allowedCriterionIds) continue;

		const seen = new Set<string>();

		for (let j = 0; j < grant.allowedCriterionIds.length; j++) {
			const critId = grant.allowedCriterionIds[j];

			// Empty criterion IDs rejected
			if (critId.length === 0) {
				errors.push(`sourceGrants[${i}].allowedCriterionIds[${j}]: empty criterion ID`);
				continue;
			}

			// Whitespace-only criterion IDs rejected
			if (critId.trim().length === 0) {
				errors.push(`sourceGrants[${i}].allowedCriterionIds[${j}]: whitespace-only criterion ID`);
				continue;
			}

			// Leading/trailing whitespace rejected
			if (critId !== critId.trim()) {
				errors.push(
					`sourceGrants[${i}].allowedCriterionIds[${j}]: criterion ID has leading/trailing whitespace: "${critId}"`,
				);
				continue;
			}

			// Unknown criterion reference
			if (!globalCriterionIds.has(critId)) {
				errors.push(
					`sourceGrants[${i}].allowedCriterionIds[${j}]: Unknown acceptance criterion id reference: ${critId}`,
				);
				continue;
			}

			// Duplicate detection (preferred: reject, not silently deduplicate)
			if (seen.has(critId)) {
				errors.push(`sourceGrants[${i}].allowedCriterionIds[${j}]: duplicate criterion ID reference: ${critId}`);
			} else {
				seen.add(critId);
			}
		}
	}

	return errors;
}

// =============================================================================
// Requirement Dependency DAG Validation
// =============================================================================

function validateRequirementDAG(requirements: MissionRequirement[]): string[] {
	const errors: string[] = [];

	const ids = new Set(requirements.map((r) => r.id));

	// Build graph
	const adjacency = new Map<string, string[]>();
	const inDegree = new Map<string, number>();

	for (const req of requirements) {
		adjacency.set(req.id, []);
		inDegree.set(req.id, 0);
	}

	for (const req of requirements) {
		for (const depId of req.dependencies) {
			// Skip unknown refs (already caught above)
			if (!ids.has(depId)) continue;
			// Edge: depId -> req.id (req depends on dep, so dep must come first)
			adjacency.get(depId)?.push(req.id);
			inDegree.set(req.id, (inDegree.get(req.id) ?? 0) + 1);
		}
	}

	// Kahn's
	const queue: string[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) queue.push(id);
	}

	let processed = 0;
	while (queue.length > 0) {
		const node = queue.shift()!;
		processed++;
		for (const neighbor of adjacency.get(node) ?? []) {
			const deg = (inDegree.get(neighbor) ?? 1) - 1;
			inDegree.set(neighbor, deg);
			if (deg === 0) queue.push(neighbor);
		}
	}

	if (processed < requirements.length) {
		const cycleNodes = Array.from(inDegree.entries())
			.filter(([, deg]) => deg > 0)
			.map(([id]) => id)
			.sort();
		if (cycleNodes.length === 2) {
			errors.push(`Dependency cycle detected: ${cycleNodes[0]} -> ${cycleNodes[1]} -> ${cycleNodes[0]}`);
		} else {
			errors.push(`Dependency cycle detected involving: ${cycleNodes.join(", ")}`);
		}
	}

	return errors;
}
