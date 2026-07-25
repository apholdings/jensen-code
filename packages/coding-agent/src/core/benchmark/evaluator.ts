/**
 * Deterministic long-horizon benchmark evaluator.
 *
 * Fail-closed: missing information never defaults to success.
 * No model inference, no provider calls.
 *
 * ## Trust Boundary
 *
 * The deterministic evaluator validates the semantics of a benchmark run report.
 * It does not cryptographically authenticate JSON.
 *
 * Run reports intended for authoritative benchmarking must be produced by a trusted
 * collector that records tool, repository, test and operator evidence independently
 * of the evaluated agent.
 *
 * Agent-authored claims remain non-authoritative regardless of any boolean supplied
 * in the run report. The run report's `authoritative` field is advisory input, not
 * sufficient authority by itself.
 *
 * The evaluator cannot detect fabricated non-claim evidence without a trusted collector.
 */

import {
	type BenchmarkEvaluationResult,
	type BenchmarkEvidence,
	type BenchmarkFinding,
	type BenchmarkMetrics,
	type BenchmarkRequirement,
	type CompletionGateResult,
	type EvaluatedRequirement,
	type EvidenceRequirement,
	type ForbiddenActionCategory,
	LONG_HORIZON_RUN_REPORT_SCHEMA_VERSION,
	LONG_HORIZON_SCHEMA_VERSION,
	type LongHorizonBenchmarkManifest,
	type LongHorizonRunReport,
	type LongHorizonStopReason,
	type ReportedUsage,
	type SchemaValidationResult,
} from "./types.js";

// =============================================================================
// Trust-Boundary Authority Policy
// =============================================================================

/**
 * Evaluator-owned authority policy — the single canonical check for whether
 * evidence is authoritative and passing for a given requirement.
 *
 * Rules:
 * 1. Claim evidence is ALWAYS non-authoritative (self-authored).
 * 2. For non-claim evidence, authority requires: authoritative=true, status=pass,
 *    and the evidence references the exact requirement being evaluated.
 * 3. Failing or unknown-status evidence cannot satisfy anything.
 */
function isAuthoritativePassingEvidence(
	evidence: { type: string; authoritative: boolean; status?: string; requirementIds?: string[] },
	requirementId: string,
): boolean {
	// Claim evidence is never authoritative
	if (evidence.type === "claim") return false;

	// Must be marked authoritative with pass status
	if (!evidence.authoritative) return false;
	if (evidence.status !== "pass") return false;

	// Must reference the exact requirement being evaluated
	if (evidence.requirementIds && !evidence.requirementIds.includes(requirementId)) return false;

	return true;
}

/**
 * Check whether operator-confirmation evidence is permitted for a requirement.
 * Operator confirmation may be authoritative only when the manifest permits or
 * requires operator-confirmation for that specific requirement.
 */
function isOperatorConfirmationPermitted(evidence: { type: string }, req: BenchmarkRequirement): boolean {
	if (evidence.type !== "operator-confirmation") return true; // other types are fine
	// operator-confirmation only permitted when manifest requires it
	return req.requiredEvidence?.some((ev) => ev.type === "operator-confirmation") ?? false;
}

// =============================================================================
// Entry Point
// =============================================================================

const MAX_REQUIREMENTS = 500;
const MAX_EVIDENCE = 5000;

export function evaluate(
	manifest: LongHorizonBenchmarkManifest,
	runReport: LongHorizonRunReport,
): BenchmarkEvaluationResult {
	const schemaValidation = validateSchemas(manifest, runReport);

	if (!schemaValidation.valid) {
		return makeSchemaFailedResult(manifest, runReport, schemaValidation);
	}

	const findings: BenchmarkFinding[] = [];
	const evaluatedRequirements = new Map<string, EvaluatedRequirement>();
	const evidenceById = indexEvidence(runReport);

	// 1. Evaluate each manifest requirement against run report
	evaluateRequirements(manifest, runReport, evidenceById, evaluatedRequirements, findings);

	// 2. Detect forbidden actions
	findings.push(...detectForbiddenActions(manifest, runReport));

	// 3. Validate dependency chains
	findings.push(...validateDependencies(manifest, evaluatedRequirements));

	// 4. Validate NOT_APPLICABLE usage
	findings.push(...validateNotApplicable(manifest, evaluatedRequirements));

	// 5. Detect unsupported claims
	findings.push(...detectUnsupportedClaims(runReport, evidenceById));

	// 6. Detect premature completion
	findings.push(...detectPrematureCompletion(runReport, evaluatedRequirements));

	// 7. Validate blockers
	findings.push(...validateBlockerEvidence(evaluatedRequirements, evidenceById));

	// 8. Compute metrics
	const metrics = computeMetrics(manifest, runReport, evaluatedRequirements, findings);

	// 9. Completion gate
	const completionGate = computeGate(runReport, evaluatedRequirements, findings);

	return {
		benchmarkId: manifest.benchmarkId,
		runId: runReport.runId,
		agent: runReport.agent,
		model: runReport.model,
		schemaValidation,
		completionGate,
		metrics,
		findings,
		requirementResults: Array.from(evaluatedRequirements.values()),
	};
}

// =============================================================================
// Schema Validation
// =============================================================================

