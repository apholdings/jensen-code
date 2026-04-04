export const SESSION_ULTRAPLAN_CUSTOM_TYPE = "session_ultraplan";

export interface UltraplanPhase {
	title: string;
	steps: string[];
}

export interface UltraplanArtifact {
	version: 1;
	plannerMode: "local_subagent";
	plannerAgent: "planner";
	executionState: "plan_only";
	objective: string;
	assumptions: string[];
	constraints: string[];
	phases: UltraplanPhase[];
	risks: string[];
	recommendedExecutionOrder: string[];
	actionableNextSteps: string[];
	createdAt: string;
}

export interface UltraplanRunResult {
	artifact: UltraplanArtifact;
	displayText: string;
	rawPlannerOutput: string;
}

export interface UltraplanApplySelection {
	steps: string[];
	source: "actionable_next_steps" | "first_phase_steps" | "none";
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((entry) => normalizeString(entry)).filter((entry): entry is string => entry !== undefined);
}

function normalizePhases(value: unknown): UltraplanPhase[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((entry) => {
			if (typeof entry !== "object" || entry === null) {
				return undefined;
			}
			const candidate = entry as Record<string, unknown>;
			const title = normalizeString(candidate.title);
			const steps = normalizeStringArray(candidate.steps);
			if (!title || steps.length === 0) {
				return undefined;
			}
			return { title, steps } satisfies UltraplanPhase;
		})
		.filter((entry): entry is UltraplanPhase => entry !== undefined);
}

function extractJsonCandidate(text: string): string {
	const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
	if (fencedMatch?.[1]) {
		return fencedMatch[1].trim();
	}

	const firstBrace = text.indexOf("{");
	const lastBrace = text.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
		return text.slice(firstBrace, lastBrace + 1);
	}

	return text.trim();
}

export function parseUltraplanArtifactData(data: unknown): UltraplanArtifact | undefined {
	if (typeof data !== "object" || data === null) {
		return undefined;
	}

	const candidate = data as Record<string, unknown>;
	const objective = normalizeString(candidate.objective);
	const phases = normalizePhases(candidate.phases);
	if (!objective || phases.length === 0) {
		return undefined;
	}

	return {
		version: 1,
		plannerMode: "local_subagent",
		plannerAgent: "planner",
		executionState: "plan_only",
		objective,
		assumptions: normalizeStringArray(candidate.assumptions),
		constraints: normalizeStringArray(candidate.constraints),
		phases,
		risks: normalizeStringArray(candidate.risks),
		recommendedExecutionOrder: normalizeStringArray(candidate.recommendedExecutionOrder),
		actionableNextSteps: normalizeStringArray(candidate.actionableNextSteps),
		createdAt: normalizeString(candidate.createdAt) ?? new Date().toISOString(),
	};
}

