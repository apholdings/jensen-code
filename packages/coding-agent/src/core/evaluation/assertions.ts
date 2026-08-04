import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { EvaluationAssertionResult, EvaluationAssertionSpec, EvaluationEvent, JsonValue } from "./types.js";

const execAsync = promisify(exec);

export interface AssertionContext {
	workspaceRoot?: string;
	events: EvaluationEvent[];
	metrics: Record<string, number | undefined>;
	evidenceIds: Set<string>;
	timeoutMs: number;
}

function result(
	spec: EvaluationAssertionSpec,
	status: EvaluationAssertionResult["status"],
	expected: JsonValue | undefined,
	observed: JsonValue | undefined,
	reasonCode: string,
	evidenceIds: string[] = [],
): EvaluationAssertionResult {
	return {
		assertionId: spec.assertionId,
		status,
		expected,
		observed,
		evidenceIds,
		reasonCode,
		severity: spec.severity,
	};
}

function workspacePath(root: string | undefined, filePath: string | undefined): string {
	if (!root || !filePath || isAbsolute(filePath)) throw new Error("workspace-relative path required");
	const resolved = resolve(root, filePath);
	if (
		resolved !== resolve(root) &&
		!resolved.startsWith(`${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`)
	)
		throw new Error("path escapes evaluation workspace");
	return resolved;
}

function eventMatches(event: EvaluationEvent, spec: EvaluationAssertionSpec): boolean {
	if (event.type !== spec.pattern && spec.pattern !== undefined) return false;
	if (spec.expected && typeof spec.expected === "object" && !Array.isArray(spec.expected)) {
		for (const [key, value] of Object.entries(spec.expected)) {
			if (event.details?.[key] !== value) return false;
		}
	}
	return true;
}