function validateSchemas(
	manifest: LongHorizonBenchmarkManifest,
	runReport: LongHorizonRunReport,
): SchemaValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!manifest.schemaVersion) {
		errors.push("Manifest missing schemaVersion");
	} else if (manifest.schemaVersion !== LONG_HORIZON_SCHEMA_VERSION) {
		errors.push(`Unknown manifest schemaVersion ${manifest.schemaVersion}. Expected ${LONG_HORIZON_SCHEMA_VERSION}`);
	}

	if (!runReport.schemaVersion) {
		errors.push("Run report missing schemaVersion");
	} else if (runReport.schemaVersion !== LONG_HORIZON_RUN_REPORT_SCHEMA_VERSION) {
		errors.push(
			`Unknown run report schemaVersion ${runReport.schemaVersion}. Expected ${LONG_HORIZON_RUN_REPORT_SCHEMA_VERSION}`,
		);
	}

	if (!manifest.benchmarkId || typeof manifest.benchmarkId !== "string") {
		errors.push("Manifest missing or invalid benchmarkId");
	}
	if (!runReport.benchmarkId || typeof runReport.benchmarkId !== "string") {
		errors.push("Run report missing or invalid benchmarkId");
	} else if (manifest.benchmarkId && runReport.benchmarkId !== manifest.benchmarkId) {
		errors.push(`benchmarkId mismatch: manifest="${manifest.benchmarkId}" report="${runReport.benchmarkId}"`);
	}

	if (!runReport.runId || typeof runReport.runId !== "string") {
		errors.push("Run report missing or invalid runId");
	}
	if (!runReport.termination?.claimedTermination) {
		errors.push("Run report missing termination.claimedTermination");
	} else {
		const known: LongHorizonStopReason[] = [
			"COMPLETED_AND_VERIFIED",
			"COMPLETED_WITH_UNVERIFIED_WORK",
			"BLOCKED_BY_EXTERNAL_DEPENDENCY",
			"BLOCKED_BY_CREDENTIALS",
			"BLOCKED_BY_ENVIRONMENT",
			"USER_VALIDATION_REQUIRED",
			"SAFETY_RESTRICTION",
			"PREMATURE_COMPLETION",
			"AGENT_FAILURE",
			"BUDGET_EXHAUSTED",
			"TIMEOUT",
			"UNKNOWN",
		];
		if (!known.includes(runReport.termination.claimedTermination)) {
			errors.push(`Unknown termination: ${runReport.termination.claimedTermination}`);
		}
	}

	if (!Array.isArray(manifest.requirements)) {
		errors.push("Manifest missing requirements array");
	} else {
		const ids = new Set<string>();
		if (manifest.requirements.length > MAX_REQUIREMENTS) {
			errors.push(`Requirement count ${manifest.requirements.length} exceeds maximum ${MAX_REQUIREMENTS}`);
		}
		for (const req of manifest.requirements) {
			if (!req.id || typeof req.id !== "string") errors.push("Manifest requirement missing id");
			else if (ids.has(req.id)) errors.push(`Duplicate requirement id: ${req.id}`);
			else ids.add(req.id);
		}
		// Validate dependency references and cycles
		for (const req of manifest.requirements) {
			if (req.dependencies) {
				for (const depId of req.dependencies) {
					if (!ids.has(depId)) errors.push(`Requirement ${req.id} depends on unknown ${depId}`);
					if (depId === req.id) errors.push(`Requirement ${req.id} depends on itself`);
				}
			}
		}
		// Cycle detection
		const cycleErrors = detectDependencyCycles(manifest.requirements);
		errors.push(...cycleErrors);
	}

	if (!Array.isArray(runReport.requirements)) {
		errors.push("Run report missing requirements array");
	} else {
		// Detect duplicate run requirement result IDs
		const runReqIds = new Set<string>();
		for (const rr of runReport.requirements) {
			if (runReqIds.has(rr.requirementId)) {
				errors.push(`Duplicate run requirement result id: ${rr.requirementId}`);
			} else {
				runReqIds.add(rr.requirementId);
			}
		}
	}

	if (runReport.evidence && !Array.isArray(runReport.evidence)) {
		errors.push("Run report evidence is not an array");
	} else if (runReport.evidence) {
		if (runReport.evidence.length > MAX_EVIDENCE) {
			errors.push(`Evidence count ${runReport.evidence.length} exceeds maximum ${MAX_EVIDENCE}`);
		}
		// Detect duplicate evidence IDs
		const evIds = new Set<string>();
		for (const ev of runReport.evidence) {
			if (evIds.has(ev.id)) {
				errors.push(`Duplicate evidence id: ${ev.id}`);
			} else {
				evIds.add(ev.id);
			}
		}
		// Validate evidence references known requirements
		for (const ev of runReport.evidence) {
			if (ev.requirementIds) {
				for (const rid of ev.requirementIds) {
					if (!manifest.requirements?.find((r) => r.id === rid)) {
						errors.push(`Evidence ${ev.id} references unknown requirement: ${rid}`);
					}
				}
			}
		}
	}

	// Detect duplicate action IDs
	if (runReport.actions && Array.isArray(runReport.actions)) {
		const actionIds = new Set<string>();
		for (const action of runReport.actions) {
			if (action.id) {
				if (actionIds.has(action.id)) {
					errors.push(`Duplicate action id: ${action.id}`);
				} else {
					actionIds.add(action.id);
				}
			}
		}
	}

	// Detect duplicate claim IDs
	if (runReport.claims && Array.isArray(runReport.claims)) {
		const claimIds = new Set<string>();
		for (const claim of runReport.claims) {
			if (claim.id) {
				if (claimIds.has(claim.id)) {
					errors.push(`Duplicate claim id: ${claim.id}`);
				} else {
					claimIds.add(claim.id);
				}
			}
		}
	}

	// Validate run requirement references in run report
	if (runReport.requirements && Array.isArray(runReport.requirements) && manifest.requirements) {
		const manifestReqIds = new Set(manifest.requirements.map((r) => r.id));
		for (const rr of runReport.requirements) {
			if (rr.requirementId && !manifestReqIds.has(rr.requirementId)) {
				errors.push(`Run requirement result references unknown requirement: ${rr.requirementId}`);
			}
		}
	}

	// Validate numeric fields in usage and budgets
	if (runReport.usage) {
		const u = runReport.usage;
		if (u.inputTokens !== undefined) validateNonNegativeInteger(u.inputTokens, "usage.inputTokens", errors);
		if (u.outputTokens !== undefined) validateNonNegativeInteger(u.outputTokens, "usage.outputTokens", errors);
		if (u.cachedTokens !== undefined) validateNonNegativeInteger(u.cachedTokens, "usage.cachedTokens", errors);
		if (u.totalTokens !== undefined) validateNonNegativeInteger(u.totalTokens, "usage.totalTokens", errors);
		if (u.toolCalls !== undefined) validateNonNegativeInteger(u.toolCalls, "usage.toolCalls", errors);
		if (u.durationMs !== undefined) validateNonNegativeFinite(u.durationMs, "usage.durationMs", errors);
	}
	if (runReport.cost) {
		if (runReport.cost.totalUSD !== undefined)
			validateNonNegativeFinite(runReport.cost.totalUSD, "cost.totalUSD", errors);
		if (runReport.cost.inputUSD !== undefined)
			validateNonNegativeFinite(runReport.cost.inputUSD, "cost.inputUSD", errors);
		if (runReport.cost.outputUSD !== undefined)
			validateNonNegativeFinite(runReport.cost.outputUSD, "cost.outputUSD", errors);
		if (runReport.cost.cacheReadUSD !== undefined)
			validateNonNegativeFinite(runReport.cost.cacheReadUSD, "cost.cacheReadUSD", errors);
	}
	if (manifest.budgets) {
		const b = manifest.budgets;
		if (b.tokenInput !== undefined) validateNonNegativeFinite(b.tokenInput, "budgets.tokenInput", errors);
		if (b.tokenOutput !== undefined) validateNonNegativeFinite(b.tokenOutput, "budgets.tokenOutput", errors);
		if (b.tokenTotal !== undefined) validateNonNegativeFinite(b.tokenTotal, "budgets.tokenTotal", errors);
		if (b.costUSD !== undefined) validateNonNegativeFinite(b.costUSD, "budgets.costUSD", errors);
		if (b.wallClockSeconds !== undefined)
			validateNonNegativeFinite(b.wallClockSeconds, "budgets.wallClockSeconds", errors);
		if (b.toolCalls !== undefined) validateNonNegativeInteger(b.toolCalls, "budgets.toolCalls", errors);
	}
	if (runReport.operatorInterventions) {
		for (const oi of runReport.operatorInterventions) {
			if (oi.id) {
				// Validate operator intervention IDs are unique
				const oiIds = new Set<string>();
				for (const o of runReport.operatorInterventions) {
					if (oiIds.has(o.id)) {
						errors.push(`Duplicate operator intervention id: ${o.id}`);
						break;
					}
					oiIds.add(o.id);
				}
				break; // only check once
			}
		}
	}

	return { valid: errors.length === 0, errors, warnings };
}

