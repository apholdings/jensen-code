export type {
	TodoEvent,
	TodoEventType,
	TodoFailureFingerprint,
	TodoMutationError,
	TodoPatchOp,
	TodoRebaseResult,
	TodoRecoveryAction,
	TodoStatus,
} from "../todo/index.js";
export {
	allowedTransitions,
	computeStateHash,
	TodoEngine,
	validateTransition,
} from "../todo/index.js";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	createBashTool,
	createLocalBashOperations,
} from "./bash.js";
export {
	createDeepResearchTool,
	type DeepResearchToolDetails,
	type DeepResearchToolInput,
	deepResearchTool,
} from "./deep-research.js";
export {
	createEditTool,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
} from "./edit.js";
export {
	createFindTool,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
} from "./find.js";
export {
	createGrepTool,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
} from "./grep.js";
export {
	createLsTool,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
} from "./ls.js";
export { createMemoryWriteTool, type MemoryWriteInput, memoryWriteTool } from "./memory-write.js";
export {
	type CreateLocalPowerShellOperationsOptions,
	createLocalPowerShellOperations,
	createPowerShellTool,
	type PowerShellOperations,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
	type PowerShellValidateResult,
	powershellTool,
	resetPowerShellHealthCheck,
} from "./powershell.js";
export {
	createProcessManagerTool,
	type ProcessManagerInput,
	type ProcessManagerOperations,
	type ProcessManagerToolOptions,
	type ProcessRecord,
	processManagerTool,
} from "./process-manager.js";
export {
	createReadTool,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
} from "./read.js";
export { TodoLoopGuard } from "./todo-loop-guard.js";
export { createTodoReadTool, type TodoReadInput, todoReadTool } from "./todo-read.js";
export { createTodoUpdateTool, type TodoUpdateInput, todoUpdateTool } from "./todo-update.js";
export { createTodoWriteTool, type TodoItem, todoWriteTool } from "./todo-write.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWebFetchTool,
	type WebFetchToolDetails,
	type WebFetchToolInput,
	webFetchTool,
} from "./web-fetch.js";
export { createWebResearchStatusTool, webResearchStatusTool } from "./web-research-status.js";
export {
	createWebSearchTool,
	type WebSearchResult,
	type WebSearchToolDetails,
	type WebSearchToolInput,
	type WebSearchToolOptions,
	webSearchTool,
} from "./web-search.js";
export {
	createWriteTool,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
} from "./write.js";

import type { AgentTool } from "@apholdings/jensen-agent-core";
import { PRODUCTION_TOOL_EFFECTS } from "../safety/effects.js";
import { type BashToolOptions, bashTool, createBashTool } from "./bash.js";
import { createDeepResearchTool, deepResearchTool } from "./deep-research.js";
import { createEditTool, editTool } from "./edit.js";
import { createFindTool, findTool } from "./find.js";
import { createGrepTool, grepTool } from "./grep.js";
import { createLsTool, lsTool } from "./ls.js";
import { memoryWriteTool } from "./memory-write.js";
import { createPowerShellTool, type PowerShellToolOptions, powershellTool } from "./powershell.js";
import { createProcessManagerTool, type ProcessManagerToolOptions, processManagerTool } from "./process-manager.js";
import { createReadTool, type ReadToolOptions, readTool } from "./read.js";
import { todoReadTool } from "./todo-read.js";
import { todoUpdateTool } from "./todo-update.js";
import { todoWriteTool } from "./todo-write.js";
import { createWebFetchTool, webFetchTool } from "./web-fetch.js";
import { createWebResearchStatusTool, webResearchStatusTool } from "./web-research-status.js";
import { createWebSearchTool, webSearchTool } from "./web-search.js";
import { createWorkspaceSearchTools } from "./workspace-search.js";
import { createWriteTool, writeTool } from "./write.js";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any>;

