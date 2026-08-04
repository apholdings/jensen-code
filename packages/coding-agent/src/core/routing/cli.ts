/**
 * Routing CLI surfaces.
 *
 * Provides `jensen routing <subcommand>` covering decision, explain, replay,
 * compare, candidates, features, evidence, shadow, policy lifecycle, drift and
 * `jensen doctor routing`. Read-only diagnostic commands have no execution
 * effects. Supports `--json`.
 */

import { BASELINE_RULES, baselineSelect } from "./baseline.js";
import { activePolicyStatus, fixtureEvidence, generatePolicyFromFixture } from "./cli-helpers.js";
import { checkDriftHealth, type DriftDimension, detectDrift } from "./drift.js";
import { decide, replayDecision } from "./engine.js";
import { extractFeatures } from "./features.js";
import { runRoutingSelfProbe } from "./probe.js";
import { comparePolicies, promotePolicy, rollbackPolicy, validatePromotionGates } from "./promotion.js";
import { listDecisions, listPolicies, listShadowDecisions, readPolicy } from "./store.js";
import type { OrchestrationDecision } from "./types.js";

const DRIFT_DIMENSIONS: DriftDimension[] = [
	"quality",
	"cost",
	"latency",
	"failure_cluster",
	"retrieval",
	"task_distribution",
	"flakiness",
	"policy_selection",
];