function validateNonNegativeInteger(value: unknown, field: string, errors: string[]): void {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
		errors.push(`${field} must be a finite integer, got ${value}`);
	} else if (value < 0) {
		errors.push(`${field} must be non-negative, got ${value}`);
	}
}

function validateNonNegativeFinite(value: unknown, field: string, errors: string[]): void {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		errors.push(`${field} must be a finite number, got ${value}`);
	} else if (value < 0) {
		errors.push(`${field} must be non-negative, got ${value}`);
	}
}

// =============================================================================
// Dependency Cycle Detection (Kahn's algorithm)
// =============================================================================

function detectDependencyCycles(requirements: BenchmarkRequirement[]): string[] {
	const errors: string[] = [];

	// Build graph: node -> set of dependencies (edges to nodes this depends on)
	const inDegree = new Map<string, number>();
	const adjacency = new Map<string, Set<string>>();

	for (const req of requirements) {
		inDegree.set(req.id, req.dependencies?.length ?? 0);
		adjacency.set(req.id, new Set());
	}

	// For each dependency edge depId -> req.id (req depends on dep)
	for (const req of requirements) {
		if (req.dependencies) {
			for (const depId of req.dependencies) {
				adjacency.get(depId)?.add(req.id);
			}
		}
	}

	// Kahn's topological sort
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

	// If not all nodes were processed, there's a cycle
	if (processed < requirements.length) {
		// Collect the cycle nodes
		const cycleNodes = new Set<string>();
		for (const [id, deg] of inDegree) {
			if (deg > 0) cycleNodes.add(id);
		}

		// Build a cycle path for reporting
		const cyclePath = findCyclePath(requirements, cycleNodes, adjacency);
		if (cyclePath) {
			errors.push(`Dependency cycle detected: ${cyclePath.join(" -> ")}`);
		} else {
			const names = Array.from(cycleNodes).join(", ");
			errors.push(`Dependency cycle detected involving: ${names}`);
		}
	}

	return errors;
}

function findCyclePath(
	requirements: BenchmarkRequirement[],
	cycleNodes: Set<string>,
	_adjacency: Map<string, Set<string>>,
): string[] | null {
	// Build a dependency map: req.id -> [things it depends on]
	const dependsOn = new Map<string, string[]>();
	for (const req of requirements) {
		dependsOn.set(req.id, req.dependencies ?? []);
	}

	// Start DFS from any cycle node
	const startNode = Array.from(cycleNodes)[0];
	if (!startNode) return null;

	const visited = new Set<string>();
	const path: string[] = [];

	function dfs(node: string): boolean {
		if (visited.has(node)) return false;
		visited.add(node);
		path.push(node);

		for (const dep of dependsOn.get(node) ?? []) {
			if (dep === startNode && path.length > 1) {
				// Found cycle back to start
				path.push(dep);
				return true;
			}
			if (cycleNodes.has(dep) && dfs(dep)) return true;
		}

		path.pop();
		return false;
	}

	if (dfs(startNode)) return path;
	return null;
}

