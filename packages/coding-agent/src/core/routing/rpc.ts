/**
 * Versioned routing RPC service.
 *
 * Operations are read-only projections or explicit-gated mutations. Promotion
 * requires an authorized RPC. All payloads are bounded and free of credentials.
 */

import { activePolicyContext, activePolicyStatus, fixtureEvidence } from "./cli-helpers.js";
import { checkDriftHealth, type DriftDimension, detectDrift } from "./drift.js";
import { decide, replayDecision } from "./engine.js";
import { extractFeatures } from "./features.js";
import { comparePolicies, promotePolicy, rollbackPolicy, validatePromotionGates } from "./promotion.js";
import { listDecisions, listPolicies, listShadowDecisions, readPolicy } from "./store.js";
import type { CandidateEvidence, OrchestrationCandidate } from "./types.js";

export const ROUTING_RPC_VERSION = 1 as const;

export const ROUTING_RPC_OPERATIONS = [
	"routing.status",
	"routing.decide",
	"routing.explain",
	"routing.replay",
	"routing.compare",
	"routing.candidates",
	"routing.features",
	"routing.shadowStatus",
	"routing.shadowCompare",
	"routing.policyList",
	"routing.policyInspect",
	"routing.policyValidate",
	"routing.policyCompare",
	"routing.policyPromote",
	"routing.policyRollback",
	"routing.driftStatus",
	"routing.driftInspect",
] as const;

export type RoutingRpcOperation = (typeof ROUTING_RPC_OPERATIONS)[number];

export interface RoutingRpcRequest {
	version: typeof ROUTING_RPC_VERSION;
	requestId: string;
	operation: RoutingRpcOperation;
	parameters?: Record<string, string | number | boolean | string[] | Record<string, unknown>>;
}

export type RoutingRpcErrorKind = "invalid_operation" | "not_found" | "invalid_request" | "unauthorized";

export interface RoutingRpcError {
	error: RoutingRpcErrorKind;
	message: string;
}

export class RoutingRpcService {
	private evidenceCache: Record<string, CandidateEvidence> | undefined;

	private evidence(): Record<string, CandidateEvidence> {
		if (!this.evidenceCache) {
			this.evidenceCache = fixtureEvidence();
		}
		return this.evidenceCache;
	}

