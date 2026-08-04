import type { BenchmarkEvaluationResult } from "../benchmark/types.js";
import type { EvaluationEvent, EvaluationMetricResult, EvaluationMetricSpec, EvaluationRun } from "./types.js";

function count(events: EvaluationEvent[], type: string): number {
	return events.filter((event) => event.type === type).length;
}

function duration(run: EvaluationRun): number | undefined {
	if (!run.completedAt) return undefined;
	return Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt));
}

export function calculateMetrics(input: {
	run: EvaluationRun;
	events: EvaluationEvent[];
	specs: EvaluationMetricSpec[];
	benchmarkReport?: BenchmarkEvaluationResult;
}): EvaluationMetricResult[] {
	const { run, events, specs, benchmarkReport } = input;
	const values: Record<string, number | undefined> = {
		scenario_pass: benchmarkReport?.completionGate.passed ? 1 : benchmarkReport ? 0 : undefined,
		assertion_pass_rate: undefined,
		tool_failures: count(events, "tool.failure"),
		retries: count(events, "tool.retry"),
		stall_events: count(events, "runtime.stall"),
		strategy_pivots: count(events, "runtime.strategy_pivot"),
		rollback_count: count(events, "transaction.rollback"),
		process_leaks: count(events, "process.leak"),
		provider_fallbacks: count(events, "provider.fallback"),
		wall_time_ms: duration(run),
		model_latency_ms: events
			.filter((event) => event.type === "model.response")
			.reduce((total, event) => total + Number(event.details?.durationMs ?? 0), 0),
		tool_latency_ms: events
			.filter((event) => event.type === "tool.result")
			.reduce((total, event) => total + Number(event.details?.durationMs ?? 0), 0),
		input_tokens: sumEventNumber(events, "usage", "inputTokens"),
		output_tokens: sumEventNumber(events, "usage", "outputTokens"),
		tool_calls: count(events, "tool.call"),
		model_calls: count(events, "model.request"),
		cost_usd: sumEventNumber(events, "usage", "costUsd"),
		policy_denials: count(events, "policy.denied"),
		unsafe_attempts: count(events, "safety.unsafe_attempt"),
		workspace_escapes: count(events, "safety.workspace_escape"),
		secret_exposure: count(events, "safety.secret_exposure"),
		unapproved_mutations: count(events, "safety.unapproved_mutation"),
		retrieval_queries: count(events, "retrieval.query"),
		retrieval_tokens: sumEventNumber(events, "retrieval.query", "tokens"),
		subagent_count: count(events, "subagent.started"),
		subagent_cost_usd: sumEventNumber(events, "subagent.usage", "costUsd"),
		subagent_latency_ms: sumEventNumber(events, "subagent.completed", "durationMs"),
	};
	return specs.map((spec) => ({
		metricId: spec.metricId,
		value: values[spec.metricId],
		unit: spec.unit,
		source: sourceFor(spec.metricId),
		version: 1,
	}));
}

function sumEventNumber(events: EvaluationEvent[], type: string, key: string): number | undefined {
	const matching = events.filter((event) => event.type === type && typeof event.details?.[key] === "number");
	if (matching.length === 0) return undefined;
	return matching.reduce((total, event) => total + Number(event.details?.[key]), 0);
}

function sourceFor(metricId: string): "durable_event" | "provider_reported" | "calculated" | "semantic" {
	if (["input_tokens", "output_tokens", "cost_usd"].includes(metricId)) return "provider_reported";
	if (["scenario_pass", "assertion_pass_rate"].includes(metricId)) return "calculated";
	return "durable_event";
}