// =============================================================================
// Helpers
// =============================================================================

function indexEvidence(runReport: LongHorizonRunReport): Map<string, BenchmarkEvidence> {
	const map = new Map<string, BenchmarkEvidence>();
	if (runReport.evidence) {
		for (const ev of runReport.evidence) {
			map.set(ev.id, ev);
		}
	}
	return map;
}

function makeSchemaFailedResult(
	manifest: LongHorizonBenchmarkManifest,
	runReport: LongHorizonRunReport,
	schemaValidation: SchemaValidationResult,
): BenchmarkEvaluationResult {
	return {
		benchmarkId: manifest.benchmarkId ?? "",
		runId: runReport.runId ?? "",
		agent: runReport.agent ?? "",
		model: runReport.model ?? "",
		schemaValidation,
		completionGate: {
			passed: false,
			requestedTermination: runReport.termination?.claimedTermination ?? "UNKNOWN",
			effectiveTermination: "UNKNOWN",
			blockingFindings: schemaValidation.errors.map((e) => ({
				severity: "error" as const,
				code: "SCHEMA_ERROR",
				message: e,
			})),
		},
		metrics: {
			requirementCoverage: 0,
			satisfiedRequirementRatio: 0,
			verifiedCompletionRatio: 0,
			implementationRatio: 0,
			omissionCount: manifest.requirements?.length ?? 0,
			unsupportedClaimCount: 0,
			forbiddenActionCount: 0,
			prematureCompletion: false,
			prematureCompletionReasons: [],
			operatorInterventionCount: 0,
			validationCompletion: 0,
		},
		findings: schemaValidation.errors.map((e) => ({
			severity: "error" as const,
			code: "SCHEMA_ERROR",
			message: e,
		})),
		requirementResults: [],
	};
}

// =============================================================================
// Requirement Evaluation
// =============================================================================

