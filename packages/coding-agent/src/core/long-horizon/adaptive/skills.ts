/**
 * Typed skill system.
 *
 * Skills are data/configuration — never automatically trusted code. A skill
 * manifest declares typed inputs, an output schema, allowed tools, denied
 * effects, execution mode, budget, timeout, success criteria, a model role,
 * version, and provenance. A skill can never grant capabilities the parent run
 * lacks: effective permissions are the intersection of user authorization ∩
 * parent policy ∩ skill allowlist ∩ execution mode. Repository Markdown is
 * never executed as a skill unless it has a recognized manifest + schema.
 */

import type { ModelRole, SkillExecutionMode, SkillManifest } from "./types.js";

export interface SkillValidation {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export interface EffectiveSkillPolicy {
	allowedTools: ReadonlySet<string>;
	deniedEffects: ReadonlySet<string>;
	executionMode: SkillExecutionMode;
	canPublish: boolean;
	canMutate: boolean;
}

/** Tools that a non-mutate skill may never claim, regardless of allowlist. */
const MUTATION_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"write_file",
	"edit",
	"delete",
	"git_commit",
	"git_push",
	"git_merge",
	"publish",
	"npm_publish",
	"mutation",
]);

const OBSERVE_COMPATIBLE_TOOLS: ReadonlySet<string> = new Set([
	"read_file",
	"grep",
	"find",
	"ls",
	"git_status",
	"git_log",
	"git_diff",
]);

export function validateSkillManifest(manifest: unknown): SkillValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (typeof manifest !== "object" || manifest === null) {
		return { valid: false, errors: ["NOT_AN_OBJECT"], warnings };
	}
	const m = manifest as Record<string, unknown>;

	if (typeof m.name !== "string" || m.name.length === 0) errors.push("NAME_REQUIRED");
	if (typeof m.version !== "number" || m.version < 1) errors.push("VERSION_REQUIRED");
	if (typeof m.description !== "string" || (m.description ?? "").length === 0) errors.push("DESCRIPTION_REQUIRED");
	if (!Array.isArray(m.allowedTools) || !m.allowedTools.every((t) => typeof t === "string")) {
		errors.push("ALLOWED_TOOLS_REQUIRED");
	}
	if (!Array.isArray(m.deniedEffects) || !m.deniedEffects.every((t) => typeof t === "string")) {
		errors.push("DENIED_EFFECTS_REQUIRED");
	}
	if (!Array.isArray(m.successCriteria) || m.successCriteria.length === 0) errors.push("SUCCESS_CRITERIA_REQUIRED");

	const mode = m.executionMode;
	if (mode !== "observe" && mode !== "static" && mode !== "mutate") {
		errors.push("INVALID_EXECUTION_MODE");
	}

	if (
		Array.isArray(m.allowedTools) &&
		m.allowedTools.some((t) => MUTATION_ONLY_TOOLS.has(t as string)) &&
		mode !== "mutate"
	) {
		errors.push("MUTATION_TOOL_WITHOUT_MUTATE_MODE");
	}

	if (m.inputs !== undefined) {
		if (!Array.isArray(m.inputs)) {
			errors.push("INPUTS_MUST_BE_ARRAY");
		} else {
			for (const input of m.inputs) {
				if (
					typeof input !== "object" ||
					input === null ||
					typeof (input as { name?: unknown }).name !== "string" ||
					typeof (input as { type?: unknown }).type !== "string"
				) {
					errors.push("INPUT_MUST_HAVE_NAME_AND_TYPE");
				}
			}
		}
	}

	if (m.deniedEffects !== undefined && !Array.isArray(m.deniedEffects)) {
		errors.push("DENIED_EFFECTS_MUST_BE_ARRAY");
	}

	return { valid: errors.length === 0, errors, warnings };
}

/**
 * Compute the effective policy as the intersection of parent allowlist, skill
 * allowlist, and execution mode. A skill cannot authorize tools the parent run
 * does not allow, and observe/static modes never mutate or publish.
 */
export function computeEffectiveSkillPolicy(
	skill: SkillManifest,
	parentAllowedTools: ReadonlySet<string>,
	userCanPublish: boolean,
	parentCanMutate: boolean,
): EffectiveSkillPolicy {
	const mutationOnlyInManifest = skill.allowedTools.some((t) => MUTATION_ONLY_TOOLS.has(t) || t === "mutation");
	const modePermitsMutation = skill.executionMode === "mutate";

	const allowedTools = new Set<string>();
	for (const tool of skill.allowedTools) {
		if (!parentAllowedTools.has(tool) && tool !== "mutation") continue;
		if (MUTATION_ONLY_TOOLS.has(tool) && !(modePermitsMutation && parentCanMutate)) continue;
		if (OBSERVE_COMPATIBLE_TOOLS.has(tool) || modePermitsMutation || skill.executionMode === "static") {
			allowedTools.add(tool);
		}
	}

	const deniedEffects = new Set(skill.deniedEffects);
	const canPublish = false; // a skill can never authorize publication
	const canMutate =
		userCanPublish &&
		modePermitsMutation &&
		parentCanMutate &&
		!deniedEffects.has("writesWorkspace") &&
		!deniedEffects.has("mutatesGit") &&
		!mutationOnlyInManifest;

	return {
		allowedTools,
		deniedEffects,
		executionMode: skill.executionMode,
		canPublish,
		canMutate,
	};
}

/** Inspect the default model role for a skill (bounded). */
export function skillModelRole(skill: SkillManifest): ModelRole {
	return skill.modelRole ?? "subagent";
}
