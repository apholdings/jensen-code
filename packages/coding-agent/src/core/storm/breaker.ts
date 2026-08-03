import type { AgentToolResult } from "@apholdings/jensen-agent-core";
import { stableHash } from "../tool-call/canonicalize.js";
import { fingerprintCall } from "./fingerprint.js";

/**
 * Provider-independent Tool Storm Breaker.
 *
 * Detects repeated / alternating / no-progress tool calls and escalates through
 * bounded, user-visible stages. Progress is determined ONLY from structured
 * events (authoritative state change), never from model prose.
 */

export const TOOL_CALL_DUPLICATE_NO_PROGRESS = "TOOL_CALL_DUPLICATE_NO_PROGRESS";
export const TOOL_CALL_STORM_BLOCKED = "TOOL_CALL_STORM_BLOCKED";
export const TOOL_STRATEGY_PIVOT_REQUIRED = "TOOL_STRATEGY_PIVOT_REQUIRED";

export type StormStage =
	| "fresh"
	| "duplicate_annotate"
	| "no_progress_reflect"
	| "storm_blocked"
	| "strategy_pivot_required";

export interface StormThresholds {
	/** Duplicate count at which we start annotating. */
	annotate: number;
	/** Duplicate count at which we require structured reflection. */
	reflect: number;
	/** Duplicate count at which we block the repeated call. */
	block: number;
	/** Duplicate count at which we fail the current strategy. */
	terminal: number;
	/** Max storm history entries retained. */
	maxHistory: number;
}

export const DEFAULT_STORM_THRESHOLDS: StormThresholds = {
	annotate: 2,
	reflect: 3,
	block: 4,
	terminal: 6,
	maxHistory: 256,
};

/** Structured event describing authoritative progress/state change. */
export type StormProgressSignal =
	| { kind: "new_evidence"; evidenceHash: string }
	| { kind: "file_content_hash"; path: string; hash: string }
	| { kind: "diagnostics_hash"; hash: string }
	| { kind: "process_state"; identity: string; state: string }
	| { kind: "provider_result"; resultHash: string }
	| { kind: "transaction_state"; transactionId: string; state: string }
	| { kind: "user_input"; inputHash: string }
	| { kind: "retry_window_elapsed"; elapsedMs: number };

export interface StormContext {
	workspaceScope?: string;
	runScope?: string;
	/** Authoritative current state against which to detect progress. */
	progressSignals: StormProgressSignal[];
	/** Whether the tool is read-only (required for authoritative cache reuse). */
	readOnly: boolean;
	/** Whether the policy permits reusing a prior result (default true for read-only). */
	policyAllowsReuse?: boolean;
}

export interface StormClassifyInput extends StormContext {
	toolName: string;
	canonicalArgsHash: string;
	/** Optional cached prior result for reuse. */
	priorResult?: { result: AgentToolResult<any>; validityFingerprint: string; at: number };
	/** Current prior result validity fingerprint (authoritative state identity). */
	currentValidityFingerprint?: string;
}

export type StormDecision =
	| { stage: "fresh"; execute: true }
	| {
			stage: "duplicate_annotate";
			execute: true;
			reason: string;
			cachedResult?: AgentToolResult<any>;
			duplicateCount: number;
	  }
	| { stage: "no_progress_reflect"; execute: true; reason: string; duplicateCount: number; requireReflection: true }
	| {
			stage: "storm_blocked";
			execute: false;
			errorCode: "TOOL_CALL_STORM_BLOCKED";
			reason: string;
			duplicateCount: number;
	  }
	| {
			stage: "strategy_pivot_required";
			execute: false;
			errorCode: "TOOL_STRATEGY_PIVOT_REQUIRED";
			reason: string;
			duplicateCount: number;
	  };

interface HistoryEntry {
	fingerprint: string;
	firstAt: number;
	lastAt: number;
	count: number;
	lastStateHash: string | null;
	cachedResult?: { result: AgentToolResult<any>; validityFingerprint: string; at: number };
}

/**
 * Durable storm-breaker state for one run/workspace. One instance per active
 * agent strategy; reset at user turn boundaries. Reads only structured signals
 * for progress.
 */
export class StormBreaker {
	private history = new Map<string, HistoryEntry>();
	private thresholds: StormThresholds;

	constructor(
		thresholds: Partial<StormThresholds> = {},
		private now: () => number = () => Date.now(),
	) {
		this.thresholds = { ...DEFAULT_STORM_THRESHOLDS, ...thresholds };
	}

	/** Combine structured progress signals into an authoritative state hash. */
	private stateHash(signals: StormProgressSignal[]): string | null {
		if (signals.length === 0) return null;
		return stableHash(signals.map((s) => ({ k: s.kind, v: "value" in s ? s.value : null })));
	}