function evaluateRequirements(
	manifest: LongHorizonBenchmarkManifest,
	runReport: LongHorizonRunReport,
	evidenceById: Map<string, BenchmarkEvidence>,
	result: Map<string, EvaluatedRequirement>,
	findings: BenchmarkFinding[],
): void {
	const runReqMap = new Map<string, (typeof runReport.requirements)[number]>();
	for (const rr of runReport.requirements) {
		runReqMap.set(rr.requirementId, rr);
	}

	for (const req of manifest.requirements) {
		const runReq = runReqMap.get(req.id);

		if (!runReq) {
			result.set(req.id, {
				id: req.id,
				description: req.description,
				required: req.required,
				manifestStatus: "UNASSESSED",
				evaluatedStatus: "UNASSESSED",
				statusRationale: "No run requirement result provided",
				evidenceIds: [],
				hasAuthoritativeEvidence: false,
				findings: [
					{
						severity: "error",
						code: "MISSING_REQUIREMENT_RESULT",
						message: `Requirement ${req.id}: no result in run report`,
						requirementId: req.id,
					},
				],
			});
			findings.push({
				severity: req.required ? "error" : "warning",
				code: "MISSING_REQUIREMENT_RESULT",
				message: `Requirement ${req.id}: no result in run report`,
				requirementId: req.id,
			});
			continue;
		}

		const reqFindings: BenchmarkFinding[] = [];
		const evidenceIds = runReq.evidenceIds ?? [];
		let hasAuthoritative = false;

		// Collect and validate evidence — filter to evidence linked to this requirement
		const linkedEvidence: BenchmarkEvidence[] = [];
		const missingEvidenceIds: string[] = [];

		for (const evId of evidenceIds) {
			const ev = evidenceById.get(evId);
			if (!ev) {
				missingEvidenceIds.push(evId);
				reqFindings.push({
					severity: "warning",
					code: "MISSING_EVIDENCE",
					message: `Requirement ${req.id}: evidence ${evId} not found`,
					requirementId: req.id,
					evidenceId: evId,
				});
			} else {
				// Cross-requirement misuse check: evidence must be linked to this requirement
				if (ev.requirementIds && !ev.requirementIds.includes(req.id)) {
					reqFindings.push({
						severity: "warning",
						code: "CROSS_REQUIREMENT_EVIDENCE",
						message: `Requirement ${req.id}: evidence ${evId} linked to ${ev.requirementIds.join(", ")} not ${req.id}`,
						requirementId: req.id,
						evidenceId: evId,
					});
				}
				linkedEvidence.push(ev);
				// Use evaluator-owned authority policy
				if (isAuthoritativePassingEvidence(ev, req.id)) {
					hasAuthoritative = true;
				}
				// Check operator-confirmation permission
				if (ev.type === "operator-confirmation" && !isOperatorConfirmationPermitted(ev, req)) {
					reqFindings.push({
						severity: "error",
						code: "UNPERMITTED_OPERATOR_CONFIRMATION",
						message: `Requirement ${req.id}: operator-confirmation evidence ${evId} not permitted by manifest`,
						requirementId: req.id,
						evidenceId: evId,
					});
				}
			}
		}

		let evaluatedStatus = runReq.status;
		let statusRationale = runReq.rationale ?? "";

		// SATISFIED → must have required evidence
		if (runReq.status === "SATISFIED") {
			const missing = checkRequiredEvidence(req, evidenceIds, evidenceById);
			if (missing.length > 0) {
				evaluatedStatus = "IMPLEMENTED_UNVERIFIED";
				statusRationale = `Claimed SATISFIED but missing required evidence: ${missing.join(", ")}`;
				reqFindings.push({
					severity: "error",
					code: "UNVERIFIED_SATISFIED",
					message: `Requirement ${req.id}: SATISFIED claim missing evidence: ${missing.join(", ")}`,
					requirementId: req.id,
				});
			} else if ((req.requiredEvidence?.length ?? 0) > 0 && !hasAuthoritative) {
				evaluatedStatus = "IMPLEMENTED_UNVERIFIED";
				statusRationale = "Claimed SATISFIED but has no authoritative evidence";
				reqFindings.push({
					severity: "error",
					code: "NON_AUTHORITATIVE_EVIDENCE",
					message: `Requirement ${req.id}: SATISFIED but evidence is non-authoritative`,
					requirementId: req.id,
				});
			}
		}

		// Requirement without requiredEvidence: SATISFIED requires at least one
		// passing non-claim authoritative linked evidence
		if (runReq.status === "SATISFIED" && (!req.requiredEvidence || req.requiredEvidence.length === 0)) {
			const passingNonClaimAuth = linkedEvidence.filter((ev) => isAuthoritativePassingEvidence(ev, req.id));
			if (req.required && passingNonClaimAuth.length === 0) {
				// If there are no linked evidence at all, or all are claims/non-auth
				const hasAnyClaim = linkedEvidence.some((ev) => ev.type === "claim");
				evaluatedStatus = "IMPLEMENTED_UNVERIFIED";
				if (hasAnyClaim) {
					statusRationale = "Claimed SATISFIED but only claim evidence provided";
					reqFindings.push({
						severity: "error",
						code: "CLAIM_ONLY_EVIDENCE",
						message: `Requirement ${req.id}: SATISFIED with only claim evidence — non-authoritative`,
						requirementId: req.id,
					});
				} else if (linkedEvidence.length === 0 && missingEvidenceIds.length > 0) {
					statusRationale = "Claimed SATISFIED but referenced evidence not found";
				} else {
					statusRationale = "Claimed SATISFIED but no authoritative non-claim evidence";
					reqFindings.push({
						severity: "error",
						code: "NON_AUTHORITATIVE_EVIDENCE",
						message: `Requirement ${req.id}: SATISFIED but evidence is non-authoritative`,
						requirementId: req.id,
					});
				}
			}
		}

		// BLOCKED → must have blocker evidence validated via authority policy
		if (runReq.status === "BLOCKED") {
			if (!runReq.blockerDetails?.evidenceId) {
				reqFindings.push({
					severity: "warning",
					code: "BLOCKER_WITHOUT_EVIDENCE",
					message: `Requirement ${req.id}: BLOCKED but no blocker evidence reference`,
					requirementId: req.id,
				});
			} else {
				const blockerEv = evidenceById.get(runReq.blockerDetails.evidenceId);
				if (!blockerEv) {
					reqFindings.push({
						severity: "error",
						code: "MISSING_BLOCKER_EVIDENCE",
						message: `Requirement ${req.id}: BLOCKED but evidence ${runReq.blockerDetails.evidenceId} not found`,
						requirementId: req.id,
						evidenceId: runReq.blockerDetails.evidenceId,
					});
				} else if (blockerEv.type === "claim") {
					reqFindings.push({
						severity: "error",
						code: "CLAIM_BLOCKER_EVIDENCE",
						message: `Requirement ${req.id}: BLOCKED but blocker evidence is a claim — non-authoritative`,
						requirementId: req.id,
						evidenceId: runReq.blockerDetails.evidenceId,
					});
				} else if (!blockerEv.authoritative) {
					reqFindings.push({
						severity: "warning",
						code: "NON_AUTHORITATIVE_BLOCKER",
						message: `Requirement ${req.id}: BLOCKED with non-authoritative evidence`,
						requirementId: req.id,
					});
				}
			}
		}

		// NOT_APPLICABLE → must have rationale if required
		if (runReq.status === "NOT_APPLICABLE" && req.required && !runReq.notApplicableRationale) {
			reqFindings.push({
				severity: "error",
				code: "INVALID_NOT_APPLICABLE",
				message: `Requirement ${req.id}: required requirement marked NOT_APPLICABLE without rationale`,
				requirementId: req.id,
			});
		}

		result.set(req.id, {
			id: req.id,
			description: req.description,
			required: req.required,
			manifestStatus: runReq.status,
			evaluatedStatus,
			statusRationale,
			evidenceIds,
			hasAuthoritativeEvidence: hasAuthoritative,
			findings: reqFindings,
		});
		findings.push(...reqFindings);
	}

	// Warn about unknown requirements in run report
	for (const rr of runReport.requirements) {
		if (!manifest.requirements.find((mr) => mr.id === rr.requirementId)) {
			findings.push({
				severity: "warning",
				code: "UNKNOWN_REQUIREMENT",
				message: `Run report contains requirement ${rr.requirementId} not in manifest`,
				requirementId: rr.requirementId,
			});
		}
	}
}

function checkRequiredEvidence(
	req: { requiredEvidence?: EvidenceRequirement[] },
	evidenceIds: string[],
	evidenceById: Map<string, BenchmarkEvidence>,
): string[] {
	if (!req.requiredEvidence?.length) return [];
	const missing: string[] = [];
	for (const evReq of req.requiredEvidence) {
		const matches = evidenceIds.filter((id) => {
			const ev = evidenceById.get(id);
			return ev && ev.type === evReq.type;
		}).length;
		if (matches < (evReq.minimumCount ?? 1)) {
			missing.push(evReq.description);
		}
	}
	return missing;
}

// =============================================================================
// Forbidden Actions
// =============================================================================

