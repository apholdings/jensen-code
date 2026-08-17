/**
 * Local Qwen orchestration planner adapter.
 *
 * Implements the `OrchestrationPlanner` contract on top of the normal
 * `createAgentSession()` path: an explicit local Qwen model resolved from the
 * ModelRegistry, read-only tools, and the normal session stream (no direct
 * HTTP or provider calls here). The adapter sends one bounded structured-JSON
 * prompt and returns the machine JSON object parsed from the final assistant
 * message.
 *
 * This adapter is not yet wired into the CLI or the orchestrator lifecycle;
 * callers construct it explicitly and pass it to
 * `OrchestratorService.createFromPlanner()`. The adapter exposes the roster
 * it derives from (`roster()`, `allowedAgents()`) so callers can pass the
 * same operator set to `validateOrchestrationPlan` through its explicit
 * `operatorAgents` hook.
 */

import { join } from "node:path";
import type { StreamFn } from "@apholdings/jensen-agent-core";
import type { AssistantMessage, Model, TextContent } from "@apholdings/jensen-ai";
import { getAgentDir } from "../../config.js";
import { AuthStorage } from "../auth-storage.js";
import { ModelRegistry } from "../model-registry.js";
import {
	loadOperatorRoster,
	OPERATOR_LOCAL_MODEL,
	OPERATOR_LOCAL_MODEL_REFERENCE,
	OPERATOR_LOCAL_PROVIDER,
	type OperatorRoster,
} from "../operator-roster.js";
import type { ResourceLoader } from "../resource-loader.js";
import { createAgentSession } from "../sdk.js";
import { SessionManager } from "../session-manager.js";
import type { SettingsManager } from "../settings-manager.js";
import { createReadOnlyTools } from "../tools/index.js";
import type { OrchestrationPlanner, OrchestrationProposalInput } from "./types.js";

/** Maximum characters for the whole planner prompt. */
export const DEFAULT_QWEN_PLANNER_PROMPT_BUDGET = 8_000;
/** Maximum characters for the objective field inside the planner prompt. */
const OBJECTIVE_MAX = 4_000;
/** Maximum characters per constraint line inside the planner prompt. */
const CONSTRAINT_MAX = 200;
/** Maximum constraint lines inside the planner prompt. */
const CONSTRAINT_COUNT_MAX = 8;

export interface QwenPlannerOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: getAgentDir() */
	agentDir?: string;
	/** Auth storage. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: new ModelRegistry(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;
	/**
	 * Session manager. When omitted, each `propose()` call creates a fresh
	 * in-memory SessionManager (one-shot planner: no session file, and no
	 * state carried between proposals). Pass a persistent manager explicitly
	 * when lifecycle integration owns the session.
	 */
	sessionManager?: SessionManager;
	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Resource loader. When omitted, createAgentSession uses its default. */
	resourceLoader?: ResourceLoader;
	/**
	 * Test seam. When omitted the session uses the normal shared-inference
	 * stream (or the default provider stream when shared inference is off).
	 */
	streamFn?: StreamFn;
	/**
	 * Agent names the planner may assign to nodes.
	 * Default: the canonical operator roster names for agentDir.
	 */
	allowedAgents?: readonly string[];
	/** Maximum characters for the whole planner prompt. Default: 8000. */
	maxPromptCharacters?: number;
}

