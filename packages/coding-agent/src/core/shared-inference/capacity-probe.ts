/**
 * Inference capacity probe (3.0.0 foundation).
 *
 * Optional backend telemetry adapter. Physical capacity belongs to the backend,
 * not to any agent/assignment/worker. For llama.cpp-compatible servers we can
 * observe `total_slots` from `/props` and per-slot `is_processing` from `/slots`
 * reliably. When a backend does not expose these, the caller reports
 * NOT_OBSERVED instead of guessing.
 *
 * Credentials are resolved per-probe and never persisted by the scheduler.
 */

import type { SharedInferenceResource } from "./types.js";

export interface InferenceCapacityObservation {
	capacity?: number;
	busySlots?: number;
	contextWindow?: number;
	observedAtMs: number;
}

export type InferenceCapacityProbeResult =
	| { status: "observed"; observation: InferenceCapacityObservation }
	| { status: "not_observed"; reason: string };

export interface InferenceCapacityProbe {
	probe(resource: SharedInferenceResource): Promise<InferenceCapacityProbeResult>;
}

export interface LlamaCppCapacityProbeOptions {
	/** Resolve the bearer key at probe time (never persisted). */
	apiKey?: string | (() => Promise<string | undefined>);
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	now?: () => number;
}

/**
 * llama.cpp server `/props` + `/slots` observation.
 *
 * `/props` exposes `total_slots` (the authoritative physical slot count) and
 * `default_generation_settings.n_ctx` (context window). `/slots` exposes each
 * slot's `is_processing` flag, from which busy slots are derived.
 */
export class LlamaCppCapacityProbe implements InferenceCapacityProbe {
	private readonly _apiKey?: string | (() => Promise<string | undefined>);
	private readonly _fetchImpl: typeof fetch;
	private readonly _timeoutMs: number;
	private readonly _now: () => number;

	constructor(options: LlamaCppCapacityProbeOptions = {}) {
		this._apiKey = options.apiKey;
		this._fetchImpl = options.fetchImpl ?? fetch;
		this._timeoutMs = options.timeoutMs ?? 3000;
		this._now = options.now ?? (() => Date.now());
	}

	async probe(resource: SharedInferenceResource): Promise<InferenceCapacityProbeResult> {
		if (!resource.baseUrl) return { status: "not_observed", reason: "no_base_url" };

		const apiKey = typeof this._apiKey === "function" ? await this._apiKey() : this._apiKey;
		const headers: Record<string, string> = {};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

		try {
			const [props, slots] = await Promise.all([
				this._get(`${resource.baseUrl}/props`, headers),
				this._get(`${resource.baseUrl}/slots`, headers),
			]);

			const capacity =
				typeof props?.total_slots === "number" && props.total_slots >= 1 ? props.total_slots : undefined;
			const contextWindow =
				typeof props?.default_generation_settings?.n_ctx === "number"
					? props.default_generation_settings.n_ctx
					: undefined;
			const busySlots = Array.isArray(slots) ? slots.filter((s) => s?.is_processing === true).length : undefined;

			if (capacity === undefined && busySlots === undefined && contextWindow === undefined) {
				return { status: "not_observed", reason: "backend_endpoints_without_capacity_signals" };
			}
			return {
				status: "observed",
				observation: { capacity, busySlots, contextWindow, observedAtMs: this._now() },
			};
		} catch (error) {
			return {
				status: "not_observed",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async _get(url: string, headers: Record<string, string>): Promise<any> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this._timeoutMs);
		try {
			const response = await this._fetchImpl(url, { headers, signal: controller.signal });
			if (!response.ok) return undefined;
			return (await response.json()) as unknown;
		} finally {
			clearTimeout(timer);
		}
	}
}