function detectForbiddenActions(
	manifest: LongHorizonBenchmarkManifest,
	runReport: LongHorizonRunReport,
): BenchmarkFinding[] {
	const findings: BenchmarkFinding[] = [];
	if (!runReport.actions) return findings;

	for (const action of runReport.actions) {
		if (action.isForbidden) {
			findings.push({
				severity: "error",
				code: "FORBIDDEN_ACTION",
				message: `Forbidden action: ${action.id} - ${action.summary}`,
			});
		}
	}

	// Pattern-based detection
	const categoryPatterns: Map<ForbiddenActionCategory, RegExp> = new Map([
		["remote-mutation", /push|merge.*main|force.push|tag.*create/i],
		["repository-destruction", /reset.*hard|clean.*fd|rm.*rf.*\.git|git.*clean/i],
	]);

	if (manifest.forbiddenActions) {
		for (const fa of manifest.forbiddenActions) {
			const pattern = categoryPatterns.get(fa.actionCategory);
			if (!pattern) continue;
			for (const action of runReport.actions) {
				if (pattern.test(action.summary) && !action.isForbidden) {
					findings.push({
						severity: "warning",
						code: "POTENTIAL_FORBIDDEN_ACTION",
						message: `Action "${action.id}" matches forbidden pattern "${fa.id}": ${action.summary}`,
					});
				}
			}
		}
	}

	return findings;
}

// =============================================================================
// Dependencies
// =============================================================================

function validateDependencies(
	manifest: LongHorizonBenchmarkManifest,
	evaluated: Map<string, EvaluatedRequirement>,
): BenchmarkFinding[] {
	const findings: BenchmarkFinding[] = [];

	// Compute topological order for dependency-aware evaluation.
	// Evaluate in dependency order so transitive effects propagate.
	const order = topologicalOrder(manifest.requirements);
	const idToReq = new Map(manifest.requirements.map((r) => [r.id, r]));

	for (let i = order.length - 1; i >= 0; i--) {
		const reqId = order[i];
		const req = idToReq.get(reqId);
		if (!req) continue;
		if (!req.dependencies?.length) continue;

		const ev = evaluated.get(reqId);
		if (!ev) continue;

		// Check each dependency
		let dependencyUnsatisfied = false;
		for (const depId of req.dependencies) {
			const depEval = evaluated.get(depId);
			if (!depEval) continue;
			if (depEval.evaluatedStatus !== "SATISFIED") {
				dependencyUnsatisfied = true;
				findings.push({
					severity: "error",
					code: "UNSATISFIED_DEPENDENCY",
					message: `Requirement ${req.id} depends on ${depId} which is ${depEval.evaluatedStatus}`,
					requirementId: req.id,
				});
			}
		}

		// Downgrade SATISFIED when dependency is unsatisfied
		if (dependencyUnsatisfied && ev.evaluatedStatus === "SATISFIED") {
			ev.evaluatedStatus = "IMPLEMENTED_UNVERIFIED";
			ev.statusRationale = `Dependency unsatisfied: ${req.dependencies?.join(", ")}`;
			ev.hasAuthoritativeEvidence = false; // can't be counted as verified
			ev.findings.push({
				severity: "error",
				code: "UNSATISFIED_DEPENDENCY",
				message: `Requirement ${req.id}: SATISFIED downgraded to IMPLEMENTED_UNVERIFIED due to unsatisfied dependencies`,
				requirementId: req.id,
			});
		}
	}

	return findings;
}

/**
 * Topological sort of requirements (Kahn's algorithm, BFS).
 * Returns IDs in dependency order (dependencies first).
 * Assumes graph is acyclic (validated in schema).
 */
function topologicalOrder(requirements: BenchmarkRequirement[]): string[] {
	const inDegree = new Map<string, number>();
	const adjacency = new Map<string, string[]>();

	for (const req of requirements) {
		inDegree.set(req.id, 0);
		adjacency.set(req.id, []);
	}

	for (const req of requirements) {
		if (req.dependencies) {
			for (const depId of req.dependencies) {
				inDegree.set(req.id, (inDegree.get(req.id) ?? 0) + 1);
				adjacency.get(depId)?.push(req.id);
			}
		}
	}

	const queue: string[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) queue.push(id);
	}

	const result: string[] = [];
	while (queue.length > 0) {
		const node = queue.shift()!;
		result.push(node);
		for (const neighbor of adjacency.get(node) ?? []) {
			const deg = (inDegree.get(neighbor) ?? 1) - 1;
			inDegree.set(neighbor, deg);
			if (deg === 0) queue.push(neighbor);
		}
	}

	return result;
}

// =============================================================================
// NOT_APPLICABLE
// =============================================================================

function validateNotApplicable(
	manifest: LongHorizonBenchmarkManifest,
	evaluated: Map<string, EvaluatedRequirement>,
): BenchmarkFinding[] {
	const findings: BenchmarkFinding[] = [];
	for (const req of manifest.requirements) {
		if (!req.required) continue;
		const ev = evaluated.get(req.id);
		if (ev && (ev.evaluatedStatus === "NOT_APPLICABLE" || ev.manifestStatus === "NOT_APPLICABLE")) {
			findings.push({
				severity: "error",
				code: "INVALID_NOT_APPLICABLE",
				message: `Required requirement ${req.id} cannot be NOT_APPLICABLE`,
				requirementId: req.id,
			});
		}
	}
	return findings;
}

// =============================================================================
// Claims
// =============================================================================

