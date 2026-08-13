/**
 * Mission Contract Factory — derives a durable MissionContractV1 from a user
 * goal plus explicit/derived acceptance criteria.
 *
 * The factory distinguishes user-required criteria from system-derived
 * verification criteria without rewriting the user's requirements:
 *   - `user`    → EXPLICIT requirement
 *   - `system`  → INFERRED requirement (Jensen runtime policy)
 *   - `derived` → INFERRED requirement (derived from the goal)
 *
 * Every criterion becomes one requirement (same id) with one acceptance
 * criterion whose `requiredEvidence` is derived from its deterministic
 * verification spec.
 */

import type { MissionConstraint, MissionContractV1, MissionRequirement } from "../long-horizon/index.js";
import type { ConstraintKind, ConstraintSeverity } from "../long-horizon/types.js";
import { evidenceRequirementForKind } from "./evidence-mapping.js";
import type { CriterionSource, VerificationSpec } from "./types.js";

export interface MissionCriterionInput {
	id: string;
	description: string;
	source: CriterionSource;
	verification: VerificationSpec;
}

export interface MissionConstraintInput {
	id: string;
	statement: string;
	kind: ConstraintKind;
	severity: ConstraintSeverity;
}

export interface MissionForbiddenActionInput {
	id: string;
	statement: string;
	matchHint?: string;
}

export interface MissionDefinitionInput {
	missionId: string;
	goal: string;
	criteria: MissionCriterionInput[];
	constraints?: MissionConstraintInput[];
	forbiddenActions?: MissionForbiddenActionInput[];
	/** Bump to force a new contract revision (digest changes). */
	revision?: number;
}

export const MISSION_WORKSTREAM_ID = "mission";

export function buildMissionContract(input: MissionDefinitionInput): MissionContractV1 {
	if (input.criteria.length === 0) {
		throw new Error("A mission requires at least one acceptance criterion");
	}

	const requirements: MissionRequirement[] = input.criteria.map((criterion) => {
		const kind = criterion.source === "user" ? "EXPLICIT" : "INFERRED";
		return {
			id: criterion.id,
			workstreamId: MISSION_WORKSTREAM_ID,
			kind,
			statement: criterion.description,
			rationale:
				kind === "INFERRED"
					? criterion.source === "system"
						? "Jensen runtime verification requirement"
						: "Derived from the mission goal"
					: undefined,
			sourceRefs: [],
			dependencies: [],
			acceptanceCriteria: [
				{
					id: criterion.id,
					statement: criterion.description,
					requiredEvidence: evidenceRequirementForKind(criterion.verification.kind),
				},
			],
		};
	});

	const constraints: MissionConstraint[] = (input.constraints ?? []).map((c) => ({
		id: c.id,
		kind: c.kind,
		statement: c.statement,
		sourceRefs: [],
		severity: c.severity,
	}));

	const forbiddenActions = (input.forbiddenActions ?? []).map((a) => ({
		id: a.id,
		statement: a.statement,
		sourceRefs: [],
		severity: "error" as const,
		matchHint: a.matchHint,
	}));

	return {
		contractVersion: 1,
		missionId: input.missionId,
		revision: input.revision ?? 0,
		title: input.goal.slice(0, 120),
		objective: input.goal,
		workstreams: [{ id: MISSION_WORKSTREAM_ID, title: "Mission", order: 0 }],
		requirements,
		constraints,
		forbiddenActions,
		evidencePolicy: {
			authoritativeSources: [
				"command-result",
				"test-result",
				"repository-observation",
				"runtime-observation",
				"operator-confirmation",
				"trusted-collector",
			],
			rules: [],
		},
		metadata: { criteria: input.criteria.map((c) => ({ id: c.id, source: c.source })) },
	};
}