	handle(request: RoutingRpcRequest): RoutingRpcResponse | RoutingRpcError {
		if (request.version !== ROUTING_RPC_VERSION) {
			return { error: "invalid_request", message: `Unsupported routing RPC version ${request.version}` };
		}
		switch (request.operation) {
			case "routing.status":
				return { operation: request.operation, data: routingStatusPayload() };
			case "routing.decide": {
				const task = String(request.parameters?.task ?? "");
				if (!task) return { error: "invalid_request", message: "routing.decide requires task parameter" };
				const { decision, selectedCandidate } = decide({
					task,
					evidence: this.evidence(),
					policyContext: activePolicyContext(),
					operatorOverride: request.parameters?.overrideCandidateId
						? {
								authorizedBy: "rpc",
								candidateId: String(request.parameters.overrideCandidateId),
								reason: "operator override via RPC",
							}
						: undefined,
				});
				return {
					operation: request.operation,
					data: {
						decision,
						selectedCandidate: selectedCandidate ? summarizeCandidate(selectedCandidate) : undefined,
					},
				};
			}
			case "routing.explain": {
				const id = String(request.parameters?.decisionId ?? "");
				const d = replayDecision(id);
				return d ? { operation: request.operation, data: { decision: d } } : notFound(id);
			}
			case "routing.replay": {
				const id = String(request.parameters?.decisionId ?? "");
				const d = replayDecision(id);
				return d ? { operation: request.operation, data: { replay: "zero-effect", decision: d } } : notFound(id);
			}
			case "routing.compare": {
				const a = replayDecision(String(request.parameters?.a ?? ""));
				const b = replayDecision(String(request.parameters?.b ?? ""));
				return { operation: request.operation, data: { left: a, right: b } };
			}
			case "routing.candidates":
				return {
					operation: request.operation,
					data: {
						candidateSources: [
							"provider-profiles",
							"model-registry",
							"subagent-registry",
							"skill-registry",
							"retrieval-policies",
							"budget-classes",
						],
					},
				};
			case "routing.features": {
				const task = String(request.parameters?.task ?? "");
				return { operation: request.operation, data: { features: extractFeatures(task || "sample task") } };
			}
			case "routing.shadowStatus":
				return {
					operation: request.operation,
					data: { shadowDecisions: listShadowDecisions(10), zeroEffects: true },
				};
			case "routing.shadowCompare":
				return { operation: request.operation, data: { shadowComparisons: listShadowDecisions(10) } };
			case "routing.policyList":
				return {
					operation: request.operation,
					data: {
						policies: listPolicies().map((p) => ({
							policyId: p.policyId,
							policyVersion: p.policyVersion,
							status: p.status,
							sourceDatasetHash: p.sourceDatasetHash,
						})),
					},
				};
			case "routing.policyInspect": {
				const p = readPolicy(String(request.parameters?.policyId ?? ""));
				return p
					? { operation: request.operation, data: { policy: p } }
					: notFound(String(request.parameters?.policyId));
			}
			case "routing.policyValidate": {
				const p = readPolicy(String(request.parameters?.policyId ?? ""));
				if (!p) return notFound(String(request.parameters?.policyId));
				const gate = validatePromotionGates(p, this.evidence(), {
					safetyFloor: 0.5,
					correctnessFloor: 0.5,
					flakinessCeiling: 0.3,
					requiredScenarioPack: "routing",
					operatorAuthorized: true,
				});
				return {
					operation: request.operation,
					data: { policyId: p.policyId, valid: gate.passed, reasonCodes: gate.reasonCodes },
				};
			}
			case "routing.policyCompare": {
				const a = readPolicy(String(request.parameters?.a ?? ""));
				const b = readPolicy(String(request.parameters?.b ?? ""));
				if (!a || !b) return notFound("policy compare");
				return { operation: request.operation, data: comparePolicies(a, b) };
			}
			case "routing.policyPromote": {
				if (!request.parameters?.authorized)
					return { error: "unauthorized", message: "policy promotion requires explicit authorization" };
				const res = promotePolicy(String(request.parameters.policyId ?? ""), "rpc", this.evidence(), {
					safetyFloor: 0.5,
					correctnessFloor: 0.5,
					flakinessCeiling: 0.3,
					requiredScenarioPack: "routing",
					operatorAuthorized: true,
				});
				return { operation: request.operation, data: res };
			}
			case "routing.policyRollback": {
				if (!request.parameters?.authorized)
					return { error: "unauthorized", message: "policy rollback requires explicit authorization" };
				const res = rollbackPolicy(String(request.parameters.policyId ?? ""), "rpc");
				return { operation: request.operation, data: res };
			}
			case "routing.driftStatus":
				return { operation: request.operation, data: { drift: checkDriftHealth(), dimensions: DRIFT_DIMS } };
			case "routing.driftInspect": {
				const dim = String(request.parameters?.dimension ?? "quality") as DriftDimension;
				return { operation: request.operation, data: detectDrift(DRIFT_DIMS.includes(dim) ? dim : "quality", 0.1) };
			}
			default:
				return { error: "invalid_operation", message: `Unknown routing RPC operation ${request.operation}` };
		}
	}
}

export type RoutingRpcResponse = { operation: RoutingRpcOperation; data: unknown };

function summarizeCandidate(c: OrchestrationCandidate): unknown {
	return {
		providerProfile: c.providerProfile,
		configuredModel: c.configuredModel,
		executionTopology: c.executionTopology,
		retrievalPolicy: c.retrievalPolicy,
		budgetClass: c.budgetClass,
	};
}

function notFound(id: string): RoutingRpcError {
	return { error: "not_found", message: `Not found: ${id}` };
}

const DRIFT_DIMS: DriftDimension[] = [
	"quality",
	"cost",
	"latency",
	"failure_cluster",
	"retrieval",
	"task_distribution",
	"flakiness",
	"policy_selection",
];

function routingStatusPayload(): unknown {
	return {
		activePolicy: activePolicyStatus(),
		decisionsCount: listDecisions(10).length,
		recentDecisions: listDecisions(5).map((d) => ({
			decisionId: d.decisionId,
			policyId: d.policyId,
			policyVersion: d.policyVersion,
			selectedCandidateId: d.selectedCandidateId,
			confidence: d.confidence,
		})),
		shadowCount: listShadowDecisions(10).length,
		driftHealth: checkDriftHealth(),
	};
}
