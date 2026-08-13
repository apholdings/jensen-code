/**
 * Verification Engine — deterministic, extensible verification operations.
 *
 * A verifier turns an observation (command exit code, file state, search
 * result, git diff) into a VerificationResult with a pass/fail decision. The
 * decision is computed by Jensen from machine-observable facts — never from
 * model output or model self-review.
 */

import type { MissionEvidenceType, VerificationResult, VerificationSpec } from "./types.js";

export interface VerificationExecutor {
	runCommand(command: string, cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	fileExists(path: string, cwd?: string): Promise<boolean>;
	readFile(path: string, cwd?: string): Promise<string>;
	searchMatches(pattern: string, cwd?: string): Promise<string[]>;
	gitChangedPaths(cwd?: string): Promise<string[]>;
}

export interface VerificationOptions {
	criterionId?: string;
	cwd?: string;
	now?: () => string;
}

const KIND_TO_EVIDENCE_TYPE: Record<VerificationSpec["kind"], MissionEvidenceType> = {
	command: "tool_result",
	test: "test_result",
	build: "build_result",
	lint: "verification_result",
	typecheck: "verification_result",
	file_exists: "file_state",
	file_absent: "file_state",
	file_contains: "file_state",
	search_no_matches: "search_result",
	git_diff_scope: "file_state",
};

let evidenceCounter = 0;
function evidenceId(kind: VerificationSpec["kind"], now: string): string {
	evidenceCounter += 1;
	return `ev_${kind}_${now.replace(/\D/g, "")}_${evidenceCounter}`;
}

/**
 * Execute a single deterministic verification operation.
 */
export async function verify(
	spec: VerificationSpec,
	executor: VerificationExecutor,
	options: VerificationOptions = {},
): Promise<VerificationResult> {
	const now = options.now ?? (() => new Date().toISOString());
	const cwd = spec.cwd ?? options.cwd;
	const kind = spec.kind;
	const type = KIND_TO_EVIDENCE_TYPE[kind];
	const criterionIds = options.criterionId ? [options.criterionId] : [];

	let passed = false;
	let summary = "";
	let detail: string | undefined;
	let data: unknown;

	switch (kind) {
		case "command":
		case "test":
		case "build":
		case "lint":
		case "typecheck": {
			if (!spec.command) {
				return {
					passed: false,
					kind,
					evidence: {
						id: evidenceId(kind, now()),
						type,
						source: "runtime",
						summary: `missing command for ${kind}`,
						success: false,
						criterionIds,
						timestamp: now(),
					},
					detail: `VerificationSpec for ${kind} requires a command`,
				};
			}
			const result = await executor.runCommand(spec.command, cwd);
			passed = result.exitCode === 0;
			summary = `${spec.command} → exit ${result.exitCode}`;
			detail = result.stdout || result.stderr ? (result.stderr || result.stdout).slice(0, 500) : undefined;
			data = { command: spec.command, exitCode: result.exitCode };
			break;
		}

		case "file_exists": {
			const exists = await executor.fileExists(spec.path ?? "", cwd);
			passed = exists;
			summary = `file exists: ${spec.path}`;
			data = { path: spec.path, exists };
			break;
		}

		case "file_absent": {
			const exists = await executor.fileExists(spec.path ?? "", cwd);
			passed = !exists;
			summary = `file absent: ${spec.path}`;
			data = { path: spec.path, exists };
			break;
		}

		case "file_contains": {
			const content = await executor.readFile(spec.path ?? "", cwd);
			passed = spec.pattern ? content.includes(spec.pattern) : false;
			summary = `file contains pattern: ${spec.path}`;
			data = { path: spec.path, pattern: spec.pattern };
			break;
		}

		case "search_no_matches": {
			const matches = await executor.searchMatches(spec.pattern ?? "", cwd);
			passed = matches.length === 0;
			summary = `no stale references for: ${spec.pattern}`;
			detail = matches.length > 0 ? `matches: ${matches.slice(0, 20).join(", ")}` : undefined;
			data = { pattern: spec.pattern, matchCount: matches.length };
			break;
		}

		case "git_diff_scope": {
			const changed = await executor.gitChangedPaths(cwd);
			const allowed = spec.allowedPaths ?? [];
			const outOfScope = changed.filter(
				(p) => !allowed.some((a) => p === a || p.startsWith(`${a.replace(/\/$/, "")}/`)),
			);
			passed = outOfScope.length === 0;
			summary = `git diff scope: ${changed.length} changed path(s), ${outOfScope.length} out of scope`;
			detail = outOfScope.length > 0 ? `out of scope: ${outOfScope.join(", ")}` : undefined;
			data = { allowedPaths: allowed, changedPaths: changed, outOfScope };
			break;
		}
	}

	return {
		passed,
		kind,
		criterionId: options.criterionId,
		evidence: {
			id: evidenceId(kind, now()),
			type,
			source: "runtime",
			summary,
			success: passed,
			criterionIds,
			timestamp: now(),
			data,
		},
		detail,
	};
}
