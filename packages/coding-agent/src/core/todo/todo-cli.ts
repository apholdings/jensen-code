/**
 * TODO operability CLI surfaces.
 *
 * The TODO store is advisory session/runtime coordination state. These
 * read-only diagnostics describe the canonical model and, when a live engine
 * diagnostic is supplied, the current scope health. They never expose
 * unrelated task content by default.
 */

import { DEFAULT_TODO_ENGINE_LIMITS } from "./todo-engine.js";

export interface TodoDiagnosticInput {
	scopeId?: string;
	progressEpoch?: number;
	lastTodoReadRevision?: number;
	snapshotCount?: number;
	ledgerCount?: number;
	eventCount?: number;
	chainActive?: boolean;
	chainConsecutive?: number;
	isLoopBlocked?: boolean;
}

export interface TodoStatusReport {
	model: {
		revision: "monotonic";
		concurrency: "optimistic";
		recovery: "internal_read_and_rebase_bounded";
		rebaseAttempts: number;
		idempotency: "bounded_ledger";
		loopThreshold: number;
		advisory: true;
	};
	live?: TodoDiagnosticInput;
}

/** Build the canonical TODO status report (text or JSON). */
export function buildTodoStatusReport(diagnostics?: TodoDiagnosticInput): TodoStatusReport {
	return {
		model: {
			revision: "monotonic",
			concurrency: "optimistic",
			recovery: "internal_read_and_rebase_bounded",
			rebaseAttempts: DEFAULT_TODO_ENGINE_LIMITS.maxInternalRebaseAttempts,
			idempotency: "bounded_ledger",
			loopThreshold: DEFAULT_TODO_ENGINE_LIMITS.maxNoProgressFailures,
			advisory: true,
		},
		live: diagnostics,
	};
}

export function formatTodoStatus(report: TodoStatusReport): string {
	const lines: string[] = [];
	lines.push("TODO subsystem: advisory, NOT execution authority");
	lines.push(`  revision:        ${report.model.revision}`);
	lines.push(`  concurrency:     ${report.model.concurrency}`);
	lines.push(`  stale recovery:  ${report.model.recovery} (${report.model.rebaseAttempts} attempt(s))`);
	lines.push(`  idempotency:     ${report.model.idempotency}`);
	lines.push(`  loop threshold:  ${report.model.loopThreshold} consecutive no-progress failure(s)`);
	if (report.live) {
		lines.push(`  scope:           ${report.live.scopeId ?? "n/a"}`);
		lines.push(`  progress epoch:  ${report.live.progressEpoch ?? 0}`);
		lines.push(`  snapshots:       ${report.live.snapshotCount ?? 0}`);
		lines.push(`  applied intents: ${report.live.ledgerCount ?? 0}`);
		lines.push(`  loop blocked:    ${report.live.isLoopBlocked ?? false}`);
	} else {
		lines.push("  scope:           (no live session state)");
	}
	return lines.join("\n");
}