export interface QwenPlannerPromptInput {
	parentMissionId: string;
	objective: string;
	constraints: readonly string[];
	maxTotalLogicalAgents: number;
	allowedAgents: readonly string[];
	maxCharacters?: number;
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

interface PlannerPromptParts {
	trimmedObjective: string;
	/** Constraint lines kept after the count cap (each truncated to CONSTRAINT_MAX). */
	kept: string[];
	/** Non-empty constraint count before any cap or budget drop. */
	totalConstraints: number;
	render(objective: string, lines: readonly string[], objectiveTruncated: boolean): string;
}

function plannerPromptParts(input: QwenPlannerPromptInput): PlannerPromptParts {
	const trimmedObjective = input.objective.trim();
	const clean = input.constraints.map((constraint) => constraint.trim()).filter((constraint) => constraint.length > 0);

	// The most recent constraint (typically planner feedback appended by an
	// orchestrator retry) is never dropped by the count cap: keep the first
	// CONSTRAINT_COUNT_MAX - 1 and always keep the last one.
	let kept: string[];
	if (clean.length > CONSTRAINT_COUNT_MAX) {
		kept = [...clean.slice(0, CONSTRAINT_COUNT_MAX - 1), clean[clean.length - 1]];
	} else {
		kept = [...clean];
	}

	const render = (objective: string, lines: readonly string[], objectiveTruncated: boolean): string => {
		const constraintBlock = lines.length > 0 ? `\nConstraints:\n${lines.map((line) => `- ${line}`).join("\n")}` : "";
		const omitted = clean.length - lines.length;
		const notes = [
			omitted > 0
				? `${omitted} constraint(s) omitted to fit the prompt budget; the most recent constraint is always shown.`
				: undefined,
			objectiveTruncated ? "Objective truncated to fit the prompt budget." : undefined,
		].filter((note): note is string => note !== undefined);
		const feedbackBlock =
			notes.length > 0 ? `\nPrompt feedback:\n${notes.map((note) => `- ${note}`).join("\n")}` : "";
		return [
			"You are the orchestrator planner.",
			"Respond with exactly one JSON object and nothing else.",
			"No markdown, no code fences, no commentary.",
			"",
			"JSON schema:",
			"{",
			'  "decision": "DIRECT" | "FANOUT",',
			'  "rationale": "<short string>",',
			'  "nodes": [',
			"    {",
			'      "nodeId": "<unique id>",',
			'      "role": "<role>",',
			'      "nodeKind": "DIRECT" | "CHILD" | "SYNTHESIS" | "REVIEW" | "VERIFICATION",',
			'      "objective": "<bounded objective>",',
			'      "agent": "<one of the allowed agents>",',
			'      "executionMode": "observe" | "plan" | "execute",',
			'      "requirement": "REQUIRED" | "OPTIONAL" | "VERIFICATION_GATING",',
			'      "workspaceAccess": "READ_ONLY" | "WRITE",',
			'      "workspaceKey": "<optional shared workspace key>",',
			'      "status": "PROPOSED",',
			'      "independenceReason": "<optional reason>",',
			'      "acceptanceCriteria": ["<criterion>"]',
			"    }",
			"  ],",
			'  "edges": [ { "from": "<nodeId>", "to": "<nodeId>", "kind": "REQUIRED" | "OPTIONAL" } ]',
			"}",
			"",
			"Rules:",
			'- "DIRECT" means the parent executes the objective alone; "nodes" must be an empty array.',
			`- "FANOUT" requires at least one node and at most ${input.maxTotalLogicalAgents} nodes.`,
			`- Every "agent" must be one of: ${input.allowedAgents.join(", ")}.`,
			"- Edges must reference existing nodeIds and form an acyclic graph.",
			"- Keep objectives, rationale, and criteria short.",
			"",
			`Parent mission id: ${input.parentMissionId}`,
			"Objective:",
			objective,
			constraintBlock,
			feedbackBlock,
		]
			.filter((line) => line !== null)
			.join("\n");
	};

	return {
		trimmedObjective,
		kept: kept.map((constraint) => truncate(constraint, CONSTRAINT_MAX)),
		totalConstraints: clean.length,
		render,
	};
}

/**
 * Smallest prompt size possible for this input: empty objective, only the
 * most recent constraint (when any exist), and the feedback notes that would
 * then be visible. A budget below this cannot be honored.
 */
export function minQwenPlannerPromptBudget(input: QwenPlannerPromptInput): number {
	const parts = plannerPromptParts(input);
	const minimalLines = parts.kept.length > 0 ? [parts.kept[parts.kept.length - 1]] : [];
	return parts.render("", minimalLines, parts.trimmedObjective.length > 0).length;
}

/**
 * Build the bounded structured-JSON prompt for the planner model.
 *
 * The prompt always fits within `maxCharacters` (default 8000). Constraint
 * lines are capped individually; when the count cap or the budget omits
 * constraints, a "Prompt feedback" note in the prompt says so, and the most
 * recent constraint is always shown. The objective is cut exactly to the
 * remaining budget, with a visible truncation note. If `maxCharacters` is
 * below the fixed template floor for this input (see
 * `minQwenPlannerPromptBudget`), the call throws
 * ORCHESTRATION_PLANNER_BUDGET_BELOW_FLOOR instead of silently exceeding the
 * budget. Deterministic for identical inputs.
 */
export function buildQwenPlannerPrompt(input: QwenPlannerPromptInput): string {
	const maxCharacters = input.maxCharacters ?? DEFAULT_QWEN_PLANNER_PROMPT_BUDGET;
	const { trimmedObjective, kept, render } = plannerPromptParts(input);
	const objectiveNotePossible = trimmedObjective.length > 0;

	// Honest floor: below this, even an empty objective with only the most
	// recent constraint exceeds the budget, so the budget cannot be honored.
	const floor = render("", kept.length > 0 ? [kept[kept.length - 1]] : [], objectiveNotePossible).length;
	if (maxCharacters < floor)
		throw new Error(
			`ORCHESTRATION_PLANNER_BUDGET_BELOW_FLOOR: maxCharacters ${maxCharacters} is below the minimum planner template size ${floor}`,
		);

	let objective = trimmedObjective;
	let objectiveTruncated = false;
	if (objective.length > OBJECTIVE_MAX) {
		objective = truncate(objective, OBJECTIVE_MAX);
		objectiveTruncated = true;
	}

	// Fit: the note state is conservative (present whenever the objective is
	// still non-empty, since a budget cut would reveal it). Drop the oldest
	// constraints first; the most recent one is never dropped.
	let lines = [...kept];
	for (;;) {
		const overhead = render("", lines, objectiveTruncated || objective.length > 0).length;
		if (overhead + objective.length <= maxCharacters) break;
		if (lines.length > 1) {
			lines = lines.slice(1);
			continue;
		}
		const finalOverhead = render("", lines, objective.length > 0).length;
		const budget = Math.max(0, maxCharacters - finalOverhead);
		if (objective.length > budget) {
			objective = objective.slice(0, budget);
			objectiveTruncated = true;
		}
		break;
	}
	return render(objective, lines, objectiveTruncated);
}

/**
 * Extract the machine JSON object from the final assistant message text.
 *
 * Accepts bare JSON, fenced ```json blocks, and JSON embedded in prose (the
 * outermost `{...}` span). Throws ORCHESTRATION_PLANNER_OUTPUT_INVALID when no
 * JSON object can be recovered.
 */
export function parseQwenPlannerOutput(text: string): unknown {
	const trimmed = text.trim();
	const candidates: string[] = [];
	if (trimmed) candidates.push(trimmed);
	for (const match of trimmed.matchAll(/```(?:json|javascript)?\s*\n?([\s\S]*?)```/gu)) {
		if (match[1].trim()) candidates.push(match[1].trim());
	}
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			// Try the next candidate.
		}
	}
	throw new Error("ORCHESTRATION_PLANNER_OUTPUT_INVALID: final assistant message does not contain a JSON object");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

