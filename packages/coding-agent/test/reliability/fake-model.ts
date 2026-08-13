/**
 * Deterministic adversarial fake model and in-memory world for the Reliability
 * Suite. The trusted runtime must stay safe even when the model behaves badly,
 * so the suite drives the kernel with scripted raw outputs — no real LLM.
 */

import type { ActionPolicyAdapter, ToolSchemaValidator } from "../../src/core/reliability/action-validator.js";
import type { ReliabilityExecutionContext } from "../../src/core/reliability/execution.js";
import type { MissionEvidence, ToolCallAction } from "../../src/core/reliability/types.js";
import type { VerificationExecutor } from "../../src/core/reliability/verifier.js";

// =============================================================================
// Scripted model
// =============================================================================

/** A deterministic model that emits a fixed script of raw outputs. */
export class AdversarialModel {
	private readonly script: unknown[];
	private index = 0;
	readonly turns: number = 0;

	constructor(script: unknown[]) {
		this.script = [...script];
	}

	next(): unknown {
		if (this.index >= this.script.length) {
			return null;
		}
		return this.script[this.index++];
	}

	get exhausted(): boolean {
		return this.index >= this.script.length;
	}
}

// Raw-output builders (represent heterogeneous provider/model shapes).
export function rawToolCall(tool: string, args: Record<string, unknown>): unknown {
	return { type: "tool_call", tool, toolCallId: `tc_${tool}_${args.hash ?? ""}`, arguments: args };
}

export function rawNativeToolCall(tool: string, args: Record<string, unknown>): unknown {
	return { name: tool, id: `tc_${tool}`, arguments: args };
}

export function rawMalformedAction(): unknown {
	return { type: "tool_call" }; // missing `tool`
}

export function rawUnknownTool(): unknown {
	return rawToolCall("magical_fix_everything", {});
}

export function rawFinalCandidate(claimedCriterionIds?: string[]): unknown {
	return { type: "final_candidate", claimedCriterionIds };
}

export function rawPrematureDone(): unknown {
	return { type: "final_candidate", summary: "Everything is complete." };
}

export function rawTextDone(): unknown {
	return "Everything is complete. MISSION_COMPLETE";
}

// =============================================================================
// In-memory world
// =============================================================================

export interface FakeWorldState {
	files: Map<string, string>;
	testPassing: boolean;
	buildPassing: boolean;
	readCalls: number;
	writeCalls: number;
	executedTools: string[];
}

export interface FakeWorld {
	schema: ToolSchemaValidator;
	policy: ActionPolicyAdapter;
	executeTool: (action: ToolCallAction) => Promise<MissionEvidence>;
	verifyExecutor: VerificationExecutor;
	state: FakeWorldState;
	executionContext: Omit<ReliabilityExecutionContext, "executeTool">;
}

const KNOWN_TOOLS = new Set(["read", "edit", "write", "bash", "grep", "todo_write"]);

function validateArgs(
	tool: string,
	args: Record<string, unknown>,
): { ok: true; normalized: Record<string, unknown> } | { ok: false; message: string } {
	if (!KNOWN_TOOLS.has(tool)) {
		return { ok: false, message: `Tool ${tool} not found` };
	}
	const required = tool === "bash" ? "command" : tool === "todo_write" ? null : "path";
	if (required && typeof args[required] !== "string") {
		return { ok: false, message: `Missing required argument: ${required}` };
	}
	return { ok: true, normalized: { ...args } };
}

export function createFakeWorld(
	initial: { files?: Record<string, string>; testPassing?: boolean; buildPassing?: boolean } = {},
): FakeWorld {
	const state: FakeWorldState = {
		files: new Map(Object.entries(initial.files ?? {})),
		testPassing: initial.testPassing ?? true,
		buildPassing: initial.buildPassing ?? true,
		readCalls: 0,
		writeCalls: 0,
		executedTools: [],
	};

	const schema: ToolSchemaValidator = {
		exists: (name) => KNOWN_TOOLS.has(name),
		validateArgs,
	};

	const policy: ActionPolicyAdapter = {
		forbiddenReason: () => undefined,
		boundaryViolationReason: (action) => {
			const p = action.arguments.path;
			if (typeof p === "string" && (p.startsWith("/") || p.includes(".."))) {
				return `path escapes workspace: ${p}`;
			}
			return undefined;
		},
		permissionViolationReason: () => undefined,
	};

	const executeTool = async (action: ToolCallAction): Promise<MissionEvidence> => {
		state.executedTools.push(action.tool);
		switch (action.tool) {
			case "read": {
				state.readCalls += 1;
				const path = String(action.arguments.path);
				const content = state.files.get(path);
				if (content === undefined) {
					return {
						id: `ev_${action.toolCallId}`,
						type: "tool_result",
						source: "fake-runtime",
						summary: `read ${path}: not found`,
						success: false,
						timestamp: new Date().toISOString(),
						data: { path },
					};
				}
				return {
					id: `ev_${action.toolCallId}`,
					type: "tool_result",
					source: "fake-runtime",
					summary: `read ${path}`,
					success: true,
					timestamp: new Date().toISOString(),
					data: { path, content },
				};
			}
			case "edit":
			case "write": {
				state.writeCalls += 1;
				const path = String(action.arguments.path);
				const content =
					action.tool === "write"
						? String(action.arguments.content ?? "")
						: String(action.arguments.newText ?? "");
				state.files.set(path, content);
				return {
					id: `ev_${action.toolCallId}`,
					type: "tool_result",
					source: "fake-runtime",
					summary: `${action.tool} ${path}`,
					success: true,
					timestamp: new Date().toISOString(),
					data: { path },
				};
			}
			case "bash": {
				const command = String(action.arguments.command ?? "");
				if (command.includes("npm test") || command.includes("run tests")) {
					return {
						id: `ev_${action.toolCallId}`,
						type: "tool_result",
						source: "fake-runtime",
						summary: `${command} → exit ${state.testPassing ? 0 : 1}`,
						success: state.testPassing,
						timestamp: new Date().toISOString(),
						data: { command, exitCode: state.testPassing ? 0 : 1 },
					};
				}
				return {
					id: `ev_${action.toolCallId}`,
					type: "tool_result",
					source: "fake-runtime",
					summary: `${command} → exit 0`,
					success: true,
					timestamp: new Date().toISOString(),
					data: { command, exitCode: 0 },
				};
			}
			default:
				return {
					id: `ev_${action.toolCallId}`,
					type: "tool_result",
					source: "fake-runtime",
					summary: `${action.tool} executed`,
					success: true,
					timestamp: new Date().toISOString(),
					data: { tool: action.tool },
				};
		}
	};

	const verifyExecutor: VerificationExecutor = {
		runCommand: async (command) => {
			if (command.includes("npm test")) {
				return { exitCode: state.testPassing ? 0 : 1, stdout: state.testPassing ? "ok" : "1 failed", stderr: "" };
			}
			if (command.includes("build")) {
				return { exitCode: state.buildPassing ? 0 : 1, stdout: "", stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		},
		fileExists: async (p) => state.files.has(p),
		readFile: async (p) => state.files.get(p) ?? "",
		searchMatches: async (pattern) => {
			const matches: string[] = [];
			for (const [path, content] of state.files) {
				if (content.includes(pattern)) matches.push(path);
			}
			return matches;
		},
		gitChangedPaths: async () => Array.from(state.files.keys()),
	};

	return {
		schema,
		policy,
		executeTool,
		verifyExecutor,
		state,
		executionContext: { schema, policy },
	};
}
