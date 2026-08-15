/**
 * Assignment Compatibility Engine (2.11.0).
 *
 * Deterministic, explainable capability matching between a structured
 * MissionRequirements and an executor's effective capabilities. No scoring, no
 * ranking, no fuzzy model matching, and no scheduler placement.
 *
 * `compatible` (capability match) is intentionally distinct from `assignable`
 * (capability match + executor state policy). The two are collapsed only by the
 * caller when it actually creates an assignment.
 */

import type { ExecutorCapabilities, ExecutorLivenessStatus } from "../executor-registry/executor-registry-types.js";
import type {
	AssignabilityResult,
	CompatibilityRequirementItem,
	CompatibilityResult,
	ExecutorAssignabilityStatus,
	MissionRequirements,
} from "./assignment-types.js";

// =============================================================================
// Effective capability merge
// =============================================================================

function union(...lists: (string[] | undefined)[]): string[] {
	const seen = new Set<string>();
	for (const list of lists) {
		for (const entry of list ?? []) seen.add(entry);
	}
	return [...seen].sort();
}

/**
 * Effective capabilities for assignment evaluation: the union of the stable
 * configured definition and the current runtime advertisement. Platform is
 * taken from the runtime advertisement when present (it is an observation of
 * the actual process), falling back to the configured platform.
 */
export function mergeExecutorCapabilities(
	configured: ExecutorCapabilities,
	advertised?: ExecutorCapabilities,
): ExecutorCapabilities {
	return {
		platform: advertised?.platform ?? configured.platform,
		execution: union(configured.execution, advertised?.execution),
		providers: union(configured.providers, advertised?.providers),
		models: union(configured.models, advertised?.models),
		tools: union(configured.tools, advertised?.tools),
		specialized: union(configured.specialized, advertised?.specialized),
		extra: union(configured.extra, advertised?.extra),
	};
}

// =============================================================================
// Deterministic compatibility evaluation
// =============================================================================

function has(list: string[] | undefined, value: string): boolean {
	return (list ?? []).includes(value);
}

function platformValue(capabilities: ExecutorCapabilities, key: "os" | "arch"): string | undefined {
	return capabilities.platform?.[key];
}

/**
 * Evaluate requirements against effective capabilities. Every requirement that
 * cannot be satisfied is recorded in `unsatisfied` with the observed value, so
 * operators and the future scheduler can see *why* an executor did not match.
 */
export function evaluateCompatibility(
	requirements: MissionRequirements | undefined,
	capabilities: ExecutorCapabilities,
): CompatibilityResult {
	const satisfied: CompatibilityRequirementItem[] = [];
	const unsatisfied: CompatibilityRequirementItem[] = [];
	const warnings: string[] = [];

	const req = requirements ?? {};

	if (req.platform?.os !== undefined) {
		const observed = platformValue(capabilities, "os");
		const item: CompatibilityRequirementItem = { kind: "platform.os", requirement: req.platform.os, observed };
		if (observed === req.platform.os) satisfied.push(item);
		else unsatisfied.push(item);
	}

	if (req.platform?.arch !== undefined) {
		const observed = platformValue(capabilities, "arch");
		const item: CompatibilityRequirementItem = { kind: "platform.arch", requirement: req.platform.arch, observed };
		if (observed === req.platform.arch) satisfied.push(item);
		else unsatisfied.push(item);
	}

	for (const value of req.execution ?? []) {
		const item: CompatibilityRequirementItem = {
			kind: "execution",
			requirement: value,
			observed: capabilities.execution ?? [],
		};
		if (has(capabilities.execution, value)) satisfied.push(item);
		else unsatisfied.push(item);
	}

	if (req.providers && req.providers.length > 0) {
		const observed = capabilities.providers ?? [];
		const matched = req.providers.filter((value) => has(capabilities.providers, value));
		const item: CompatibilityRequirementItem = {
			kind: "provider",
			requirement: `anyOf:${req.providers.join(",")}`,
			observed,
		};
		if (matched.length > 0) {
			satisfied.push(item);
			if (matched.length > 1) warnings.push(`multiple providers satisfy ${matched.join(", ")}`);
		} else {
			unsatisfied.push(item);
		}
	}

	if (req.models && req.models.length > 0) {
		const observed = capabilities.models ?? [];
		const matched = req.models.filter((value) => has(capabilities.models, value));
		const item: CompatibilityRequirementItem = {
			kind: "model",
			requirement: `anyOf:${req.models.join(",")}`,
			observed,
		};
		if (matched.length > 0) {
			satisfied.push(item);
			if (matched.length > 1) warnings.push(`multiple models satisfy ${matched.join(", ")}`);
		} else {
			unsatisfied.push(item);
		}
	}

	for (const value of req.tools ?? []) {
		const item: CompatibilityRequirementItem = {
			kind: "tool",
			requirement: value,
			observed: capabilities.tools ?? [],
		};
		if (has(capabilities.tools, value)) satisfied.push(item);
		else unsatisfied.push(item);
	}

	for (const value of req.specialized ?? []) {
		const item: CompatibilityRequirementItem = {
			kind: "specialized",
			requirement: value,
			observed: capabilities.specialized ?? [],
		};
		if (has(capabilities.specialized, value)) satisfied.push(item);
		else unsatisfied.push(item);
	}

	for (const value of req.extra ?? []) {
		const item: CompatibilityRequirementItem = {
			kind: "extra",
			requirement: value,
			observed: capabilities.extra ?? [],
		};
		if (has(capabilities.extra, value)) satisfied.push(item);
		else unsatisfied.push(item);
	}

	return {
		compatible: unsatisfied.length === 0,
		satisfied,
		unsatisfied,
		warnings,
	};
}

// =============================================================================
// Assignability (compatibility + executor state policy)
// =============================================================================

export interface AssignabilityInput {
	requirements?: MissionRequirements;
	capabilities: ExecutorCapabilities;
	status: ExecutorAssignabilityStatus;
	retired: boolean;
}

/**
 * Assignability is compatibility plus state policy: a retired/offline/stale
 * executor may be capability-compatible but is not presently assignable. The
 * distinction is surfaced so a future failover/scheduler policy can reason
 * about it without parsing prose.
 */
export function evaluateAssignability(input: AssignabilityInput): AssignabilityResult {
	const compatibility = evaluateCompatibility(input.requirements, input.capabilities);

	if (!compatibility.compatible) {
		return {
			compatible: false,
			assignable: false,
			status: input.status,
			reason: "executor capabilities do not satisfy mission requirements",
			compatibility,
		};
	}

	if (input.retired) {
		return {
			compatible: true,
			assignable: false,
			status: "RETIRED",
			reason: "executor is retired",
			compatibility,
		};
	}

	if (input.status !== "ONLINE") {
		return {
			compatible: true,
			assignable: false,
			status: input.status,
			reason: `executor is not ONLINE (${input.status})`,
			compatibility,
		};
	}

	return {
		compatible: true,
		assignable: true,
		status: "ONLINE",
		compatibility,
	};
}

/** Normalize an executor registry liveness status to the assignment domain. */
export function toAssignabilityStatus(status: ExecutorLivenessStatus): ExecutorAssignabilityStatus {
	switch (status) {
		case "REGISTERED":
			return "REGISTERED";
		case "ONLINE":
			return "ONLINE";
		case "STALE":
			return "STALE";
		case "OFFLINE":
			return "OFFLINE";
		case "RETIRED":
			return "RETIRED";
		default:
			return "UNKNOWN";
	}
}