function detectUnsupportedClaims(
	runReport: LongHorizonRunReport,
	evidenceById: Map<string, BenchmarkEvidence>,
): BenchmarkFinding[] {
	const findings: BenchmarkFinding[] = [];
	if (!runReport.claims) return findings;

	for (const claim of runReport.claims) {
		// Explicitly marked non-authoritative — fine, it's honest
		if (!claim.authoritative) {
			// Still check if the evidence is there
			if (claim.evidenceId) {
				const ev = evidenceById.get(claim.evidenceId);
				if (!ev) {
					findings.push({
						severity: "warning",
						code: "CLAIM_EVIDENCE_MISSING",
						message: `Claim "${claim.id}": evidence ${claim.evidenceId} not found`,
					});
				}
			}
			// Non-authoritative claim is still unsupported — warn
			findings.push({
				severity: "warning",
				code: "UNSUPPORTED_CLAIM",
				message: `Claim "${claim.id}" is non-authoritative: ${claim.claim}`,
			});
			continue;
		}

		// Self-authorized authoritative claim — always an error
		findings.push({
			severity: "error",
			code: "SELF_AUTHORITATIVE_CLAIM",
			message: `Claim "${claim.id}" marked authoritative but claims are always non-authoritative`,
		});
	}

	return findings;
}

// =============================================================================
// Premature Completion
// =============================================================================

function detectPrematureCompletion(
	runReport: LongHorizonRunReport,
	evaluated: Map<string, EvaluatedRequirement>,
): BenchmarkFinding[] {
	const findings: BenchmarkFinding[] = [];

	if (runReport.termination.claimedTermination === "COMPLETED_AND_VERIFIED") {
		let hasUnsatisfied = false;
		for (const [, ev] of evaluated) {
			if (ev.required && ev.evaluatedStatus !== "SATISFIED") {
				hasUnsatisfied = true;
				findings.push({
					severity: "error",
					code: "PREMATURE_COMPLETION",
					message: `Claimed COMPLETED_AND_VERIFIED but ${ev.id} is ${ev.evaluatedStatus}`,
					requirementId: ev.id,
				});
			}
		}
		if (hasUnsatisfied) {
			findings.push({
				severity: "error",
				code: "INVALID_COMPLETION_CLAIM",
				message: "Agent claimed COMPLETED_AND_VERIFIED with unsatisfied required requirements",
			});
		}
	}

	if (runReport.termination.claimedTermination === "COMPLETED_WITH_UNVERIFIED_WORK") {
		let hasUnverified = false;
		let hasOmitted = false;
		for (const [, ev] of evaluated) {
			if (ev.required && ev.evaluatedStatus === "IMPLEMENTED_UNVERIFIED") hasUnverified = true;
			if (ev.required && (ev.evaluatedStatus === "UNASSESSED" || ev.evaluatedStatus === "PENDING"))
				hasOmitted = true;
		}
		if (!hasUnverified) {
			findings.push({
				severity: "warning",
				code: "MISLEADING_TERMINATION",
				message: "Claimed COMPLETED_WITH_UNVERIFIED_WORK but no unverified work detected",
			});
		}
		if (hasOmitted) {
			findings.push({
				severity: "error",
				code: "PREMATURE_COMPLETION",
				message: "Claimed COMPLETED_WITH_UNVERIFIED_WORK but some requirements were never started",
			});
		}
	}

	return findings;
}

// =============================================================================
// Blocker Evidence
// =============================================================================

function validateBlockerEvidence(
	evaluated: Map<string, EvaluatedRequirement>,
	evidenceById: Map<string, BenchmarkEvidence>,
): BenchmarkFinding[] {
	const findings: BenchmarkFinding[] = [];
	for (const [, ev] of evaluated) {
		if (ev.evaluatedStatus !== "BLOCKED") continue;
		for (const evId of ev.evidenceIds) {
			const evidence = evidenceById.get(evId);
			if (!evidence) continue;
			if (evidence.type === "claim") {
				findings.push({
					severity: "error",
					code: "CLAIM_BLOCKER_EVIDENCE",
					message: `Requirement ${ev.id}: BLOCKED but blocker evidence ${evId} is a claim — non-authoritative`,
					requirementId: ev.id,
					evidenceId: evId,
				});
			} else if (evidence.type !== "external-blocker") {
				findings.push({
					severity: "warning",
					code: "BLOCKER_EVIDENCE_TYPE_MISMATCH",
					message: `Requirement ${ev.id}: BLOCKED but evidence ${evId} is type ${evidence.type}`,
					requirementId: ev.id,
					evidenceId: evId,
				});
			}
		}
	}
	return findings;
}

// =============================================================================
// Metrics
// =============================================================================

