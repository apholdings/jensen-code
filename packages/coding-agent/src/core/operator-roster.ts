/**
 * Canonical operator roster loader.
 *
 * The operator roster is a separate, local-model authority surface from the
 * built-in subagent registry. It loads operator agent definitions from
 * `getAgentDir()/agents/*.md`, parses their frontmatter (name, description,
 * tools, model), and guarantees the canonical operator roles
 * (investigator, tester, synthesizer) always exist.
 *
 * Loading is per-file fault-tolerant: an unreadable file, malformed
 * frontmatter, a missing or duplicate name, or a non-local model produces a
 * diagnostic for that file only, and the rest of the roster loads unchanged.
 *
 * Every loaded operator agent must resolve to the local Qwen model
 * (`llamacpp-qwen38-bucephalus/qwen3.8-27b`). In strict mode (the default) a
 * file declaring a non-local model is rejected with a diagnostic and excluded
 * from the roster; the rest of the roster loads unchanged.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

export const OPERATOR_LOCAL_PROVIDER = "llamacpp-qwen38-bucephalus" as const;
export const OPERATOR_LOCAL_MODEL = "qwen3.8-27b" as const;
export const OPERATOR_LOCAL_MODEL_REFERENCE = `${OPERATOR_LOCAL_PROVIDER}/${OPERATOR_LOCAL_MODEL}` as const;

/** Operator roles that must always be present in the canonical roster. */
export const OPERATOR_ROSTER_NAMES = ["investigator", "tester", "synthesizer"] as const;

const SYNTHESIZED_DESCRIPTIONS: Record<(typeof OPERATOR_ROSTER_NAMES)[number], string> = {
	investigator:
		"Investigate one concrete question or failure against repository and runtime evidence without mutation.",
	tester: "Design and run bounded verification for completed work without mutation.",
	synthesizer: "Synthesize child results into one coherent, decision-ready summary without mutation.",
};

const SYNTHESIZED_TOOLS = ["read", "grep", "find", "ls"];

export type OperatorRosterAgentSource = "file" | "synthesized";

export interface OperatorRosterAgent {
	name: string;
	description: string;
	tools: string[];
	/** Normalized local model reference (always the canonical local Qwen). */
	model: string;
	source: OperatorRosterAgentSource;
	filePath?: string;
}

export interface OperatorRosterDiagnostic {
	code:
		| "OPERATOR_ROSTER_FILE_INVALID"
		| "OPERATOR_ROSTER_FRONTMATTER_INVALID"
		| "OPERATOR_ROSTER_NAME_MISSING"
		| "OPERATOR_ROSTER_NAME_DUPLICATE"
		| "OPERATOR_ROSTER_MODEL_NON_LOCAL";
	message: string;
	path?: string;
}

export interface OperatorRoster {
	agents: OperatorRosterAgent[];
	diagnostics: OperatorRosterDiagnostic[];
}

export interface LoadOperatorRosterOptions {
	/** Agent config directory. Default: getAgentDir() */
	agentDir?: string;
	/**
	 * Strict mode (default true): files declaring a non-local model are rejected
	 * and excluded from the roster. When false the file still loads, with a
	 * diagnostic, and keeps its declared model reference verbatim.
	 */
	strict?: boolean;
}

type OperatorFrontmatter = Record<string, unknown>;

/** Accept the local model as a bare id or the full `provider/model` reference. */
export function isLocalOperatorModel(value: string): boolean {
	return value === OPERATOR_LOCAL_MODEL || value === OPERATOR_LOCAL_MODEL_REFERENCE;
}

function normalizeTools(value: unknown): string[] {
	if (typeof value === "string")
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	if (Array.isArray(value))
		return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
	return [];
}

function synthesizeAgent(name: (typeof OPERATOR_ROSTER_NAMES)[number]): OperatorRosterAgent {
	return {
		name,
		description: SYNTHESIZED_DESCRIPTIONS[name],
		tools: [...SYNTHESIZED_TOOLS],
		model: OPERATOR_LOCAL_MODEL_REFERENCE,
		source: "synthesized",
	};
}

export function loadOperatorRoster(options: LoadOperatorRosterOptions = {}): OperatorRoster {
	const strict = options.strict ?? true;
	const agentDir = options.agentDir ?? getAgentDir();
	const agentsDir = join(agentDir, "agents");
	const diagnostics: OperatorRosterDiagnostic[] = [];
	const agents: OperatorRosterAgent[] = [];
	const seen = new Map<string, OperatorRosterAgent>();

	let files: string[] = [];
	if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) {
		files = readdirSync(agentsDir)
			.filter((entry) => entry.endsWith(".md"))
			.sort((left, right) => left.localeCompare(right));
	}

	for (const file of files) {
		const filePath = join(agentsDir, file);
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			diagnostics.push({ code: "OPERATOR_ROSTER_FILE_INVALID", message: `Cannot read ${file}`, path: file });
			continue;
		}
		let frontmatter: OperatorFrontmatter;
		try {
			frontmatter = parseFrontmatter<OperatorFrontmatter>(content).frontmatter;
		} catch (error) {
			diagnostics.push({
				code: "OPERATOR_ROSTER_FRONTMATTER_INVALID",
				message: `Malformed frontmatter in ${file}: ${error instanceof Error ? error.message : String(error)}`,
				path: file,
			});
			continue;
		}
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		if (!name) {
			diagnostics.push({
				code: "OPERATOR_ROSTER_NAME_MISSING",
				message: `Missing frontmatter name in ${file}`,
				path: file,
			});
			continue;
		}
		if (seen.has(name)) {
			diagnostics.push({
				code: "OPERATOR_ROSTER_NAME_DUPLICATE",
				message: `Duplicate operator name ${name}`,
				path: file,
			});
			continue;
		}
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		const declaredModel = typeof frontmatter.model === "string" ? frontmatter.model.trim() : "";
		if (declaredModel && !isLocalOperatorModel(declaredModel)) {
			diagnostics.push({
				code: "OPERATOR_ROSTER_MODEL_NON_LOCAL",
				message: `Operator ${name} declares non-local model ${declaredModel}`,
				path: file,
			});
			if (strict) continue;
		}
		const agent: OperatorRosterAgent = {
			name,
			description,
			tools: normalizeTools(frontmatter.tools),
			model: !declaredModel || isLocalOperatorModel(declaredModel) ? OPERATOR_LOCAL_MODEL_REFERENCE : declaredModel,
			source: "file",
			filePath: basename(file),
		};
		seen.set(name, agent);
		agents.push(agent);
	}

	for (const requiredName of OPERATOR_ROSTER_NAMES) {
		if (!seen.has(requiredName)) {
			const agent = synthesizeAgent(requiredName);
			seen.set(requiredName, agent);
			agents.push(agent);
		}
	}

	agents.sort((left, right) => left.name.localeCompare(right.name));
	return { agents, diagnostics };
}