export class QwenPlannerAdapter implements OrchestrationPlanner {
	private readonly _cwd: string;
	private readonly _agentDir: string;
	private readonly _authStorage: AuthStorage;
	private readonly _modelRegistry: ModelRegistry;
	private readonly _sessionManager?: SessionManager;
	private readonly _settingsManager?: SettingsManager;
	private readonly _resourceLoader?: ResourceLoader;
	private readonly _streamFn?: StreamFn;
	private readonly _allowedAgents?: readonly string[];
	private readonly _maxPromptCharacters: number;

	constructor(options: QwenPlannerOptions = {}) {
		this._cwd = options.cwd ?? process.cwd();
		this._agentDir = options.agentDir ?? getAgentDir();
		this._authStorage = options.authStorage ?? AuthStorage.create(join(this._agentDir, "auth.json"));
		this._modelRegistry =
			options.modelRegistry ?? new ModelRegistry(this._authStorage, join(this._agentDir, "models.json"));
		this._sessionManager = options.sessionManager;
		this._settingsManager = options.settingsManager;
		this._resourceLoader = options.resourceLoader;
		this._streamFn = options.streamFn;
		this._allowedAgents = options.allowedAgents;
		this._maxPromptCharacters = options.maxPromptCharacters ?? DEFAULT_QWEN_PLANNER_PROMPT_BUDGET;
	}

