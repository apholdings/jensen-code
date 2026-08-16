/**
 * Capability Routing — deterministic router (2.15.0).
 *
 * Turns structured Mission requirements + a registry snapshot + worker liveness
 * + remote target health into explainable route candidates. The pure evaluator
 * (`evaluateRouteCandidates`) has no I/O and no process/transport side effects,
 * so requirements+snapshots → candidates is independently testable (§72). The
 * `CapabilityRouter` service gathers the snapshots and deduplicates remote
 * probes per target within a single evaluation (§56).
 *
 * This router never chooses the final executor. The Scheduler consumes the
 * candidates and applies its own deterministic policy. It also never routes
 * inference and never models shared-Qwen capacity.
 */

import type {
	CompatibilityRequirementItem,
	ExecutionRouteMode,
	MissionRequirements,
} from "../assignment/assignment-types.js";
import { evaluateCompatibility } from "../assignment/compatibility.js";
import type { ExecutorCapabilities } from "../executor-registry/executor-registry-types.js";
import type { ExecutorControlService } from "../executor-registry/index.js";
import type { RemoteTargetRegistry } from "../remote-execution/remote-target-registry.js";
import type { RemoteExecutionTarget, RemoteTargetHealth } from "../remote-execution/remote-target-types.js";
import type {
	CapabilityRouteEvaluator,
	ExecutionRoute,
	RoutabilityStatus,
	RouteCandidate,
	RoutingEvaluation,
} from "./route-types.js";

// =============================================================================
// Pure deterministic evaluator
// =============================================================================

export interface EvaluateRoutesInput {
	requirements: MissionRequirements;
	routes: readonly ExecutionRoute[];
	now: number;
}

function formatObserved(observed: string | readonly string[] | undefined): string {
	if (observed === undefined) return "unknown";
	if (typeof observed === "string") return observed;
	return observed.length > 0 ? observed.join(",") : "(none)";
}

function compatibilityReasons(items: readonly CompatibilityRequirementItem[]): string[] {
	return items.map((item) => {
		if (item.kind === "platform.os") {
			return item.observed === undefined
				? `platform.os "${item.requirement}" required but route platform is unknown`
				: `platform.os "${item.requirement}" required but route platform is "${item.observed}"`;
		}
		if (item.kind === "platform.arch") {
			return item.observed === undefined
				? `platform.arch "${item.requirement}" required but route arch is unknown`
				: `platform.arch "${item.requirement}" required but route arch is "${item.observed}"`;
		}
		if (item.kind === "provider" || item.kind === "model") {
			return `${item.kind} requirement "${item.requirement}" unsatisfied (observed ${formatObserved(item.observed)})`;
		}
		return `${item.kind} capability "${item.requirement}" required but not advertised`;
	});
}

function preferenceFor(route: ExecutionRoute, requirements: MissionRequirements): { score: number; reasons: string[] } {
	const prefs = requirements.preferences;
	let score = 0;
	const reasons: string[] = [];
	if (prefs?.executionMode !== undefined) {
		if (prefs.executionMode === route.executionMode) {
			score += 1;
			reasons.push(`execution mode "${prefs.executionMode}" preferred`);
		} else {
			reasons.push(`execution mode "${prefs.executionMode}" preferred (route is "${route.executionMode}")`);
		}
	}
	if (prefs?.executorId !== undefined) {
		if (prefs.executorId === route.executorId) {
			score += 1;
			reasons.push(`executor "${prefs.executorId}" preferred`);
		}
	}
	if (prefs?.remoteTargetId !== undefined) {
		if (route.executionMode === "remote" && route.remoteTargetId === prefs.remoteTargetId) {
			score += 1;
			reasons.push(`remote target "${prefs.remoteTargetId}" preferred`);
		} else if (route.executionMode === "remote") {
			reasons.push(`remote target "${prefs.remoteTargetId}" preferred (route target is "${route.remoteTargetId}")`);
		}
	}
	return { score, reasons };
}

/**
 * Evaluate one fully-resolved route against hard requirements and availability.
 * Platform/arch for remote routes are authoritative from the target; the
 * executor's declared capabilities are merged only for execution capability
 * matching (never platform inference for a remote physical machine).
 */
