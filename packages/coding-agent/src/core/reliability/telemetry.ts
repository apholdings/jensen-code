/**
 * Reliability telemetry — internal observability for key agent events.
 *
 * Records structured events and derives the Reliability Metrics that power the
 * Reliability Benchmark. This module is intentionally side-effect-light and
 * never logs sensitive user contents; payloads are caller-supplied summaries.
 */

import type { ReliabilityEvent, ReliabilityEventName, ReliabilityMetrics } from "./types.js";

export interface ReliabilityRecorder {
	record(name: ReliabilityEventName, data?: Record<string, unknown>): void;
	events(): readonly ReliabilityEvent[];
	metrics(): ReliabilityMetrics;
}

export interface ReliabilityRecorderOptions {
	missionId?: string;
	now?: () => number;
}

export class InMemoryReliabilityRecorder implements ReliabilityRecorder {
	private readonly _missionId?: string;
	private readonly _now: () => number;
	private readonly _events: ReliabilityEvent[] = [];
	private readonly _startedAt: number;

	constructor(options: ReliabilityRecorderOptions = {}) {
		this._missionId = options.missionId;
		this._now = options.now ?? Date.now;
		this._startedAt = this._now();
	}

	record(name: ReliabilityEventName, data?: Record<string, unknown>): void {
		this._events.push({
			name,
			missionId: this._missionId,
			timestamp: new Date(this._now()).toISOString(),
			data,
		});
	}

	events(): readonly ReliabilityEvent[] {
		return this._events;
	}

	metrics(): ReliabilityMetrics {
		const count = (name: ReliabilityEventName) => this._events.filter((e) => e.name === name).length;
		const completed = count("mission_completed") > 0;

		return {
			taskSuccess: completed,
			falseSuccessAttempts: count("finalization_rejected"),
			invalidActionCount: count("action_validation_failure") + count("action_decode_failure"),
			toolFailureCount: count("tool_failed"),
			verificationFailureCount: count("verification_executed"),
			finalizationRejectionCount: count("finalization_rejected"),
			actionsExecuted: count("tool_executed"),
			modelTurns: this._estimateTurns(),
			elapsedMs: this._now() - this._startedAt,
			missionResumed: count("mission_started") > 1,
		};
	}

	private _estimateTurns(): number {
		// Turn boundaries are action_proposed + tool_executed signals; without
		// an explicit turn event we conservatively count assistant proposals.
		return this._events.filter((e) => e.name === "action_proposed").length;
	}
}

/** Merge events from multiple recorders into a single ordered stream. */
export function concatEvents(recorders: readonly ReliabilityRecorder[]): ReliabilityEvent[] {
	return recorders.flatMap((r) => [...r.events()]);
}