	/**
	 * The operator roster this planner derives from (agents plus diagnostics).
	 * Rebuilt on every call, mirroring the canonical registry's no-cache
	 * authority rule.
	 */
	roster(): OperatorRoster {
		return loadOperatorRoster({ agentDir: this._agentDir });
	}

	/**
	 * Agent names the planner may assign to nodes: the explicit
	 * `allowedAgents` option when supplied, otherwise the roster names. Pass
	 * this set to `validateOrchestrationPlan` as `operatorAgents` so roster
	 * definitions and plan validation stay in sync.
	 */
	allowedAgents(): readonly string[] {
		return this._allowedAgents ?? this.roster().agents.map((agent) => agent.name);
	}

	async propose(input: OrchestrationProposalInput): Promise<unknown> {
		const model: Model<any> | undefined = this._modelRegistry.find(OPERATOR_LOCAL_PROVIDER, OPERATOR_LOCAL_MODEL);
		if (!model)
			throw new Error(
				`ORCHESTRATION_PLANNER_MODEL_UNAVAILABLE: ${OPERATOR_LOCAL_MODEL_REFERENCE} is not registered in the model registry`,
			);
		const prompt = buildQwenPlannerPrompt({
			parentMissionId: input.parentMissionId,
			objective: input.objective,
			constraints: input.constraints,
			maxTotalLogicalAgents: input.maxTotalLogicalAgents,
			allowedAgents: this.allowedAgents(),
			maxCharacters: this._maxPromptCharacters,
		});

		// A fresh in-memory session per proposal unless the caller explicitly
		// owns a persistent manager; planner proposals never share state.
		const sessionManager = this._sessionManager ?? SessionManager.inMemory(this._cwd);

		const { session } = await createAgentSession({
			cwd: this._cwd,
			agentDir: this._agentDir,
			authStorage: this._authStorage,
			modelRegistry: this._modelRegistry,
			sessionManager,
			settingsManager: this._settingsManager,
			resourceLoader: this._resourceLoader,
			model,
			tools: createReadOnlyTools(this._cwd),
			streamFn: this._streamFn,
		});

		await session.prompt(prompt, { expandPromptTemplates: false });

		const messages = session.messages;
		let finalMessage: AssistantMessage | undefined;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message && (message as { role?: unknown }).role === "assistant") {
				finalMessage = message as AssistantMessage;
				break;
			}
		}
		if (!finalMessage)
			throw new Error("ORCHESTRATION_PLANNER_OUTPUT_INVALID: no assistant message in final session state");
		if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted")
			throw new Error(
				`ORCHESTRATION_PLANNER_INFERENCE_FAILED: ${finalMessage.errorMessage ?? finalMessage.stopReason}`,
			);
		return parseQwenPlannerOutput(assistantText(finalMessage));
	}
}

export function createQwenPlanner(options: QwenPlannerOptions = {}): QwenPlannerAdapter {
	return new QwenPlannerAdapter(options);
}