/** Attach canonical declared effects to a tool from the production registry. */
function attachEffects(tool: AgentTool<any>): AgentTool<any> {
	const effects = PRODUCTION_TOOL_EFFECTS[tool.name];
	if (effects) {
		return Object.assign(tool, { effects });
	}
	return tool;
}

function withEffectsList(tools: unknown[]): Tool[] {
	return (tools as AgentTool<any>[]).map((t) => attachEffects(t));
}

function withEffectsRecord(record: Record<string, AgentTool<any>>): Record<string, AgentTool<any>> {
	for (const key of Object.keys(record)) {
		record[key] = attachEffects(record[key]);
	}
	return record;
}

// Default tools for full access mode (using process.cwd())
export const codingTools: Tool[] = withEffectsList([
	readTool,
	bashTool,
	powershellTool,
	editTool,
	writeTool,
	todoWriteTool,
	todoReadTool,
	todoUpdateTool,
	memoryWriteTool,
	processManagerTool,
	...Object.values(createWorkspaceSearchTools(process.cwd())),
]);

// Read-only tools for exploration without modification (using process.cwd())
export const readOnlyTools: Tool[] = withEffectsList([
	readTool,
	grepTool,
	findTool,
	lsTool,
	todoReadTool,
	createWorkspaceSearchTools(process.cwd()).workspace_search,
	createWorkspaceSearchTools(process.cwd()).workspace_search_lexical,
	createWorkspaceSearchTools(process.cwd()).workspace_search_semantic,
	createWorkspaceSearchTools(process.cwd()).workspace_search_symbols,
	createWorkspaceSearchTools(process.cwd()).workspace_retrieval_status,
]);

// All available tools (using process.cwd())
export const allTools = withEffectsRecord({
	read: readTool,
	bash: bashTool,
	powershell: powershellTool,
	edit: editTool,
	write: writeTool,
	todo_write: todoWriteTool,
	todo_read: todoReadTool,
	todo_update: todoUpdateTool,
	memory_write: memoryWriteTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
	web_search: webSearchTool,
	web_fetch: webFetchTool,
	deep_research: deepResearchTool,
	web_research_status: webResearchStatusTool,
	process_manager: processManagerTool,
	...createWorkspaceSearchTools(process.cwd()),
});

export type ToolName = keyof typeof allTools;

export interface ToolsOptions {
	/** Options for the read tool */
	read?: ReadToolOptions;
	/** Options for the bash tool */
	bash?: BashToolOptions;
	/** Options for the PowerShell tool */
	powershell?: PowerShellToolOptions;
	/** Options for the process manager tool */
	process_manager?: ProcessManagerToolOptions;
}

/**
 * Create coding tools configured for a specific working directory.
 */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return withEffectsList([
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createPowerShellTool(cwd, options?.powershell),
		createEditTool(cwd),
		createWriteTool(cwd),
		todoWriteTool,
		todoReadTool,
		todoUpdateTool,
		memoryWriteTool,
		createProcessManagerTool(cwd, options?.process_manager),
	]);
}

/**
 * Create read-only tools configured for a specific working directory.
 */
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return withEffectsList([
		createReadTool(cwd, options?.read),
		createGrepTool(cwd),
		createFindTool(cwd),
		createLsTool(cwd),
		todoReadTool,
	]);
}

/**
 * Create all tools configured for a specific working directory.
 */
export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return withEffectsRecord({
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		powershell: createPowerShellTool(cwd, options?.powershell),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		todo_write: todoWriteTool,
		todo_read: todoReadTool,
		todo_update: todoUpdateTool,
		memory_write: memoryWriteTool,
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		web_search: createWebSearchTool(),
		web_fetch: createWebFetchTool(),
		deep_research: createDeepResearchTool(),
		web_research_status: createWebResearchStatusTool(),
		process_manager: createProcessManagerTool(cwd, options?.process_manager),
		...createWorkspaceSearchTools(cwd),
	});
}
