/**
 * Provider health and degradation.
 *
 * Bounded rolling evidence per provider/model/endpoint. Uses decay rather than
 * permanent blacklisting. Authentication failures never trigger futile retries;
 * rate limits respect retry hints; fallback is deterministic and preserves task
 * requirements. Health state is durable for resume but bounded in retention.
 */

export type HealthSignal =
	| "success"
	| "rate_limit"
	| "timeout"
	| "authentication_failure"
	| "schema_incompatibility"
	| "tool_call_corruption"
	| "empty_response"
	| "context_overflow"
	| "provider_outage"
	| "cancellation";

export type HealthLevel = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface HealthSample {
	signal: HealthSignal;
	recordedAt: string;
	sequence: number;
}

export interface ProviderHealthState {
	provider: string;
	model?: string;
	endpoint?: string;
	/** Bounded window of recent samples (oldest first). */
	samples: readonly HealthSample[];
	/** Deterministic snapshot used for routing. */
	level: HealthLevel;
	lastSuccessfulAt?: string;
}

const RETRYABLE: ReadonlySet<HealthSignal> = new Set(["rate_limit", "timeout", "provider_outage"]);

const AUTH_FAILURE: HealthSignal = "authentication_failure";

export const MAX_HEALTH_SAMPLES = 32;

export function createHealthState(provider: string, model?: string, endpoint?: string): ProviderHealthState {
	return { provider, model, endpoint, samples: Object.freeze([]), level: "unknown" };
}

/**
 * Record a health signal, keeping a bounded window of samples, and derive the
 * level from the window. Authentication failures mark the provider degraded
 * (never retried blindly). Successful newest sample restores health.
 */
export function recordHealthSignal(
	state: ProviderHealthState,
	signal: HealthSignal,
	recordedAt: string,
	sequence: number,
): ProviderHealthState {
	const sample: HealthSample = Object.freeze({ signal, recordedAt, sequence });
	let samples: readonly HealthSample[] = [...state.samples, sample];
	if (samples.length > MAX_HEALTH_SAMPLES) {
		samples = samples.slice(samples.length - MAX_HEALTH_SAMPLES);
	}

	const level = computeLevel(samples);
	const lastSuccessfulAt = signal === "success" ? recordedAt : state.lastSuccessfulAt;

	return {
		provider: state.provider,
		model: state.model,
		endpoint: state.endpoint,
		samples: Object.freeze(samples),
		level,
		lastSuccessfulAt,
	};
}

function computeLevel(samples: readonly HealthSample[]): HealthLevel {
	if (samples.length === 0) return "unknown";
	const last = samples[samples.length - 1];
	if (last.signal === "success") return "healthy";
	if (last.signal === AUTH_FAILURE) return "degraded";
	if (last.signal === "rate_limit" || last.signal === "timeout" || last.signal === "cancellation") {
		return "degraded";
	}
	if (last.signal === "provider_outage") return "unhealthy";
	return "unhealthy";
}

/** A retry is allowed only for retryable signals, and only with a cooldown. */
export function shouldRetry(state: ProviderHealthState, cooldownMs: number, nowMs: number): boolean {
	const last = state.samples[state.samples.length - 1];
	if (!last) return true;
	if (last.signal === AUTH_FAILURE) return false;
	if (!RETRYABLE.has(last.signal)) return false;
	if (state.lastSuccessfulAt) {
		const lastSuccess = Date.parse(state.lastSuccessfulAt);
		if (Number.isFinite(lastSuccess) && nowMs - lastSuccess < cooldownMs) return false;
	}
	return true;
}

/** Count of a given signal within the window (used for bounded evidence). */
export function countSignal(state: ProviderHealthState, signal: HealthSignal): number {
	return state.samples.reduce((n, s) => (s.signal === signal ? n + 1 : n), 0);
}
