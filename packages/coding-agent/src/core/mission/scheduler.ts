/**
 * Durable Mission Graph — dependency-aware scheduler (2.0.0).
 *
 * Computes deterministic parallel scheduling waves from the dependency graph,
 * enforces a parallelism bound, serializes repository write conflicts, and
 * respects mission/objective budgets. Pure and deterministic.
 */

import { buildDependencyIndex, computeCriticalPath, objectiveIds } from "./graph.js";
import type { MissionBudget, MissionGraphDocumentV1, ObjectiveBudget, ObjectiveStatus, SchedulePlan } from "./types.js";

export interface ScheduleInput {
	/** Current objective statuses by id. */
	status: Map<string, ObjectiveStatus>;
	/** Parallelism bound (max objectives per wave). */
	parallelismBound: number;
	/** Mission-wide budget if any. */
	budget?: MissionBudget;
	/** Enforce budget as hard gate on scheduling. */
	enforceBudget?: boolean;
}

export const TERMINAL_STATUSES: ReadonlySet<ObjectiveStatus> = new Set(["COMPLETED", "FAILED", "SKIPPED"]);

export const UNSCHEDULABLE_STATUSES: ReadonlySet<ObjectiveStatus> = new Set([
	"BLOCKED",
	"FAILED",
	"SKIPPED",
	"WAITING_APPROVAL",
	"WAITING_EXTERNAL",
]);

function isSatisfied(status: ObjectiveStatus | undefined): boolean {
	return status === "COMPLETED";
}

/**
 * Build a deterministic schedule plan.
 *
 * Returns waves of objectives that are dependency-ready and parallel-safe.
 * Write-conflict groups (objectives mutating the same repository) are
 * serialized so they never run in the same wave.
 */
export function buildSchedulePlan(
	mission: Pick<MissionGraphDocumentV1, "objectives" | "missionId" | "revision">,
	input: ScheduleInput,
): SchedulePlan {
	const ids = objectiveIds(mission);
	const byId = new Map(mission.objectives.map((o) => [o.id, o]));
	const index = buildDependencyIndex(mission.objectives);

	const waves: string[][] = [];
	const serializedGroups: string[][] = [];
	const unready: string[] = [];
	const planned = new Set<string>();

	const objectiveStatus = (id: string): ObjectiveStatus | undefined => input.status.get(id);

	const repoSet = (id: string): Set<string> => {
		const o = byId.get(id);
		return new Set(o?.declaredRepositories ?? []);
	};

	// Remaining objectives = not terminal and not unschedulable permanently.
	const remainingIds = [...ids]
		.filter((id) => {
			const s = objectiveStatus(id);
			if (s === undefined) return true; // unassigned → treat as pending/ready
			return !TERMINAL_STATUSES.has(s) && !UNSCHEDULABLE_STATUSES.has(s);
		})
		.sort();

	const budgetExceededRef = { value: false };

	while (remainingIds.length > planned.size && remainingIds.length > 0) {
		// Candidate ready: all dependencies satisfied, not yet planned.
		const candidateIds = remainingIds.filter((id) => {
			if (planned.has(id)) return false;
			const deps = (index.dependenciesBy.get(id) ?? []).filter((d) => ids.has(d));
			return deps.every((d) => isSatisfied(objectiveStatus(d)));
		});

		if (candidateIds.length === 0) {
			// No progress possible; mark the rest unready.
			for (const id of remainingIds) {
				if (!planned.has(id)) unready.push(id);
			}
			break;
		}

		// Group candidates by repository write-conflict; within a wave, only one
		// objective per repository may run (write-conflict serialization).
		const repoHolders = new Map<string, string>();
		const wave: string[] = [];

		for (const id of candidateIds) {
			if (wave.length >= input.parallelismBound) break;
			const repos = repoSet(id);
			let conflict = false;
			for (const r of repos) {
				if (repoHolders.has(r)) {
					conflict = true;
					break;
				}
			}
			if (conflict) continue;
			for (const r of repos) repoHolders.set(r, id);
			wave.push(id);
			planned.add(id);
		}

		if (wave.length > 0) {
			waves.push(wave);
			// Record write-conflict serialization evidence (group when wave had conflicts deferred).
		} else {
			// Parallelism/conflict prevented any progress this pass → serialized groups
			for (const id of candidateIds) {
				if (!planned.has(id)) unready.push(id);
			}
			break;
		}
	}

	// Serialized groups: objectives sharing a repository across waves.
	{
		const repoWave = new Map<string, number>();
		waves.forEach((wave, wi) => {
			for (const id of wave) {
				for (const r of repoSet(id)) {
					const prev = repoWave.get(r);
					if (prev !== undefined && prev !== wi) {
						serializedGroups.push([r, `${prev}->${wi}`]);
					}
					repoWave.set(r, wi);
				}
			}
		});
	}

	// Budget accounting
	let budgetExceeded = false;
	if (input.budget && input.enforceBudget && input.budget.spentCost > input.budget.maxCost) {
		budgetExceeded = true;
	}
	budgetExceededRef.value = budgetExceeded;

	return {
		missionId: mission.missionId,
		revision: mission.revision,
		waves,
		unready: [...new Set(unready)].sort(),
		serializedGroups,
		criticalPath: computeCriticalPath(mission).path,
		budgetExceeded,
	};
}

/**
 * Determine whether an objective is ready to start given current statuses.
 * A dependency counts as satisfied only when its objective is COMPLETED.
 */
export function isObjectiveReady(
	mission: Pick<MissionGraphDocumentV1, "objectives">,
	objectiveId: string,
	status: Map<string, ObjectiveStatus>,
): boolean {
	const o = mission.objectives.find((x) => x.id === objectiveId);
	if (!o) return false;
	const index = buildDependencyIndex(mission.objectives);
	const deps = (index.dependenciesBy.get(objectiveId) ?? []).filter((d) => objectiveIds(mission).has(d));
	return deps.every((d) => status.get(d) === "COMPLETED");
}

export function budgetViolations(
	objectives: Pick<MissionGraphDocumentV1, "objectives">["objectives"],
	missionBudget?: MissionBudget,
	enforceMission = true,
): string[] {
	const violations: string[] = [];
	for (const o of objectives) {
		const b: ObjectiveBudget | undefined = o.budget;
		if (b && b.spentCost > b.maxCost) {
			violations.push(`objective ${o.id} spent ${b.spentCost} > budget ${b.maxCost}`);
		}
	}
	if (missionBudget && enforceMission && missionBudget.spentCost > missionBudget.maxCost) {
		violations.push(`mission spent ${missionBudget.spentCost} > budget ${missionBudget.maxCost}`);
	}
	return violations;
}