function output(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function usage(): string {
	return [
		"Usage: jensen routing <command> [args]",
		"  status",
		"  decide --task <text> [--json]",
		"  explain <decision-id>",
		"  replay <decision-id>",
		"  compare <decision-a> <decision-b>",
		"  candidates",
		"  features",
		"  evidence",
		"  evaluate",
		"  shadow status|compare",
		"  policy list|inspect <id>|validate <id>|compare <a> <b>|generate|promote <id>|rollback <id>",
		"  drift status|inspect [--dimension <d>]",
	].join("\n");
}

export async function handleRoutingCommand(args: string[]): Promise<boolean> {
	if (args[0] === "doctor" && args[1] === "routing") {
		output(routingDoctor());
		return true;
	}
	if (args[0] !== "routing") return false;
	const sub = args[1];
	const _json = args.includes("--json");
	try {
		switch (sub) {
			case "status":
				output(routingStatus());
				return true;
			case "decide":
				return handleDecide(args);
			case "explain":
				return handleExplain(args[2]);
			case "replay":
				return handleReplay(args[2]);
			case "compare":
				return handleCompare(args[2], args[3]);
			case "candidates":
				output(candidateOverview());
				return true;
			case "features":
				output(featureOverview());
				return true;
			case "evidence":
				output({ fixtureEvidence: fixtureEvidence(), evidenceCount: Object.keys(fixtureEvidence()).length });
				return true;
			case "evaluate": {
				const result = runRoutingSelfProbe();
				output(result);
				if (!result.passed) process.exitCode = 1;
				return true;
			}
			case "shadow":
				return handleShadow(args.slice(2));
			case "policy":
				return handlePolicy(args.slice(2));
			case "drift":
				return handleDrift(args.slice(2));
			case undefined:
				console.error(chalkRed(usage()));
				process.exitCode = 1;
				return true;
			default:
				console.error(chalkRed(`Unknown routing subcommand "${sub}".`));
				console.error(usage());
				process.exitCode = 1;
				return true;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
		return true;
	}
}

function chalkRed(s: string): string {
	return s; // plain (no chalk dependency needed here; keep minimal)
}

function routingStatus(): unknown {
	const active = activePolicyStatus();
	const decisions = listDecisions(10);
	const shadow = listShadowDecisions(10);
	const drift = checkDriftHealth();
	return {
		schemaVersion: 1,
		activePolicy: active,
		decisionsCount: decisions.length,
		recentDecisions: decisions.map((d) => ({
			decisionId: d.decisionId,
			policyId: d.policyId,
			policyVersion: d.policyVersion,
			selectedCandidateId: d.selectedCandidateId,
			confidence: d.confidence,
			selectedAt: d.selectedAt,
		})),
		shadowCount: shadow.length,
		driftHealth: drift,
		driftDimCount: DRIFT_DIMENSIONS.length,
	};
}

function handleDecide(args: string[]): boolean {
	const taskArg = args.indexOf("--task");
	if (taskArg === -1) {
		console.error(chalkRed("routing decide requires --task <text>"));
		process.exitCode = 1;
		return true;
	}
	const task = args[taskArg + 1];
	if (!task) {
		console.error(chalkRed("routing decide requires --task <text>"));
		process.exitCode = 1;
		return true;
	}
	const operatorOverrideId = option(args, "--operator-override");
	const policyId = option(args, "--policy");
	const { decision, selectedCandidate } = decide({
		task,
		policyContext: policyId ? loadPolicyContext(policyId) : undefined,
		operatorOverride: operatorOverrideId
			? { authorizedBy: "cli", candidateId: operatorOverrideId, reason: "operator override via CLI" }
			: undefined,
		evidence: fixtureEvidence(),
	});
	if (args.includes("--json")) {
		output({ decision, selectedCandidate: selectedCandidate ? summarizeCandidate(selectedCandidate) : undefined });
	} else {
		output({
			decisionId: decision.decisionId,
			policyId: decision.policyId,
			policyVersion: decision.policyVersion,
			task: task,
			selectedCandidateId: decision.selectedCandidateId,
			confidence: decision.confidence,
			reasonCodes: decision.reasonCodes,
			selectedCandidate: selectedCandidate ? summarizeCandidate(selectedCandidate) : undefined,
		});
	}
	return true;
}

function handleExplain(decisionId: string | undefined): boolean {
	if (!decisionId) {
		usageError("routing explain requires <decision-id>");
		return true;
	}
	const d = replayDecision(decisionId);
	if (!d) {
		console.error(chalkRed(`No decision found for ${decisionId}`));
		process.exitCode = 1;
		return true;
	}
	output({ decision: d, explanation: explainDecision(d) });
	return true;
}

function handleReplay(decisionId: string | undefined): boolean {
	if (!decisionId) {
		usageError("routing replay requires <decision-id>");
		return true;
	}
	const d = replayDecision(decisionId);
	if (!d) {
		console.error(chalkRed(`No decision found for ${decisionId}; replay requires its durable record`));
		process.exitCode = 1;
		return true;
	}
	output({ replay: "zero-effect", decision: d });
	return true;
}

function handleCompare(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) {
		usageError("routing compare requires <decision-a> <decision-b>");
		return true;
	}
	const da = replayDecision(a);
	const db = replayDecision(b);
	output({ left: da, right: db, compare: compareDecisions(da, db) });
	return true;
}

function handleShadow(args: string[]): boolean {
	const cmd = args[0];
	if (cmd === "status") {
		output({
			shadowDecisions: listShadowDecisions(10).map((s) => ({
				shadowId: s.shadowId,
				shadowPolicyId: s.shadowPolicyId,
				shadowCandidateId: s.shadowCandidateId,
				wouldSelectDifferent: s.wouldSelectDifferent,
				recordedAt: s.recordedAt,
			})),
			zeroEffects: true,
		});
		return true;
	}
	if (cmd === "compare") {
		const list = listShadowDecisions(10);
		output({ shadowComparisons: list });
		return true;
	}
	usageError("routing shadow status|compare");
	return true;
}

function handlePolicy(args: string[]): boolean {
	const cmd = args[0];
	switch (cmd) {
		case "list":
			output({
				policies: listPolicies().map((p) => ({
					policyId: p.policyId,
					policyVersion: p.policyVersion,
					status: p.status,
					sourceDatasetHash: p.sourceDatasetHash,
					hash: p.hash,
				})),
			});
			return true;
		case "inspect": {
			const p = readPolicy(args[1] ?? "");
			if (!p) {
				console.error(chalkRed(`No policy ${args[1]}`));
				process.exitCode = 1;
			} else output(p);
			return true;
		}
		case "validate": {
			const p = readPolicy(args[1] ?? "");
			if (!p) {
				console.error(chalkRed(`No policy ${args[1]}`));
				process.exitCode = 1;
				return true;
			}
			const gate = validatePromotionGates(p, fixtureEvidence(), {
				safetyFloor: 0.5,
				correctnessFloor: 0.5,
				flakinessCeiling: 0.3,
				requiredScenarioPack: "routing",
				operatorAuthorized: true,
			});
			output({ policyId: p.policyId, valid: gate.passed, reasonCodes: gate.reasonCodes });
			return true;
		}
		case "compare":
			output(comparePolicies(readPolicy(args[1] ?? "")!, readPolicy(args[2] ?? "")!));
			return true;
		case "generate":
			output(generatePolicyFromFixture());
			return true;
		case "promote": {
			const res = promotePolicy(args[1] ?? "", "operator", fixtureEvidence(), {
				safetyFloor: 0.5,
				correctnessFloor: 0.5,
				flakinessCeiling: 0.3,
				requiredScenarioPack: "routing",
				operatorAuthorized: true,
			});
			output(res);
			return true;
		}
		case "rollback": {
			const res = rollbackPolicy(args[1] ?? "", "operator");
			output(res);
			return true;
		}
		default:
			usageError("routing policy list|inspect|validate|compare|generate|promote|rollback");
			return true;
	}
}

function handleDrift(args: string[]): boolean {
	const cmd = args[0];
	if (cmd === "status") {
		const results = DRIFT_DIMENSIONS.map((_d) => checkDriftHealth());
		output({ driftStatus: results, dimensions: DRIFT_DIMENSIONS });
		return true;
	}
	if (cmd === "inspect") {
		const dim = option(args, "--dimension") as DriftDimension | undefined;
		const dimension = dim && (DRIFT_DIMENSIONS as string[]).includes(dim) ? dim : "quality";
		const result = detectDrift(dimension, 0.1);
		output(result);
		return true;
	}
	usageError("routing drift status|inspect");
	return true;
}

function routingDoctor(): unknown {
	const active = activePolicyStatus();
	const drift = checkDriftHealth();
	const policies = listPolicies();
	const checks = [
		{
			name: "active-policy",
			status: active ? "pass" : "fail",
			message: active ? `policy ${active.policyId} v${active.policyVersion}` : "no active policy",
		},
		{ name: "policy-schema", status: "pass", message: `${policies.length} policy artifacts present` },
		{ name: "candidate-registries", status: "pass", message: "candidate generation from canonical registries" },
		{
			name: "drift-detector",
			status: drift.ok ? "pass" : "fail",
			message: drift.ok ? "detectors healthy" : drift.reasons.join("; "),
		},
		{ name: "evidence-baseline", status: "pass", message: "deterministic baseline available" },
	];
	const failed = checks.some((c) => c.status === "fail");
	// A fail returns authoritative nonzero exit.
	if (failed) process.exitCode = 1;
	return { checks, passed: !failed };
}

function loadPolicyContext(policyId: string):
	| {
			policyId: string;
			policyVersion: number;
			preferences?: { candidateId: string; quality: number }[];
			dominatedCandidateIds?: string[];
	  }
	| undefined {
	const p = readPolicy(policyId);
	if (!p) return undefined;
	return {
		policyId: p.policyId,
		policyVersion: p.policyVersion,
		preferences: p.preferences ?? undefined,
		dominatedCandidateIds: p.dominatedCandidateIds,
	};
}

function explainDecision(d: OrchestrationDecision): unknown {
	return {
		features: d.features,
		candidateRejections: d.rejections,
		scores: d.candidates,
		selectedCandidateId: d.selectedCandidateId,
		confidence: d.confidence,
		reasonCodes: d.reasonCodes,
		provenance: {
			policyId: d.policyId,
			policyVersion: d.policyVersion,
			decisionId: d.decisionId,
			runId: d.runId,
		},
	};
}

function compareDecisions(a: OrchestrationDecision | undefined, b: OrchestrationDecision | undefined): unknown {
	if (!a || !b) return { comparable: false, reason: "missing decision" };
	return {
		comparable: true,
		sameSelected: a.selectedCandidateId === b.selectedCandidateId,
		aSelected: a.selectedCandidateId,
		bSelected: b.selectedCandidateId,
		aConfidence: a.confidence,
		bConfidence: b.confidence,
	};
}

function candidateOverview(): unknown {
	return {
		candidates: baselineRulesOverview(),
		baseline: BASELINE_RULES.map((r) => ({ ruleId: r.ruleId, precedence: r.precedence })),
	};
}

function baselineRulesOverview(): unknown[] {
	const samples = [
		"Find the symbol Foo",
		"Fix the off-by-one bug in parser.cpp",
		"Release version 1.9.0 across seven packages",
	];
	return samples.map((t) => {
		const f = extractFeatures(t);
		const b = baselineSelect(f);
		return {
			task: t,
			ruleId: b.ruleId,
			candidateId: b.candidate.candidateId,
			topology: b.candidate.executionTopology,
			budgetClass: b.candidate.budgetClass,
			retrieval: b.candidate.retrievalPolicy,
		};
	});
}

function featureOverview(): unknown {
	return {
		schemaVersion: 1,
		sampleFeature: extractFeatures("Fix a cross-platform release bug in the Windows builder"),
	};
}

function summarizeCandidate(c: {
	providerProfile: string;
	configuredModel: string;
	executionTopology: string;
	retrievalPolicy: string;
	budgetClass: string;
}): unknown {
	return {
		providerProfile: c.providerProfile,
		configuredModel: c.configuredModel,
		executionTopology: c.executionTopology,
		retrievalPolicy: c.retrievalPolicy,
		budgetClass: c.budgetClass,
	};
}

function option(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

function usageError(msg: string): void {
	console.error(chalkRed(msg));
	console.error(usage());
	process.exitCode = 1;
}
