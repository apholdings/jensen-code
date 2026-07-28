/**
 * Shared test-only helpers for constructing genuine trusted contexts.
 *
 * These helpers remain outside public production exports.
 * Each call produces an immutable isolated registry — no global mutable state.
 */

import type {
	EvidenceLedgerCapability,
	LedgerCapability,
	TrustedEvidenceSourceGrant,
	TrustedLedgerMutationContext,
	TrustedPrincipalKind,
	TrustedValidationContext,
} from "../../src/core/long-horizon/trusted-context.js";
import {
	_internalCreateTrustedContext,
	_internalCreateTrustedValidationContext,
} from "../../src/core/long-horizon/trusted-context.js";

// =============================================================================
// Shared source grant builder
// =============================================================================

/**
 * Create a standard evidence source grant for a test operator with
 * evidence:test-result capability.
 */
export function makeTestOperatorSourceGrant(
	sourceId: string,
	allowedEvidenceTypes: string[] = ["test-result"],
): TrustedEvidenceSourceGrant {
	return {
		sourceId,
		principalId: "test-operator",
		principalKind: "operator" as TrustedPrincipalKind,
		capability: "evidence:test-result" as EvidenceLedgerCapability,
		allowedEvidenceTypes,
	};
}

/**
 * Create a source grant for a trusted collector.
 */
export function makeTrustedCollectorSourceGrant(
	sourceId: string,
	allowedEvidenceTypes: string[] = ["test-result", "command-result"],
): TrustedEvidenceSourceGrant {
	return {
		sourceId,
		principalId: "test-collector",
		principalKind: "trusted-collector" as TrustedPrincipalKind,
		capability: "evidence:test-result" as EvidenceLedgerCapability,
		allowedEvidenceTypes,
	};
}

// =============================================================================
// Standard test principal tuples
// =============================================================================

export interface TestPrincipalTuple {
	principalId: string;
	principalKind: TrustedPrincipalKind;
	capabilities: LedgerCapability[];
}

/**
 * Standard test operator — has satisfy and test-result capabilities.
 */
export function testOperatorTuple(): TestPrincipalTuple {
	return {
		principalId: "test-operator",
		principalKind: "operator" as TrustedPrincipalKind,
		capabilities: ["transition:satisfy", "evidence:test-result", "evidence:operator-confirmation"],
	};
}

/**
 * Standard test trusted collector.
 */
export function testCollectorTuple(): TestPrincipalTuple {
	return {
		principalId: "test-collector",
		principalKind: "trusted-collector" as TrustedPrincipalKind,
		capabilities: ["transition:satisfy", "evidence:trusted-collector", "evidence:test-result"],
	};
}

/**
 * Standard test automated review (for NOT_APPLICABLE).
 */
export function testAutomatedReviewTuple(): TestPrincipalTuple {
	return {
		principalId: "test-reviewer",
		principalKind: "automated-review" as TrustedPrincipalKind,
		capabilities: ["transition:not-applicable"],
	};
}

/**
 * Untrusted agent principal.
 */
export function untrustedAgentTuple(): TestPrincipalTuple {
	return {
		principalId: "untrusted",
		principalKind: "agent" as TrustedPrincipalKind,
		capabilities: [],
	};
}

// =============================================================================
// Composite context factories
// =============================================================================

export interface TrustedTestContexts {
	mutation: TrustedLedgerMutationContext;
	validation: TrustedValidationContext;
}

/**
 * Create mutation + validation contexts for standard test-runner operations.
 *
 * Includes:
 *   - test-operator (operator) with satisfy + test-result
 *   - test-collector (trusted-collector) with satisfy + trusted-collector + test-result
 *   - test-reviewer (automated-review) with not-applicable
 *   - untrusted (agent) with no capabilities
 *
 * Source grants for: test, ci, npm test, shell (all test-operator/operator),
 * plus ci/cd pipeline (test-collector/trusted-collector).
 */
export function createTrustedTestRunnerContexts(): TrustedTestContexts {
	const mutation = _internalCreateTrustedContext({
		principalId: "test-operator",
		principalKind: "operator" as TrustedPrincipalKind,
		capabilities: ["transition:satisfy", "evidence:test-result", "evidence:operator-confirmation"],
	});

	const validation = _internalCreateTrustedValidationContext(
		[testOperatorTuple(), testCollectorTuple(), testAutomatedReviewTuple(), untrustedAgentTuple()],
		[
			makeTestOperatorSourceGrant("test"),
			makeTestOperatorSourceGrant("ci"),
			makeTestOperatorSourceGrant("npm test"),
			makeTestOperatorSourceGrant("shell", ["test-result", "command-result"]),
			makeTestOperatorSourceGrant("test2"),
			makeTestOperatorSourceGrant("claim"),
			makeTestOperatorSourceGrant("src-1"),
			makeTestOperatorSourceGrant("m20-src"),
			makeTestOperatorSourceGrant("some-src"),
			makeTrustedCollectorSourceGrant("ci/cd pipeline"),
		],
	);

	return { mutation, validation };
}

/**
 * Create operator-only contexts for tests that only need a single operator principal.
 */
export function createTrustedOperatorContexts(): TrustedTestContexts {
	const mutation = _internalCreateTrustedContext({
		principalId: "test-operator",
		principalKind: "operator" as TrustedPrincipalKind,
		capabilities: ["transition:satisfy", "evidence:test-result", "evidence:operator-confirmation"],
	});

	const validation = _internalCreateTrustedValidationContext(
		[testOperatorTuple(), untrustedAgentTuple()],
		[makeTestOperatorSourceGrant("test"), makeTestOperatorSourceGrant("npm test")],
	);

	return { mutation, validation };
}

/**
 * Create applicability contexts for runtime NOT_APPLICABLE operations.
 */
export function createTrustedApplicabilityContexts(): TrustedTestContexts {
	const mutation = _internalCreateTrustedContext({
		principalId: "test-reviewer",
		principalKind: "automated-review" as TrustedPrincipalKind,
		capabilities: ["transition:not-applicable"],
	});

	const validation = _internalCreateTrustedValidationContext([testAutomatedReviewTuple(), untrustedAgentTuple()], []);

	return { mutation, validation };
}

/**
 * Create completion-grade contexts with a full principal and source-grant set.
 */
export function createTrustedCompletionContexts(): TrustedTestContexts {
	const mutation = _internalCreateTrustedContext({
		principalId: "test-operator",
		principalKind: "operator" as TrustedPrincipalKind,
		capabilities: ["transition:satisfy", "evidence:test-result", "evidence:operator-confirmation"],
	});

	const validation = _internalCreateTrustedValidationContext(
		[
			testOperatorTuple(),
			testCollectorTuple(),
			testAutomatedReviewTuple(),
			untrustedAgentTuple(),
			{ principalId: "test", principalKind: "agent" as TrustedPrincipalKind, capabilities: [] },
			{ principalId: "ci", principalKind: "agent" as TrustedPrincipalKind, capabilities: [] },
			{ principalId: "npm test", principalKind: "agent" as TrustedPrincipalKind, capabilities: [] },
			{ principalId: "shell", principalKind: "agent" as TrustedPrincipalKind, capabilities: [] },
		],
		[
			makeTestOperatorSourceGrant("test"),
			makeTestOperatorSourceGrant("ci"),
			makeTestOperatorSourceGrant("npm test"),
			makeTestOperatorSourceGrant("shell", ["test-result", "command-result"]),
			makeTrustedCollectorSourceGrant("ci/cd pipeline"),
		],
	);

	return { mutation, validation };
}
