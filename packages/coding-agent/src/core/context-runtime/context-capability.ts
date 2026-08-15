/**
 * Context capability model (Long-Horizon Context Virtualization, 2.5.0).
 *
 * A provider-independent representation of what a model backend can actually
 * accept. It separates the *physical* context window from the *configured*
 * context window, reserves output + safety headroom, and derives the effective
 * safe input budget that a preflight governor must enforce.
 *
 * Invariant (HARD ACCEPTANCE INVARIANT):
 *
 *   inputTokens + reservedOutputTokens + safetyReserveTokens <= configuredContextWindow
 *
 * No Qwen/llama.cpp/provider values are hardcoded here. The source of truth is
 * `Model.contextWindow` / `Model.maxTokens` (which the model registry already
 * makes configurable per custom model and per model override); explicit
 * capability overrides win when the API cannot report a reliable value.
 */

export interface ContextCapabilitySource {
	/** Physical native window reported by the model/API (may be 0/unknown). */
	modelContextWindow: number;
	/** Maximum output tokens the model can produce (total, incl. reasoning). */
	modelMaxTokens: number;
	/** True when the model emits reasoning/thinking content out of the output budget. */
	reasoning?: boolean;
}

export interface ContextCapabilityOverrides {
	/**
	 * Authoritative configured window. Wins over `modelContextWindow` when the
	 * API cannot report it reliably (local llama.cpp, etc.).
	 */
	configuredContextWindow?: number;
	/** Explicit output reservation. Default derived below. */
	reservedOutputTokens?: number;
	/** Explicit safety reserve. Default derived below. */
	safetyReserveTokens?: number;
	/** Ratio of safeInputBudget at which proactive pressure handling begins. */
	softPressureRatio?: number;
	/** Absolute floor for the safe input budget (prevents pathological zero). */
	minimumSafeInputBudget?: number;
}

export interface ContextCapability {
	physicalContextWindow: number;
	configuredContextWindow: number;
	maximumOutputTokens: number;
	/** True when reasoning content is emitted out of the output budget. */
	reasoning: boolean;
	reservedOutputTokens: number;
	safetyReserveTokens: number;
	safeInputBudget: number;
	/** Input tokens at which the governor starts virtualizing/compacting. */
	softPressureThreshold: number;
}

const DEFAULT_SOFT_PRESSURE_RATIO = 0.8;
const DEFAULT_MINIMUM_SAFE_INPUT_BUDGET = 512;
const MIN_SAFETY_RESERVE = 256;
const MAX_SAFETY_RESERVE = 4096;
const MAX_OUTPUT_SHARE = 0.5;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function computeSafeInputBudget(
	configuredContextWindow: number,
	reservedOutputTokens: number,
	safetyReserveTokens: number,
	minimumSafeInputBudget = DEFAULT_MINIMUM_SAFE_INPUT_BUDGET,
): number {
	const raw = configuredContextWindow - reservedOutputTokens - safetyReserveTokens;
	return Math.max(minimumSafeInputBudget, Math.floor(raw));
}

/**
 * Resolve the effective context capability for a model backend.
 *
 * Output reservation never exceeds half the configured window, so a backend
 * with a huge `maxTokens` cannot starve the input budget. This is what makes a
 * 32K window usable as a daily driver: at most half is reserved for output.
 */
export function resolveContextCapability(
	source: ContextCapabilitySource,
	overrides: ContextCapabilityOverrides = {},
): ContextCapability {
	const physicalContextWindow = Math.max(1, Math.floor(source.modelContextWindow || 0));
	const configuredContextWindow = Math.max(1, Math.floor(overrides.configuredContextWindow ?? physicalContextWindow));
	const reasoning = source.reasoning ?? false;

	const maximumOutputTokens = Math.max(1, Math.floor(source.modelMaxTokens || 8192));
	const reservedOutputTokens = clamp(
		Math.floor(
			overrides.reservedOutputTokens ??
				Math.min(maximumOutputTokens, Math.floor(configuredContextWindow * MAX_OUTPUT_SHARE)),
		),
		1,
		Math.max(1, configuredContextWindow - 1),
	);

	const safetyReserveTokens = clamp(
		Math.floor(overrides.safetyReserveTokens ?? Math.floor(configuredContextWindow * 0.05)),
		MIN_SAFETY_RESERVE,
		MAX_SAFETY_RESERVE,
	);

	const safeInputBudget = computeSafeInputBudget(
		configuredContextWindow,
		reservedOutputTokens,
		safetyReserveTokens,
		overrides.minimumSafeInputBudget ?? DEFAULT_MINIMUM_SAFE_INPUT_BUDGET,
	);

	const softPressureRatio = clamp(overrides.softPressureRatio ?? DEFAULT_SOFT_PRESSURE_RATIO, 0.1, 0.95);
	const softPressureThreshold = Math.floor(safeInputBudget * softPressureRatio);

	return {
		physicalContextWindow,
		configuredContextWindow,
		maximumOutputTokens,
		reasoning,
		reservedOutputTokens,
		safetyReserveTokens,
		safeInputBudget,
		softPressureThreshold,
	};
}

/**
 * True when a request of `inputTokens` would violate the hard invariant.
 */
export function exceedsSafeInputBudget(capability: ContextCapability, inputTokens: number): boolean {
	return (
		inputTokens + capability.reservedOutputTokens + capability.safetyReserveTokens >
		capability.configuredContextWindow
	);
}

/** Pressure ratio 0..1+ of the current input against the safe input budget. */
export function contextPressureRatio(capability: ContextCapability, inputTokens: number): number {
	if (capability.safeInputBudget <= 0) return Number.POSITIVE_INFINITY;
	return inputTokens / capability.safeInputBudget;
}