export function parseUltraplanArtifactFromText(text: string, createdAt = new Date().toISOString()): UltraplanArtifact {
	const jsonCandidate = extractJsonCandidate(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonCandidate);
	} catch (error) {
		throw new Error(
			`Planner returned invalid Ultraplan JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const artifact = parseUltraplanArtifactData({
		...(typeof parsed === "object" && parsed !== null ? parsed : {}),
		createdAt,
	});
	if (!artifact) {
		throw new Error(
			"Planner returned an invalid Ultraplan artifact. Expected objective, phases, and structured planning sections.",
		);
	}
	return artifact;
}

function formatSection(title: string, items: string[]): string {
	if (items.length === 0) {
		return `${title}\n- (none)`;
	}
	return `${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

export function selectUltraplanApplySteps(artifact: UltraplanArtifact): UltraplanApplySelection {
	const actionableNextSteps = Array.from(new Set(artifact.actionableNextSteps));
	if (actionableNextSteps.length > 0) {
		return {
			steps: actionableNextSteps,
			source: "actionable_next_steps",
		};
	}

	const firstPhaseSteps = Array.from(new Set(artifact.phases[0]?.steps ?? []));
	if (firstPhaseSteps.length > 0) {
		return {
			steps: firstPhaseSteps,
			source: "first_phase_steps",
		};
	}

	return {
		steps: [],
		source: "none",
	};
}

export function formatUltraplanArtifact(artifact: UltraplanArtifact): string {
	const phaseLines = artifact.phases.flatMap((phase, index) => {
		return [`${index + 1}. ${phase.title}`, ...phase.steps.map((step) => `   - ${step}`)];
	});

	return [
		"Ultraplan",
		"",
		`Objective: ${artifact.objective}`,
		`Planner mode: local planner subagent (${artifact.plannerAgent})`,
		"Execution: planning only; no execution has started",
		`Stored: ${artifact.createdAt}`,
		"",
		formatSection("Assumptions", artifact.assumptions),
		"",
		formatSection("Constraints", artifact.constraints),
		"",
		phaseLines.length > 0 ? `Phases\n${phaseLines.join("\n")}` : "Phases\n- (none)",
		"",
		formatSection("Risks / blockers", artifact.risks),
		"",
		formatSection("Recommended execution order", artifact.recommendedExecutionOrder),
		"",
		formatSection("Actionable next steps", artifact.actionableNextSteps),
	].join("\n");
}

export function formatUltraplanShowOutput(artifact: UltraplanArtifact | undefined): string {
	if (!artifact) {
		return "No persisted Ultraplan plan found for the current session branch.";
	}

	return `${formatUltraplanArtifact(artifact)}\n\nPersisted as session-owned Ultraplan state on the current branch.`;
}

export function buildUltraplanPlannerTask(options: {
	objective: string;
	memoryItems: readonly { key: string; value: string }[];
	todos: ReadonlyArray<{ content: string; activeForm: string; status: string }>;
}): string {
	const memoryLines =
		options.memoryItems.length > 0
			? options.memoryItems.map((item) => `- ${item.key}: ${item.value}`).join("\n")
			: "- (none)";
	const todoLines =
		options.todos.length > 0
			? options.todos.map((todo) => `- [${todo.status}] ${todo.content} | active: ${todo.activeForm}`).join("\n")
			: "- (none)";

	return [
		"Ultraplan task: produce a high-budget local execution plan only.",
		"Do not execute work.",
		"Do not suggest remote/background/session-URL/web-polling architecture.",
		"Do not widen into orchestration or automatic apply behavior.",
		"Return strict JSON only. No markdown fences. No prose before or after the JSON.",
		"",
		`Objective: ${options.objective}`,
		"",
		"Current persisted session memory:",
		memoryLines,
		"",
		"Current persisted todo state:",
		todoLines,
		"",
		"Required JSON shape:",
		"{",
		'  "objective": "string",',
		'  "assumptions": ["string"],',
		'  "constraints": ["string"],',
		'  "phases": [{ "title": "string", "steps": ["string"] }],',
		'  "risks": ["string"],',
		'  "recommendedExecutionOrder": ["string"],',
		'  "actionableNextSteps": ["string"]',
		"}",
		"",
		"Rules:",
		"- Keep the plan explicit, local-first, and user-triggered.",
		"- Include concrete constraints and blockers, not generic filler.",
		"- Make phases actionable enough to guide later manual execution.",
		"- Actionable next steps are planning outputs only; they are not executed.",
	].join("\n");
}

/**
 * Build a planner task for revising an existing Ultraplan artifact.
 * The revision instruction guides how to modify the existing plan.
 */
export function buildUltraplanRevisionTask(options: {
	instruction: string;
	existingArtifact: UltraplanArtifact;
	memoryItems: readonly { key: string; value: string }[];
	todos: ReadonlyArray<{ content: string; activeForm: string; status: string }>;
}): string {
	const memoryLines =
		options.memoryItems.length > 0
			? options.memoryItems.map((item) => `- ${item.key}: ${item.value}`).join("\n")
			: "- (none)";
	const todoLines =
		options.todos.length > 0
			? options.todos.map((todo) => `- [${todo.status}] ${todo.content} | active: ${todo.activeForm}`).join("\n")
			: "- (none)";

	return [
		"Ultraplan revision task: revise an existing local execution plan based on the provided instruction.",
		"Do not execute work.",
		"Do not suggest remote/background/session-URL/web-polling architecture.",
		"Do not widen into orchestration or automatic apply behavior.",
		"Return strict JSON only. No markdown fences. No prose before or after the JSON.",
		"",
		`Revision instruction: ${options.instruction}`,
		"",
		"Existing persisted plan artifact (JSON) to revise:",
		JSON.stringify(options.existingArtifact, null, 2),
		"",
		"Human-readable summary of the existing plan:",
		formatUltraplanArtifact(options.existingArtifact),
		"",
		"Current persisted session memory:",
		memoryLines,
		"",
		"Current persisted todo state:",
		todoLines,
		"",
		"Required JSON shape:",
		"{",
		'  "objective": "string",',
		'  "assumptions": ["string"],',
		'  "constraints": ["string"],',
		'  "phases": [{ "title": "string", "steps": ["string"] }],',
		'  "risks": ["string"],',
		'  "recommendedExecutionOrder": ["string"],',
		'  "actionableNextSteps": ["string"]',
		"}",
		"",
		"Rules:",
		"- Apply the revision instruction to update the existing plan.",
		"- Keep the plan explicit, local-first, and user-triggered.",
		"- Include concrete constraints and blockers, not generic filler.",
		"- Make phases actionable enough to guide later manual execution.",
		"- Actionable next steps are planning outputs only; they are not executed.",
	].join("\n");
}