export async function evaluateAssertion(
	spec: EvaluationAssertionSpec,
	context: AssertionContext,
): Promise<EvaluationAssertionResult> {
	try {
		switch (spec.kind) {
			case "file_exists": {
				const path = workspacePath(context.workspaceRoot, spec.path);
				try {
					await readFile(path);
					return result(spec, "pass", true, true, "FILE_EXISTS", [spec.assertionId]);
				} catch {
					return result(spec, "fail", true, false, "FILE_MISSING");
				}
			}
			case "file_absent": {
				const path = workspacePath(context.workspaceRoot, spec.path);
				try {
					await readFile(path);
					return result(spec, "fail", false, true, "FILE_PRESENT");
				} catch {
					return result(spec, "pass", false, false, "FILE_ABSENT", [spec.assertionId]);
				}
			}
			case "file_content": {
				const path = workspacePath(context.workspaceRoot, spec.path);
				const content = await readFile(path, "utf8");
				const expected = typeof spec.expected === "string" ? spec.expected : "";
				const matches = spec.pattern ? new RegExp(spec.pattern, "u").test(content) : content === expected;
				return result(
					spec,
					matches ? "pass" : "fail",
					spec.expected,
					content,
					matches ? "FILE_CONTENT" : "FILE_CONTENT_MISMATCH",
					[spec.assertionId],
				);
			}
			case "command": {
				if (!context.workspaceRoot || !spec.command)
					return result(spec, "invalid", spec.expected, undefined, "COMMAND_CONTEXT_MISSING");
				const commandResult = await execAsync(spec.command, {
					cwd: context.workspaceRoot,
					timeout: context.timeoutMs,
					maxBuffer: 2 * 1024 * 1024,
					windowsHide: true,
				});
				const observed = commandResult.stdout.trim();
				const expected = spec.expected;
				const pass = expected === undefined || observed === String(expected);
				return result(
					spec,
					pass ? "pass" : "fail",
					expected,
					observed,
					pass ? "COMMAND_PASS" : "COMMAND_OUTPUT_MISMATCH",
					[spec.assertionId],
				);
			}
			case "git_diff": {
				if (!context.workspaceRoot) return result(spec, "invalid", spec.expected, undefined, "WORKSPACE_MISSING");
				const { stdout } = await execAsync("git diff --no-ext-diff --binary", {
					cwd: context.workspaceRoot,
					timeout: context.timeoutMs,
					maxBuffer: 4 * 1024 * 1024,
				});
				const expected = typeof spec.expected === "string" ? spec.expected : "";
				const pass = spec.pattern ? new RegExp(spec.pattern, "u").test(stdout) : stdout === expected;
				return result(
					spec,
					pass ? "pass" : "fail",
					spec.expected,
					stdout,
					pass ? "GIT_DIFF_MATCH" : "GIT_DIFF_MISMATCH",
					[spec.assertionId],
				);
			}
			case "event_present": {
				const matches = context.events.filter((event) => eventMatches(event, spec));
				return result(
					spec,
					matches.length > 0 ? "pass" : "fail",
					true,
					matches.length > 0,
					matches.length > 0 ? "EVENT_PRESENT" : "EVENT_MISSING",
					matches.map((event) => event.eventId),
				);
			}
			case "event_absent": {
				const matches = context.events.filter((event) => eventMatches(event, spec));
				return result(
					spec,
					matches.length === 0 ? "pass" : "fail",
					false,
					matches.length > 0,
					matches.length === 0 ? "EVENT_ABSENT" : "EVENT_UNEXPECTED",
					matches.map((event) => event.eventId),
				);
			}
			case "event_order": {
				const order = Array.isArray(spec.expected) ? spec.expected.map(String) : [];
				const indices = order.map((type) => context.events.findIndex((event) => event.type === type));
				const pass = indices.every(
					(index, position) => index >= 0 && (position === 0 || index > indices[position - 1]!),
				);
				return result(
					spec,
					pass ? "pass" : "fail",
					order,
					indices,
					pass ? "EVENT_ORDER" : "EVENT_ORDER_MISMATCH",
					context.events.filter((event) => order.includes(event.type)).map((event) => event.eventId),
				);
			}
			case "tool_effect":
			case "policy_decision":
			case "transaction_state":
			case "rollback_state":
			case "process_cleanup": {
				const matches = context.events.filter((event) => eventMatches(event, spec));
				const pass = matches.length > 0 && matches.every((event) => event.details?.status !== "fail");
				return result(
					spec,
					pass ? "pass" : "fail",
					spec.expected,
					matches.map((event) => event.details ?? {}),
					pass ? `${spec.kind.toUpperCase()}_PASS` : `${spec.kind.toUpperCase()}_FAIL`,
					matches.map((event) => event.eventId),
				);
			}
			case "workspace_clean": {
				if (!context.workspaceRoot) return result(spec, "invalid", true, undefined, "WORKSPACE_MISSING");
				const { stdout } = await execAsync("git status --porcelain", {
					cwd: context.workspaceRoot,
					timeout: context.timeoutMs,
				});
				const pass = stdout.trim().length === 0;
				return result(spec, pass ? "pass" : "fail", true, pass, pass ? "WORKSPACE_CLEAN" : "WORKSPACE_DIRTY", [
					spec.assertionId,
				]);
			}
			case "budget_bound": {
				const metricId = spec.customKey ?? spec.path;
				if (!metricId) return result(spec, "invalid", spec.expected, undefined, "METRIC_ID_MISSING");
				const observed = context.metrics[metricId];
				if (observed === undefined || typeof spec.expected !== "number")
					return result(spec, "invalid", spec.expected, observed, "METRIC_EVIDENCE_MISSING");
				const pass = observed <= spec.expected;
				return result(
					spec,
					pass ? "pass" : "fail",
					spec.expected,
					observed,
					pass ? "BUDGET_WITHIN_BOUND" : "BUDGET_EXCEEDED",
					[spec.assertionId],
				);
			}
			case "evidence_linkage": {
				const evidenceId = typeof spec.expected === "string" ? spec.expected : undefined;
				const pass = evidenceId !== undefined && context.evidenceIds.has(evidenceId);
				return result(
					spec,
					pass ? "pass" : "fail",
					spec.expected,
					pass ? evidenceId : undefined,
					pass ? "EVIDENCE_LINKED" : "EVIDENCE_MISSING",
					pass ? [evidenceId!] : [],
				);
			}
			case "retrieval_relevance": {
				const relevant = context.events.filter(
					(event) => event.type === "retrieval.result" && event.details?.relevant === true,
				);
				const expected = typeof spec.expected === "number" ? spec.expected : 1;
				const observed = relevant.length;
				return result(
					spec,
					observed >= expected ? "pass" : "fail",
					expected,
					observed,
					observed >= expected ? "RETRIEVAL_RELEVANT" : "RETRIEVAL_MISS",
					relevant.map((event) => event.eventId),
				);
			}
			case "custom":
				return result(spec, "not_evaluated", spec.expected, undefined, "CUSTOM_ASSERTION_REQUIRES_HANDLER");
		}
	} catch (error) {
		return result(
			spec,
			"invalid",
			spec.expected,
			undefined,
			error instanceof Error ? `ASSERTION_ERROR:${error.message}` : "ASSERTION_ERROR",
		);
	}
}

export async function evaluateAssertions(
	specs: EvaluationAssertionSpec[],
	context: AssertionContext,
): Promise<EvaluationAssertionResult[]> {
	const results: EvaluationAssertionResult[] = [];
	for (const spec of specs) {
		if (
			spec.dependsOn?.some(
				(dependency) => results.find((item) => item.assertionId === dependency)?.status !== "pass",
			)
		) {
			results.push(result(spec, "not_evaluated", spec.expected, undefined, "DEPENDENCY_FAILED"));
			continue;
		}
		results.push(await evaluateAssertion(spec, context));
	}
	return results;
}
