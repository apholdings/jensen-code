import type { AgentSession } from "./agent-session.js";

export interface RuntimeToolDefinitionSnapshot {
	name: string;
	description: string;
	parameters: unknown;
}

export interface RuntimeToolSurfaceSnapshot {
	effectiveModel: string | undefined;
	effectiveProvider: string | undefined;
	activeToolNames: string[];
	modelFacingToolDefinitions: RuntimeToolDefinitionSnapshot[];
	dispatcherToolNames: string[];
	promptToolNames: string[];
}

function extractPromptToolNames(systemPrompt: string): string[] {
	const toolsSection =
		systemPrompt.match(/Available tools:\n([\s\S]*?)\n\n(?:Execution environment|In addition)/)?.[1] ?? "";
	return [...toolsSection.matchAll(/^- ([a-z][a-z0-9_]*):/gm)].map((match) => match[1]);
}

/**
 * Capture the tool surface of an already-constructed runtime without making a
 * provider request. The model-facing definitions and dispatcher references are
 * deliberately read from Agent.state.tools, the exact collection used by the
 * agent loop at the provider boundary.
 */
export function captureRuntimeToolSurface(session: AgentSession): RuntimeToolSurfaceSnapshot {
	const activeTools = session.agent.state.tools;
	return {
		effectiveModel: session.model?.id,
		effectiveProvider: session.model?.provider,
		activeToolNames: activeTools.map((tool) => tool.name),
		modelFacingToolDefinitions: activeTools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
		dispatcherToolNames: activeTools.map((tool) => tool.name),
		promptToolNames: extractPromptToolNames(session.systemPrompt),
	};
}
