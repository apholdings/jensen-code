/**
 * Human-readable and machine-readable report generation.
 */

import type { BenchmarkEvaluationResult, EvaluatedRequirement } from "./types.js";

// =============================================================================
// Text Report
// =============================================================================

export function generateTextReport(result: BenchmarkEvaluationResult): string {
	const lines: string[] = [];
	const pad = (label: string, value: string, indent = "") => {
		lines.push(`${indent}${label.padEnd(28)} ${value}`);
	};

	lines.push("=".repeat(72));
	lines.push("  LONG-HORIZON BENCHMARK EVALUATION REPORT");
	lines.push("=".repeat(72));
	lines.push("");

	// Identity
	lines.push("BENCHMARK IDENTITY");
	lines.push("-".repeat(72));
	pad("Benchmark", result.benchmarkId);
	pad("Run", result.runId);
	pad("Agent", result.agent);
	pad("Model", result.model);
	lines.push("");

	// Schema validation
	lines.push("SCHEMA VALIDATION");
	lines.push("-".repeat(72));
	pad("Valid", result.schemaValidation.valid ? "PASS" : "FAIL");
	for (const err of result.schemaValidation.errors) {
		lines.push(`  ERROR: ${err}`);
	}
	for (const warn of result.schemaValidation.warnings) {
		lines.push(`  WARNING: ${warn}`);
	}
	if (!result.schemaValidation.valid) {
		lines.push("");
		lines.push("Evaluation aborted due to schema errors.");
		return lines.join("\n");
	}
	lines.push("");

	// Completion gate
	lines.push("COMPLETION GATE");
	lines.push("-".repeat(72));
	pad("Verdict", result.completionGate.passed ? "PASS" : "FAIL");
	pad("Requested Termination", result.completionGate.requestedTermination);
	pad("Effective Termination", result.completionGate.effectiveTermination);
	if (result.completionGate.blockingFindings.length > 0) {
		lines.push("  Blocking findings:");
		for (const f of result.completionGate.blockingFindings) {
			lines.push(`    [${f.code}] ${f.message}`);
		}
	}
	lines.push("");

	// Metrics
	lines.push("METRICS");
	lines.push("-".repeat(72));
	const m = result.metrics;
	pad("Verified Completion Ratio", `${(m.verifiedCompletionRatio * 100).toFixed(1)}%`);
	pad("Implementation Ratio", `${(m.implementationRatio * 100).toFixed(1)}%`);
	pad("Requirement Coverage", `${(m.requirementCoverage * 100).toFixed(1)}%`);
	pad("Omission Count", String(m.omissionCount));
	pad("Unsupported Claims", String(m.unsupportedClaimCount));
	pad("Forbidden Actions", String(m.forbiddenActionCount));
	pad("Premature Completion", m.prematureCompletion ? "YES" : "No");
	if (m.prematureCompletionReasons.length > 0) {
		for (const reason of m.prematureCompletionReasons) {
			lines.push(`  Reason: ${reason}`);
		}
	}
	pad("Operator Interventions", String(m.operatorInterventionCount));
	pad("Validation Completion", `${(m.validationCompletion * 100).toFixed(1)}%`);
	lines.push("");

	// Usage / cost (when available)
	if (m.usage) {
		lines.push("USAGE");
		lines.push("-".repeat(72));
		const u = m.usage;
		if (u.inputTokens !== undefined) pad("Input Tokens", formatNumber(u.inputTokens));
		if (u.outputTokens !== undefined) pad("Output Tokens", formatNumber(u.outputTokens));
		if (u.cachedTokens !== undefined) pad("Cached Tokens", formatNumber(u.cachedTokens));
		if (u.totalTokens !== undefined) pad("Total Tokens", formatNumber(u.totalTokens));
		if (u.toolCalls !== undefined) pad("Tool Calls", String(u.toolCalls));
		if (u.durationMs !== undefined) pad("Duration", formatDuration(u.durationMs));
		if (u.costUSD !== undefined) pad("Cost", `$${u.costUSD.toFixed(4)}`);
		lines.push("");
	}

	// Requirement summary
	lines.push("REQUIREMENT SUMMARY");
	lines.push("-".repeat(72));

	const byStatus: Record<string, EvaluatedRequirement[]> = {};
	for (const req of result.requirementResults) {
		const s = req.evaluatedStatus;
		byStatus[s] = byStatus[s] ?? [];
		byStatus[s]!.push(req);
	}

	const statusOrder: Array<{ status: string; label: string }> = [
		{ status: "SATISFIED", label: "SATISFIED" },
		{ status: "IMPLEMENTED_UNVERIFIED", label: "IMPLEMENTED_UNVERIFIED" },
		{ status: "FAILED", label: "FAILED" },
		{ status: "BLOCKED", label: "BLOCKED" },
		{ status: "UNASSESSED", label: "UNASSESSED / OMITTED" },
		{ status: "IN_PROGRESS", label: "IN_PROGRESS" },
		{ status: "PENDING", label: "PENDING" },
		{ status: "NOT_APPLICABLE", label: "NOT_APPLICABLE" },
	];

	for (const { status, label } of statusOrder) {
		const reqs = byStatus[status];
		if (!reqs || reqs.length === 0) continue;
		lines.push(`  ${label}: ${reqs.length}`);
		for (const req of reqs) {
			const marker = req.required ? "*" : " ";
			lines.push(`    ${marker} ${req.id}: ${req.description}`);
			if (req.evaluatedStatus !== req.manifestStatus) {
				lines.push(`      Claimed: ${req.manifestStatus} → Evaluated: ${req.evaluatedStatus}`);
			}
			if (req.statusRationale) {
				lines.push(`      ${req.statusRationale}`);
			}
		}
	}
	lines.push("");

	// All findings
	if (result.findings.length > 0) {
		lines.push("FINDINGS");
		lines.push("-".repeat(72));
		const bySeverity = {
			error: result.findings.filter((f) => f.severity === "error"),
			warning: result.findings.filter((f) => f.severity === "warning"),
			info: result.findings.filter((f) => f.severity === "info"),
		};
		for (const sev of ["error", "warning", "info"] as const) {
			const fList = bySeverity[sev];
			if (fList.length === 0) continue;
			lines.push(`  ${sev.toUpperCase()}: ${fList.length}`);
			for (const f of fList) {
				lines.push(`    [${f.code}] ${f.message}`);
			}
			lines.push("");
		}
	}

	lines.push("=".repeat(72));
	lines.push("END OF REPORT");

	return lines.join("\n");
}

// =============================================================================
// JSON Report
// =============================================================================

export function generateJsonReport(result: BenchmarkEvaluationResult): string {
	return JSON.stringify(result, null, 2);
}

// =============================================================================
// Helpers
// =============================================================================

function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatDuration(ms: number): string {
	if (ms >= 60_000) {
		const min = Math.floor(ms / 60_000);
		const sec = Math.round((ms % 60_000) / 1_000);
		return `${min}m ${sec}s`;
	}
	if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
	return `${ms}ms`;
}
