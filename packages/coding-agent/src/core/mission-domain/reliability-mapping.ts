/**
 * Reliability Kernel mapping (2.3.0).
 *
 * Bridges the first-class mission domain and the Reliability Kernel's
 * MissionRuntime without duplicating completion semantics. A MissionRequest
 * that carries deterministic verification specs for its acceptance criteria can
 * initialize a real MissionRuntime contract; the Completion Gate and Evidence
 * Store remain the single source of verified success.
 */

import { buildMissionContract, type MissionDefinitionInput } from "../reliability/mission-contract-factory.js";
import { MissionRuntime } from "../reliability/mission-runtime.js";
import type { MissionRequest } from "./mission-request.js";

/**
 * Map a MissionRequest to a Reliability Kernel MissionDefinitionInput.
 *
 * Criteria with a `verification` spec map 1:1 (source `user`, preserving the
 * deterministic verification spec). Criteria without a `verification` spec
 * cannot be mapped because the kernel requires every acceptance criterion to be
 * satisfiable only by authoritative evidence; the mapping fails explicitly
 * rather than fabricating a verification spec.
 */
export function toMissionRuntimeDefinition(request: MissionRequest): MissionDefinitionInput {
	const criteria = request.acceptanceCriteria.map((criterion) => {
		if (!criterion.verification) {
			throw new Error(
				`MissionRequest criterion "${criterion.id}" has no deterministic verification and cannot map to a MissionRuntime contract`,
			);
		}
		return {
			id: criterion.id,
			description: criterion.description,
			source: "user" as const,
			verification: criterion.verification,
		};
	});

	return {
		missionId: request.missionId,
		goal: request.objective,
		criteria,
	};
}

/**
 * Build a real Reliability Kernel MissionRuntime from a MissionRequest.
 *
 * Throws if any acceptance criterion is unverifiable (mapping is rejected
 * explicitly) or if the derived contract is invalid. The returned runtime is
 * the same authority used by the live AgentSession.
 */
export function createMissionRuntimeFromRequest(request: MissionRequest): MissionRuntime {
	const definition = toMissionRuntimeDefinition(request);
	// Validate the contract before constructing the runtime.
	buildMissionContract(definition);
	return MissionRuntime.create(definition);
}