export function evaluateRouteCandidate(route: ExecutionRoute, requirements: MissionRequirements): RouteCandidate {
	const platformOverride =
		route.platform !== undefined || route.arch !== undefined
			? { os: route.platform, arch: route.arch }
			: route.capabilities.platform;
	const effectiveCapabilities: ExecutorCapabilities = { ...route.capabilities, platform: platformOverride };
	const compatibility = evaluateCompatibility(requirements, effectiveCapabilities);

	const executionModeMatch =
		requirements.executionMode === undefined || route.executionMode === requirements.executionMode;
	const platformMatch = !compatibility.unsatisfied.some((item) => item.kind === "platform.os");
	const archMatch = !compatibility.unsatisfied.some((item) => item.kind === "platform.arch");
	const capabilityMatch = compatibility.compatible && executionModeMatch;

	const workerAvailable = !route.retired && route.status === "ONLINE";
	const targetAvailable = route.executionMode === "local" ? true : route.targetHealth?.status === "reachable";
	const eligible = capabilityMatch && workerAvailable && targetAvailable;

	const rejectionReasons = compatibilityReasons(compatibility.unsatisfied);
	if (!executionModeMatch) {
		rejectionReasons.unshift(
			`execution mode "${requirements.executionMode}" required but route is "${route.executionMode}"`,
		);
	}
	if (route.retired) rejectionReasons.push("executor is retired");
	else if (!workerAvailable) rejectionReasons.push(`worker is not ONLINE (${route.status})`);
	if (!targetAvailable) {
		const health = route.targetHealth;
		rejectionReasons.push(
			`remote target "${route.remoteTargetId ?? ""}" is ${health?.status ?? "unknown"}${
				health?.summary ? `: ${health.summary}` : ""
			}`,
		);
	}

	const status = routabilityStatus({
		executionModeMatch,
		platformMatch,
		archMatch,
		capabilityMatch: compatibility.compatible,
		workerAvailable,
		targetAvailable,
		requirements,
		route,
	});

	const preference = preferenceFor(route, requirements);

	return {
		executorId: route.executorId,
		executionMode: route.executionMode,
		remoteTargetId: route.remoteTargetId,
		transport: route.transport,
		platform: route.platform,
		arch: route.arch,
		eligible,
		status,
		capabilityMatch,
		platformMatch,
		archMatch,
		executionModeMatch,
		workerAvailable,
		targetAvailable,
		workerStatus: route.status,
		retired: route.retired,
		targetHealth: route.targetHealth,
		matchedRequirements: compatibility.satisfied,
		rejectedRequirements: compatibility.unsatisfied,
		rejectionReasons,
		preferenceScore: preference.score,
		preferenceReasons: preference.reasons,
	};
}

function routabilityStatus(input: {
	executionModeMatch: boolean;
	platformMatch: boolean;
	archMatch: boolean;
	capabilityMatch: boolean;
	workerAvailable: boolean;
	targetAvailable: boolean;
	requirements: MissionRequirements;
	route: ExecutionRoute;
}): RoutabilityStatus {
	if (!input.executionModeMatch) return "INELIGIBLE_EXECUTION_MODE";
	if (input.requirements.platform?.os !== undefined && input.route.platform === undefined)
		return "UNKNOWN_REQUIREMENT";
	if (!input.platformMatch) return "INELIGIBLE_PLATFORM";
	if (input.requirements.platform?.arch !== undefined && input.route.arch === undefined) return "UNKNOWN_REQUIREMENT";
	if (!input.archMatch) return "INELIGIBLE_ARCH";
	if (!input.capabilityMatch) return "INELIGIBLE_CAPABILITY";
	if (!input.workerAvailable) return "UNAVAILABLE_WORKER";
	if (!input.targetAvailable) return "UNAVAILABLE_TARGET";
	return "ELIGIBLE";
}

/** Deterministic candidate evaluation: ascending executorId ordering. */
export function evaluateRouteCandidates(input: EvaluateRoutesInput): RouteCandidate[] {
	return input.routes
		.map((route) => evaluateRouteCandidate(route, input.requirements))
		.sort((a, b) => (a.executorId < b.executorId ? -1 : a.executorId > b.executorId ? 1 : 0));
}

// =============================================================================
// Service
// =============================================================================