	/**
	 * Classify a call. Returns whether to execute and with what annotation.
	 * Progress detection: if the authoritative state hash differs from the last
	 * recorded state for this fingerprint, the call is treated as FRESH (context
	 * changed → not a duplicate).
	 */
	classify(input: StormClassifyInput): StormDecision {
		const fp = fingerprintCall({
			toolName: input.toolName,
			canonicalArgsHash: input.canonicalArgsHash,
			workspaceScope: input.workspaceScope,
			runScope: input.runScope,
		});
		const stateHash = this.stateHash(input.progressSignals);
		const now = this.now();

		let entry = this.history.get(fp);
		if (!entry) {
			entry = { fingerprint: fp, firstAt: now, lastAt: now, count: 1, lastStateHash: stateHash };
			this.history.set(fp, entry);
			if (this.history.size > this.thresholds.maxHistory) {
				this.evictOldest();
			}
			return { stage: "fresh", execute: true };
		}

		// Progress check: state changed since last recorded → not a duplicate.
		// A transition from null (no signal) to a concrete hash also counts as
		// authoritative progress.
		if (stateHash !== null && stateHash !== entry.lastStateHash) {
			entry.count = 1;
			entry.lastStateHash = stateHash;
			entry.firstAt = now;
			return { stage: "fresh", execute: true };
		}
		entry.lastStateHash = stateHash;
		entry.count += 1;
		entry.lastAt = now;

		const reuseAllowed =
			input.readOnly &&
			input.policyAllowsReuse !== false &&
			entry.cachedResult !== undefined &&
			entry.cachedResult.validityFingerprint === input.currentValidityFingerprint;

		const cached = reuseAllowed ? entry.cachedResult!.result : undefined;
		const count = entry.count;

		if (count >= this.thresholds.terminal) {
			return {
				stage: "strategy_pivot_required",
				execute: false,
				errorCode: TOOL_STRATEGY_PIVOT_REQUIRED,
				reason: `call ${input.toolName} repeated ${count}x with zero authoritative progress`,
				duplicateCount: count,
			};
		}
		if (count >= this.thresholds.block) {
			return {
				stage: "storm_blocked",
				execute: false,
				errorCode: TOOL_CALL_STORM_BLOCKED,
				reason: `repeated identical ${input.toolName} call (${count}x) with no new evidence`,
				duplicateCount: count,
			};
		}
		if (count >= this.thresholds.reflect) {
			return {
				stage: "no_progress_reflect",
				execute: true,
				reason: `no progress detected across ${count} identical ${input.toolName} calls`,
				duplicateCount: count,
				requireReflection: true,
			};
		}
		// annotate (>= annotate threshold); reuse cache when allowed.
		if (count >= this.thresholds.annotate) {
			return {
				stage: "duplicate_annotate",
				execute: true,
				reason: `duplicate ${input.toolName} call (${count}x)`,
				cachedResult: cached,
				duplicateCount: count,
			};
		}
		return { stage: "fresh", execute: true };
	}

	/** Record a cached authoritative result for later read-only reuse. */
	recordResult(input: {
		toolName: string;
		canonicalArgsHash: string;
		workspaceScope?: string;
		runScope?: string;
		result: AgentToolResult<any>;
		validityFingerprint: string;
	}): void {
		const fp = fingerprintCall({
			toolName: input.toolName,
			canonicalArgsHash: input.canonicalArgsHash,
			workspaceScope: input.workspaceScope,
			runScope: input.runScope,
		});
		const entry = this.history.get(fp) ?? {
			fingerprint: fp,
			firstAt: this.now(),
			lastAt: this.now(),
			count: 1,
			lastStateHash: null,
		};
		entry.cachedResult = { result: input.result, validityFingerprint: input.validityFingerprint, at: this.now() };
		this.history.set(fp, entry);
	}

	/** Register an authoritative progress signal so subsequent calls are fresh. */
	noteProgress(signals: StormProgressSignal[]): void {
		if (signals.length === 0) return;
		const hash = this.stateHash(signals);
		if (hash === null) return;
		for (const entry of this.history.values()) {
			if (entry.lastStateHash !== hash) {
				entry.lastStateHash = hash;
				entry.count = 1; // state changed → the next identical call is fresh
			}
		}
	}

	/** Reset per-turn state (fresh user turn). */
	reset(): void {
		this.history.clear();
	}

	snapshot(): { historySize: number; counts: Record<string, number> } {
		const counts: Record<string, number> = {};
		for (const [fp, e] of this.history) counts[fp] = e.count;
		return { historySize: this.history.size, counts };
	}

	private evictOldest(): void {
		let oldestKey: string | null = null;
		let oldestAt = Infinity;
		for (const [k, e] of this.history) {
			if (e.lastAt < oldestAt) {
				oldestAt = e.lastAt;
				oldestKey = k;
			}
		}
		if (oldestKey) this.history.delete(oldestKey);
	}
}
