/**
 * Deterministic routing evaluation self-probe.
 *
 * Runs a fixed set of offline decision fixtures with fixture evidence and no
 * provider, returning a bounded verdict used by CLI (and the packed/binary
 * artifact acceptance). This is the deterministic gate for routing decisions.
 */

import { fixtureEvidence } from "./cli-helpers.js";
import { decide } from "./engine.js";
import { resolveFallback } from "./fallback.js";
import { extractFeatures } from "./features.js";

export interface RoutingProbeCheck {
	scenario: string;
	passed: boolean;
	expected?: string;
	actual?: string;
	message: string;
}

export interface RoutingProbeResult {
	passed: boolean;
	checks: RoutingProbeCheck[];
}

const evidence = fixtureEvidence();

/** Run the canonical offline routing fixtures deterministically. */
export function runRoutingSelfProbe(): RoutingProbeResult {
	const checks: RoutingProbeCheck[] = [];

	const simple = decide({ task: "Where is the Foo symbol defined?", evidence });
	checks.push(check("simple read-only task produces a decision", Boolean(simple.decision.decisionId)));

	const impl = decide({ task: "Fix the timeout bug in the scheduler across three files", evidence });
	checks.push(check("bounded implementation produces a decision", Boolean(impl.decision.decisionId)));

	const release = decide({ task: "Release version 1.9.0 across seven packages and tag it", evidence });
	checks.push(
		check(
			"release task routes to a release budget class",
			release.selectedCandidate?.budgetClass === "release",
			"release",
			release.selectedCandidate?.budgetClass,
		),
	);

	// Provider unavailable -> deterministic baseline fallback (not blocked).
	const fb = resolveFallback("provider_unavailable", extractFeatures("Fix the bug"), {
		explicitFallback: undefined,
		policyFallback: undefined,
		localOnly: false,
		safetyClass: "high",
	});
	checks.push(
		check(
			"provider unavailable falls back safely",
			fb.fallbackLayer === "deterministic_baseline" || fb.fallbackLayer === "operator",
			"deterministic_baseline",
			fb.fallbackLayer,
		),
	);

	// Insufficient evidence -> confidence insufficient.
	const noEv = decide({ task: "Investigate the unknown symbol", evidence: {} });
	checks.push(
		check(
			"insufficient evidence is explicit when no evidence",
			noEv.decision.confidence === "insufficient_evidence",
			"insufficient_evidence",
			noEv.decision.confidence,
		),
	);

	// Operator override is recorded.
	const overridden = decide({
		task: "Fix the parser bug",
		evidence,
		operatorOverride: {
			authorizedBy: "probe",
			candidateId: "c-fixture-fixture-deterministic-single_agent-hybrid-standard",
			reason: "probe override",
		},
	});
	checks.push(
		check(
			"operator override is recorded and authoritative",
			Boolean(overridden.decision.operatorOverride) &&
				overridden.decision.selectedCandidateId === "c-fixture-fixture-deterministic-single_agent-hybrid-standard",
		),
	);

	return { passed: checks.every((c) => c.passed), checks };
}

function check(message: string, passed: boolean, expected?: string, actual?: string): RoutingProbeCheck {
	return { scenario: message, passed, expected, actual, message };
}