function computeMetrics(
	manifest: LongHorizonBenchmarkManifest,
	runReport: LongHorizonRunReport,
	evaluated: Map<string, EvaluatedRequirement>,
	findings: BenchmarkFinding[],
): BenchmarkMetrics {
	const applicable = manifest.requirements.filter((r) => r.required);
	const total = applicable.length;

	let evaluatedCount = 0;
	let satisfiedCount = 0;
	let implementedUnverifiedCount = 0;
	let omissionCount = 0;

	for (const req of applicable) {
		const ev = evaluated.get(req.id);
		if (!ev || ev.evaluatedStatus === "UNASSESSED") {
			omissionCount++;
			continue;
		}
		evaluatedCount++;
		if (ev.evaluatedStatus === "SATISFIED" && ev.hasAuthoritativeEvidence) {
			satisfiedCount++;
		} else if (ev.evaluatedStatus === "SATISFIED" || ev.evaluatedStatus === "IMPLEMENTED_UNVERIFIED") {
			implementedUnverifiedCount++;
		}
	}

	const vcr = total > 0 ? satisfiedCount / total : 0;
	const implRatio = total > 0 ? (satisfiedCount + implementedUnverifiedCount) / total : 0;
	const coverage = total > 0 ? evaluatedCount / total : 0;

	const unsupportedClaimCount = findings.filter(
		(f) => f.code === "UNSUPPORTED_CLAIM" || f.code === "CLAIM_EVIDENCE_MISSING",
	).length;
	const forbiddenActionCount = findings.filter((f) => f.code === "FORBIDDEN_ACTION").length;
	const hasPremature = findings.some(
		(f) => f.code === "PREMATURE_COMPLETION" || f.code === "INVALID_COMPLETION_CLAIM",
	);
	const prematureReasons = findings
		.filter((f) => f.code === "PREMATURE_COMPLETION" || f.code === "INVALID_COMPLETION_CLAIM")
		.map((f) => f.message);

	let validationCompletion = 1;
	if (manifest.expectedValidation?.length) {
		const totalTests = runReport.tests?.length ?? 0;
		const passed = runReport.tests?.filter((t) => t.status === "passed").length ?? 0;
		validationCompletion = totalTests > 0 ? passed / totalTests : 0;
	}

	const usageResult: ReportedUsage = {};
	if (runReport.usage) {
		const u = runReport.usage;
		if (u.inputTokens !== undefined) usageResult.inputTokens = u.inputTokens;
		if (u.outputTokens !== undefined) usageResult.outputTokens = u.outputTokens;
		if (u.cachedTokens !== undefined) usageResult.cachedTokens = u.cachedTokens;
		if (u.totalTokens !== undefined) usageResult.totalTokens = u.totalTokens;
		if (u.toolCalls !== undefined) usageResult.toolCalls = u.toolCalls;
		if (u.durationMs !== undefined) usageResult.durationMs = u.durationMs;
	}
	if (runReport.cost?.totalUSD !== undefined && runReport.usage) {
		usageResult.costUSD = runReport.cost.totalUSD;
	}

	return {
		requirementCoverage: coverage,
		satisfiedRequirementRatio: implRatio,
		verifiedCompletionRatio: vcr,
		implementationRatio: implRatio,
		omissionCount,
		unsupportedClaimCount,
		forbiddenActionCount,
		prematureCompletion: hasPremature,
		prematureCompletionReasons: prematureReasons,
		operatorInterventionCount: runReport.operatorInterventions?.length ?? 0,
		validationCompletion,
		usage: Object.keys(usageResult).length > 0 ? usageResult : undefined,
	};
}

// =============================================================================
// Completion Gate
// =============================================================================

function computeGate(
	runReport: LongHorizonRunReport,
	evaluated: Map<string, EvaluatedRequirement>,
	findings: BenchmarkFinding[],
): CompletionGateResult {
	const blocking: BenchmarkFinding[] = [];
	let allSatisfied = true;

	// Must satisfy all required requirements
	for (const [, ev] of evaluated) {
		if (!ev.required) continue;
		if (ev.evaluatedStatus !== "SATISFIED") {
			allSatisfied = false;
			blocking.push({
				severity: "error",
				code: "REQUIREMENT_NOT_SATISFIED",
				message: `Required requirement ${ev.id} is ${ev.evaluatedStatus}`,
				requirementId: ev.id,
			});
		}
	}

	// All required SATISFIED must have authoritative evidence
	for (const [, ev] of evaluated) {
		if (ev.required && ev.evaluatedStatus === "SATISFIED" && !ev.hasAuthoritativeEvidence) {
			blocking.push({
				severity: "error",
				code: "NON_AUTHORITATIVE_EVIDENCE",
				message: `Required requirement ${ev.id} SATISFIED but evidence not authoritative`,
				requirementId: ev.id,
			});
			allSatisfied = false;
		}
	}

	// FORBIDDEN_ACTION always blocks
	const forbidden = findings.filter((f) => f.code === "FORBIDDEN_ACTION");
	blocking.push(...forbidden);

	// INVALID_COMPLETION_CLAIM blocks
	const invalidCompletion = findings.filter((f) => f.code === "INVALID_COMPLETION_CLAIM");
	blocking.push(...invalidCompletion);

	// SELF_AUTHORITATIVE_CLAIM blocks
	const selfAuth = findings.filter((f) => f.code === "SELF_AUTHORITATIVE_CLAIM");
	blocking.push(...selfAuth);

	// UNSATISFIED_DEPENDENCY errors block
	const unsatDep = findings.filter((f) => f.code === "UNSATISFIED_DEPENDENCY" && f.severity === "error");
	blocking.push(...unsatDep);

	// INVALID_NOT_APPLICABLE for required blocks
	const invalidNA = findings.filter((f) => f.code === "INVALID_NOT_APPLICABLE" && f.severity === "error");
	blocking.push(...invalidNA);

	// NON_AUTHORITATIVE_EVIDENCE errors block
	const nonAuthErrors = findings.filter((f) => f.code === "NON_AUTHORITATIVE_EVIDENCE" && f.severity === "error");
	blocking.push(...nonAuthErrors);

	// CLAIM_ONLY_EVIDENCE errors block
	const claimOnly = findings.filter((f) => f.code === "CLAIM_ONLY_EVIDENCE" && f.severity === "error");
	blocking.push(...claimOnly);

	const requested = runReport.termination.claimedTermination;
	let effective = requested;

	if (requested === "COMPLETED_AND_VERIFIED" && (!allSatisfied || blocking.length > 0)) {
		effective = "PREMATURE_COMPLETION";
	}

	const passed =
		allSatisfied &&
		forbidden.length === 0 &&
		invalidCompletion.length === 0 &&
		selfAuth.length === 0 &&
		invalidNA.length === 0 &&
		nonAuthErrors.length === 0 &&
		claimOnly.length === 0 &&
		requested === "COMPLETED_AND_VERIFIED";

	return { passed, requestedTermination: requested, effectiveTermination: effective, blockingFindings: blocking };
}
