/**
 * Durable Mission Graph — graph construction, validation, hashing,
 * critical-path analysis and topological ordering (2.0.0).
 *
 * Pure, deterministic functions. No I/O.
 */

import { createHash } from "node:crypto";
import { toCanonicalJson } from "../long-horizon/canonical-json.js";
import type {
	CriticalPathResult,
	GraphValidationResult,
	MissionContract,
	MissionGraphDocumentV1,
	MissionObjective,
	MissionScope,
	ValidationIssue,
} from "./types.js";
import { MISSION_SCHEMA_VERSION } from "./types.js";

// =============================================================================
// Canonical digest
// =============================================================================

/**
 * Compute the canonical semantic digest of a mission's scope, objectives and
 * contracts. Non-semantic fields (status, timestamps, observed repositories)
 * are excluded so that the digest is stable across execution bookkeeping.
 */
export function computeMissionGraphDigest(
	scope: MissionScope,
	objectives: MissionObjective[],
	contracts: MissionContract[],
): string {
	const payload = {
		schemaVersion: MISSION_SCHEMA_VERSION,
		scope,
		objectives: sortObjectivesById(objectives),
		contracts: sortContractsById(contracts),
	};
	const canonical = toCanonicalJson(payload);
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function sortObjectivesById(objectives: MissionObjective[]): MissionObjective[] {
	return [...objectives].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortContractsById(contracts: MissionContract[]): MissionContract[] {
	return [...contracts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// =============================================================================
// Dependency indexing
// =============================================================================

export function objectiveIds(mission: Pick<MissionGraphDocumentV1, "objectives">): Set<string> {
	const ids = new Set<string>();
	for (const o of mission.objectives) ids.add(o.id);
	return ids;
}

export interface DependencyIndex {
	/** For each objective, its direct dependencies. */
	dependenciesBy: Map<string, string[]>;
	/** For each objective, the objectives that depend on it (reverse edges). */
	dependentsBy: Map<string, string[]>;
}

export function buildDependencyIndex(objectives: MissionObjective[]): DependencyIndex {
	const dependenciesBy = new Map<string, string[]>();
	const dependentsBy = new Map<string, string[]>();
	for (const o of objectives) {
		dependenciesBy.set(o.id, [...o.dependencies]);
		for (const dep of o.dependencies) {
			const list = dependentsBy.get(dep) ?? [];
			list.push(o.id);
			dependentsBy.set(dep, list);
		}
	}
	return { dependenciesBy, dependentsBy };
}

// =============================================================================
// Graph validation
// =============================================================================

/**
 * Validate a mission graph document deterministically.
 *
 * Checks: unique ids, missing dependencies, dependency cycles, explicit
 * acceptance criteria, declared repositories, scope integrity, self-approval.
 */
export function validateMissionGraph(mission: MissionGraphDocumentV1): GraphValidationResult {
	const issues: ValidationIssue[] = [];
	const ids = objectiveIds(mission);

	// Unique objective ids
	{
		const seen = new Set<string>();
		for (const o of mission.objectives) {
			if (seen.has(o.id)) {
				issues.push({ path: `objectives[${o.id}]`, message: `duplicate objective id`, severity: "error" });
			}
			seen.add(o.id);
		}
	}

	// Missing dependencies
	const missingDependencies: string[] = [];
	for (const o of mission.objectives) {
		for (const dep of o.dependencies) {
			if (!ids.has(dep)) {
				missingDependencies.push(`${o.id}->${dep}`);
			}
		}
		for (const branch of [...o.dependencies]) {
			void branch;
		}
	}
	if (missingDependencies.length > 0) {
		issues.push({
			path: "dependencies",
			message: `missing dependencies: ${missingDependencies.join(", ")}`,
			severity: "error",
		});
	}

	// Cycles via DFS
	const cycles = detectCycles(mission);
	if (cycles.length > 0) {
		for (const cycle of cycles) {
			issues.push({
				path: "dependencies.cycles",
				message: `dependency cycle detected: ${cycle.join(" -> ")}`,
				severity: "error",
			});
		}
	}

	// Acceptance criteria explicit
	for (const o of mission.objectives) {
		if (o.acceptanceCriteria.length === 0) {
			issues.push({
				path: `objectives[${o.id}].acceptanceCriteria`,
				message: `objective '${o.id}' has no explicit acceptance criteria`,
				severity: "error",
			});
		}
	}

	// Declared repositories within scope
	const undeclaredRepositories: string[] = [];
	if (mission.scope.requireDeclaredRepositories) {
		const declared = new Set(mission.scope.repositories);
		for (const o of mission.objectives) {
			for (const repo of o.declaredRepositories) {
				if (!declared.has(repo)) {
					const key = `${o.id}__${repo}`;
					if (!undeclaredRepositories.includes(key)) undeclaredRepositories.push(key);
				}
			}
		}
	}
	if (undeclaredRepositories.length > 0) {
		issues.push({
			path: "scope.repositories",
			message: `undeclared repositories: ${undeclaredRepositories.join(", ")}`,
			severity: "error",
		});
	}

	// No self-approval: an objective requiring approval must not grant itself.
	let noSelfApproval = true;
	for (const o of mission.objectives) {
		if (o.approvalGate?.requiredPrincipals.includes(o.id)) {
			noSelfApproval = false;
			issues.push({
				path: `objectives[${o.id}].approvalGate`,
				message: `objective '${o.id}' is its own approval principal`,
				severity: "error",
			});
		}
	}

	// Contract producer/consumer linkage
	for (const c of mission.contracts) {
		if (c.producerObjective && !ids.has(c.producerObjective)) {
			issues.push({
				path: `contracts[${c.id}].producerObjective`,
				message: `contract '${c.id}' references unknown producer '${c.producerObjective}'`,
				severity: "error",
			});
		}
		if (!ids.has(c.consumerObjective)) {
			issues.push({
				path: `contracts[${c.id}].consumerObjective`,
				message: `contract '${c.id}' references unknown consumer '${c.consumerObjective}'`,
				severity: "error",
			});
		}
	}

	const valid = issues.every((i) => i.severity === "warning");
	const digest = computeMissionGraphDigest(mission.scope, mission.objectives, mission.contracts);

	return {
		valid,
		digest,
		revision: mission.revision,
		errors: issues,
		cycles,
		missingDependencies,
		undeclaredRepositories,
		noSelfApproval,
	};
}

/**
 * Detect all strongly-connected dependency cycles.
 * Returns one representative path per cycle.
 */
export function detectCycles(mission: Pick<MissionGraphDocumentV1, "objectives">): string[][] {
	const index = buildDependencyIndex(mission.objectives);
	const cycles: string[][] = [];
	const state = new Map<string, number>(); // 0=unvisited,1=visiting,2=done
	const stack: string[] = [];

	const visit = (id: string): void => {
		const st = state.get(id) ?? 0;
		if (st === 2) return;
		if (st === 1) {
			// Found a back edge: the cycle is from current position in stack back to id
			const start = stack.indexOf(id);
			const cycle = start >= 0 ? stack.slice(start).concat(id) : [id];
			// Only record minimal cycles
			if (!cycles.some((c) => c.join(",") === cycle.join(","))) {
				cycles.push(cycle);
			}
			return;
		}
		state.set(id, 1);
		stack.push(id);
		const deps = index.dependenciesBy.get(id) ?? [];
		for (const dep of deps) {
			visit(dep);
		}
		stack.pop();
		state.set(id, 2);
	};

	for (const o of mission.objectives) {
		if ((state.get(o.id) ?? 0) === 0) visit(o.id);
	}
	return cycles;
}

// =============================================================================
// Topological order
// =============================================================================

/**
 * Produce a deterministic topological order of objectives (dependency-first).
 * Returns only objectives whose declared dependencies exist and are acyclic.
 */
export function topologicallyOrdered(mission: Pick<MissionGraphDocumentV1, "objectives">): string[] {
	const ids = objectiveIds(mission);
	const index = buildDependencyIndex(mission.objectives);
	const order: string[] = [];
	const state = new Map<string, number>();
	const sortedIds = [...ids].sort();

	// Kahn's algorithm with deterministic (sorted) ordering.
	const indegree = new Map<string, number>();
	for (const id of sortedIds) {
		const deps = (index.dependenciesBy.get(id) ?? []).filter((d) => ids.has(d));
		indegree.set(id, deps.length);
	}
	const ready: string[] = sortedIds.filter((id) => (indegree.get(id) ?? 0) === 0);
	const queue = [...ready].sort();

	while (queue.length > 0) {
		const id = queue.shift() as string;
		order.push(id);
		state.set(id, 2);
		const dependents = (index.dependentsBy.get(id) ?? []).filter((d) => ids.has(d)).sort();
		for (const dep of dependents) {
			const deg = (indegree.get(dep) ?? 0) - 1;
			indegree.set(dep, deg);
			if (deg === 0) queue.push(dep);
		}
		queue.sort();
	}

	return order;
}

// =============================================================================
// Critical path
// =============================================================================

/**
 * Longest dependency chain (by summed estimate). Deterministic tie-breaking
 * by objective id. Ignores missing/cyclic references; only considers
 * dependencies present in the graph.
 */
export function computeCriticalPath(mission: Pick<MissionGraphDocumentV1, "objectives">): CriticalPathResult {
	const ids = objectiveIds(mission);
	const byId = new Map(mission.objectives.map((o) => [o.id, o]));
	const index = buildDependencyIndex(mission.objectives);
	const distance = new Map<string, number>();
	const predecessor = new Map<string, string | undefined>();

	const compute = (id: string): number => {
		const cached = distance.get(id);
		if (cached !== undefined) return cached;
		const node = byId.get(id);
		if (!node) {
			distance.set(id, 0);
			return 0;
		}
		const deps = (index.dependenciesBy.get(id) ?? []).filter((d) => ids.has(d));
		let bestDist = 0;
		let bestPred: string | undefined;
		for (const dep of deps) {
			const d = compute(dep);
			// Prefer larger distance, then smaller predecessor id for determinism.
			if (d > bestDist || (d === bestDist && (bestPred === undefined || dep < bestPred))) {
				bestDist = d;
				bestPred = dep;
			}
		}
		distance.set(id, bestDist + (node.estimate || 0));
		predecessor.set(id, bestPred);
		return bestDist + (node.estimate || 0);
	};

	let maxDist = -1;
	let endNode: string | undefined;
	for (const id of ids) {
		const d = compute(id);
		if (d > maxDist) {
			maxDist = d;
			endNode = id;
		}
	}

	// Reconstruct path
	const path: string[] = [];
	let cur: string | undefined = endNode;
	while (cur !== undefined) {
		path.unshift(cur);
		cur = predecessor.get(cur);
	}

	return { path, weight: maxDist < 0 ? 0 : maxDist };
}

/**
 * Build a fresh MissionGraphDocumentV1 from parts, computing digest and
 * enforcing the canonical schema version.
 */
export function buildMissionDocument(
	missionId: string,
	scope: MissionScope,
	objectives: MissionObjective[],
	contracts: MissionContract[],
	revision = 1,
	status: MissionGraphDocumentV1["status"] = "DRAFT",
	nowMs = Date.now(),
): MissionGraphDocumentV1 {
	const digest = computeMissionGraphDigest(scope, objectives, contracts);
	return {
		schemaVersion: MISSION_SCHEMA_VERSION,
		missionId,
		revision,
		digest,
		scope,
		objectives,
		contracts,
		status,
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
	};
}
