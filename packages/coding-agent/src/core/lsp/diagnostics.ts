import type { LspDiagnostic, LspDiagnosticResult, LspPublishDiagnosticsParams } from "./types.js";
import { LspDiagnosticSeverity } from "./types.js";

/**
 * Diagnostics as read-only code intelligence, a transaction validation gate,
 * and post-edit evidence. LSP diagnostics SUPPLEMENT builds/tests; they never
 * replace them and never become an execution authority.
 */

export interface DiagnosticsComparison {
	before: DiagnosticSummary;
	after: DiagnosticSummary;
	errorsIntroduced: number;
	errorsResolved: number;
	warningsIntroduced: number;
	warningsResolved: number;
}

export interface DiagnosticSummary {
	total: number;
	errors: number;
	warnings: number;
	informations: number;
	hints: number;
}

export function summarizeDiagnostics(rows: LspDiagnosticResult[]): DiagnosticSummary {
	let errors = 0;
	let warnings = 0;
	let informations = 0;
	let hints = 0;
	for (const d of rows) {
		switch (d.severity) {
			case LspDiagnosticSeverity.Error:
				errors++;
				break;
			case LspDiagnosticSeverity.Warning:
				warnings++;
				break;
			case LspDiagnosticSeverity.Information:
				informations++;
				break;
			case LspDiagnosticSeverity.Hint:
				hints++;
				break;
		}
	}
	return { total: rows.length, errors, warnings, informations, hints };
}

/** Converts published diagnostics into workspace-relative, deduped, capped rows. */
export function getDiagnosticRows(
	params: LspPublishDiagnosticsParams | null,
	workspaceRoot: string,
	_serverId: string,
	maxCount = 500,
): LspDiagnosticResult[] {
	if (!params) return [];
	const seen = new Set<string>();
	const rows: LspDiagnosticResult[] = [];
	for (const d of params.diagnostics) {
		const relPath = toWorkspaceRelative(params.uri, workspaceRoot);
		const key = `${relPath}|${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character}|${d.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		rows.push({
			workspaceRelativePath: relPath,
			range: d.range,
			severity: d.severity,
			code: d.code,
			source: d.source,
			message: d.message,
		});
		if (rows.length >= maxCount) break;
	}
	return rows;
}

export function toWorkspaceRelative(uri: string, workspaceRoot: string): string {
	const raw = decodeURIComponent(uri.startsWith("file://") ? uri.slice("file://".length) : uri);
	const normRoot = workspaceRoot.replace(/[\\/]+/g, "/").replace(/\/$/, "");
	const normRaw = raw.replace(/[\\/]+/g, "/");
	if (normRaw.startsWith(`${normRoot}/`)) return normRaw.slice(normRoot.length + 1);
	if (normRaw.startsWith(normRoot)) return normRaw.slice(normRoot.length);
	// Outside workspace: classify as external, read-only reference.
	return normRaw;
}

export type WarningPolicy = "allow" | "block";

export interface DiagnosticGateConfig {
	failOnNewLspErrors: boolean;
	allowExistingBaselineErrors: boolean;
	warningPolicy: WarningPolicy;
	diagnosticScope?: "affected_files" | "workspace";
}

export const DEFAULT_DIAGNOSTIC_GATE_CONFIG: DiagnosticGateConfig = {
	failOnNewLspErrors: true,
	allowExistingBaselineErrors: true,
	warningPolicy: "allow",
	diagnosticScope: "affected_files",
};

export interface DiagnosticGateResult {
	passed: boolean;
	reason?: string;
	comparison: DiagnosticsComparison;
}

/**
 * Compare before/after diagnostics for a transaction. The safe default is "no
 * new errors in affected files". Baseline errors may be allowed; new errors
 * fail the gate when `failOnNewLspErrors`.
 */
export function evaluateDiagnosticGate(
	before: LspDiagnosticResult[],
	after: LspDiagnosticResult[],
	config: Partial<DiagnosticGateConfig> = {},
): DiagnosticGateResult {
	const cfg: DiagnosticGateConfig = { ...DEFAULT_DIAGNOSTIC_GATE_CONFIG, ...config };
	const beforeSummary = summarizeDiagnostics(before);
	const afterSummary = summarizeDiagnostics(after);
	const errorsIntroduced = Math.max(0, afterSummary.errors - beforeSummary.errors);
	const errorsResolved = Math.max(0, beforeSummary.errors - afterSummary.errors);
	const warningsIntroduced = Math.max(0, afterSummary.warnings - beforeSummary.warnings);
	const warningsResolved = Math.max(0, beforeSummary.warnings - afterSummary.warnings);

	const comparison: DiagnosticsComparison = {
		before: beforeSummary,
		after: afterSummary,
		errorsIntroduced,
		errorsResolved,
		warningsIntroduced,
		warningsResolved,
	};

	if (cfg.failOnNewLspErrors && errorsIntroduced > 0) {
		return {
			passed: false,
			reason: `LSP diagnostics gate failed: ${errorsIntroduced} new error(s) introduced`,
			comparison,
		};
	}
	if (cfg.warningPolicy === "block" && warningsIntroduced > 0) {
		return {
			passed: false,
			reason: `LSP diagnostics gate failed (warnings): ${warningsIntroduced} new warning(s)`,
			comparison,
		};
	}
	return { passed: true, comparison };
}

export type { LspDiagnostic };