export interface CapabilityRouterOptions {
	executors: ExecutorControlService;
	/** Optional target registry for resolving remote route platform/arch + probes. */
	targets?: RemoteTargetRegistry;
	/** Injected health provider (deterministic tests); defaults to target probe. */
	healthProvider?: (targetId: string) => Promise<RemoteTargetHealth>;
	now?: () => number;
}

export class CapabilityRouter implements CapabilityRouteEvaluator {
	private readonly _executors: ExecutorControlService;
	private readonly _targets?: RemoteTargetRegistry;
	private readonly _healthProvider?: (targetId: string) => Promise<RemoteTargetHealth>;
	private readonly _now: () => number;

	constructor(options: CapabilityRouterOptions) {
		this._executors = options.executors;
		this._targets = options.targets;
		this._healthProvider = options.healthProvider;
		this._now = options.now ?? (() => Date.now());
	}

	/**
	 * Gather registry/worker/target snapshots, resolve remote routes (platform,
	 * arch, transport from the target) and deduplicate target probes, then run
	 * the pure evaluator.
	 */
	async evaluate(input: { requirements: MissionRequirements; missionId?: string }): Promise<RoutingEvaluation> {
		const now = this._now();
		const executorList = await this._executors.listExecutors();

		const remoteTargetIds = new Set<string>();
		const routes: ExecutionRoute[] = executorList.entries.map((summary) => {
			const executionMode: ExecutionRouteMode = summary.remoteTargetId ? "remote" : "local";
			if (summary.remoteTargetId) remoteTargetIds.add(summary.remoteTargetId);
			return {
				executorId: summary.executorId,
				executionMode,
				remoteTargetId: summary.remoteTargetId,
				platform: summary.platform ?? summary.capabilities.platform?.os,
				arch: summary.arch ?? summary.capabilities.platform?.arch,
				capabilities: summary.capabilities,
				status: summary.status,
				retired: summary.retired,
			};
		});

		const orderedTargetIds = [...remoteTargetIds].sort();
		const targetById = new Map<string, RemoteExecutionTarget>();
		const targetCorrupt: RoutingEvaluation["targetCorrupt"] = [];
		for (const targetId of orderedTargetIds) {
			const resolved = await this._resolveTarget(targetId);
			if (resolved.target) targetById.set(targetId, resolved.target);
			else targetCorrupt.push({ targetId, diagnostic: resolved.diagnostic });
		}

		const targetHealth = new Map<string, RemoteTargetHealth>();
		for (const targetId of orderedTargetIds) {
			targetHealth.set(targetId, await this._probe(targetId));
		}

		const resolvedRoutes: ExecutionRoute[] = routes.map((route) => {
			if (route.executionMode !== "remote" || !route.remoteTargetId) return route;
			const target = targetById.get(route.remoteTargetId);
			return {
				...route,
				platform: target?.platform ?? route.platform,
				arch: target?.arch ?? route.arch,
				transport: target?.transport,
				targetHealth: targetHealth.get(route.remoteTargetId),
			};
		});

		const candidates = evaluateRouteCandidates({ requirements: input.requirements, routes: resolvedRoutes, now });
		return {
			missionId: input.missionId,
			requirements: input.requirements,
			candidates,
			eligibleCount: candidates.filter((candidate) => candidate.eligible).length,
			eligibleExecutorIds: candidates.filter((candidate) => candidate.eligible).map((c) => c.executorId),
			corrupt: executorList.corrupt,
			targetCorrupt,
			evaluatedAtMs: now,
		};
	}

	private async _resolveTarget(targetId: string): Promise<{ target?: RemoteExecutionTarget; diagnostic: string }> {
		if (!this._targets) return { diagnostic: "target registry not configured" };
		try {
			return { target: await this._targets.get(targetId), diagnostic: "" };
		} catch (error) {
			return { diagnostic: error instanceof Error ? error.message : String(error) };
		}
	}

	private async _probe(targetId: string): Promise<RemoteTargetHealth> {
		if (this._healthProvider) return this._healthProvider(targetId);
		if (this._targets) {
			try {
				return await this._targets.probe(targetId);
			} catch (error) {
				return {
					targetId,
					status: "unknown",
					summary: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
					observedAtMs: this._now(),
				};
			}
		}
		return {
			targetId,
			status: "unknown",
			summary: "no target registry/transport configured for probes",
			observedAtMs: this._now(),
		};
	}
}
