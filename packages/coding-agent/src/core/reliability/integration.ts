/**
 * Reliability Session Bridge — adapters that connect the Reliability Kernel to
 * a live agent session's tool hooks.
 *
 * The bridge is provider-independent and side-effect free until attached. It
 * provides:
 *
 *   - createToolSchemaValidator(): adapts real AgentTool[] to the kernel's
 *     ToolSchemaValidator (schema enforcement via validateToolArguments).
 *   - createActionPolicyAdapter(): adapts a workspace root + forbidden-action
 *     set to the kernel's ActionPolicyAdapter (boundary + denylist checks).
 *   - ReliabilitySessionBridge: wraps beforeToolCall/afterToolCall/agentEnd so
 *     a session gains action validation, evidence recording, and a completion
 *     gate without a separate agent implementation.
 */

import type { AgentTool } from "@apholdings/jensen-agent-core";
import { validateToolArguments } from "@apholdings/jensen-ai";
import { decodeAction } from "./action-decoder.js";
import { type ActionPolicyAdapter, type ToolSchemaValidator, validateToolCallAction } from "./action-validator.js";
import type { MissionRuntime } from "./mission-runtime.js";
import type { MissionEvidence, ToolCallAction } from "./types.js";

export function createToolSchemaValidator(tools: readonly AgentTool[]): ToolSchemaValidator {
	return {
		exists(name: string): boolean {
			return tools.some((t) => t.name === name);
		},
		validateArgs(name: string, args: Record<string, unknown>) {
			const tool = tools.find((t) => t.name === name);
			if (!tool) {
				return { ok: false as const, message: `Tool ${name} not found` };
			}
			try {
				const normalized = validateToolArguments(tool, {
					name,
					arguments: args as Record<string, unknown>,
					toolCallId: `validate_${name}`,
				} as never) as Record<string, unknown>;
				return { ok: true as const, normalized };
			} catch (error) {
				return {
					ok: false as const,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}

export interface ActionPolicyAdapterOptions {
	workspaceRoot?: string;
	/** Tool names that are forbidden for this mission. */
	forbiddenTools?: readonly string[];
	/** When true, tools that write the workspace are blocked. */
	readOnly?: boolean;
}

/**
 * Lexical boundary/denylist policy. The full realpath boundary is enforced by
 * the tool executor itself; this adapter rejects obviously-escaping absolute
 * paths and `..` segments deterministically before execution.
 */
export function createActionPolicyAdapter(options: ActionPolicyAdapterOptions = {}): ActionPolicyAdapter {
	const forbidden = new Set(options.forbiddenTools ?? []);
	const root = options.workspaceRoot;

	const pathArg = (action: ToolCallAction): string | undefined => {
		const args = action.arguments;
		const candidate = args?.path ?? args?.file ?? args?.filePath ?? args?.target;
		return typeof candidate === "string" ? candidate : undefined;
	};

	return {
		forbiddenReason(action): string | undefined {
			if (forbidden.has(action.tool)) {
				return `tool '${action.tool}' is forbidden for this mission`;
			}
			return undefined;
		},
		boundaryViolationReason(action): string | undefined {
			if (!root) return undefined;
			const p = pathArg(action);
			if (!p) return undefined;
			if (p.includes("\u0000")) return "path contains NUL byte";
			const segments = p.split(/[\\/]+/);
			if (segments.includes("..")) return "path contains a parent-directory segment";
			if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
				return "absolute paths are not allowed within the mission boundary";
			}
			return undefined;
		},
		permissionViolationReason(action): string | undefined {
			if (!options.readOnly) return undefined;
			const mutating =
				action.tool === "edit" || action.tool === "write" || action.tool === "bash" || action.tool === "powershell";
			if (mutating) return "read-only mission cannot run mutating tools";
			return undefined;
		},
	};
}

export interface ReliabilityBridgeHooks {
	/** Called with observed tool evidence after a validated execution. */
	onToolExecuted?(evidence: MissionEvidence): void;
	/** Called when the agent ends a turn (implicit or explicit final candidate). */
	onAgentEnd?(): void;
}

/**
 * Bridge between a live agent session and the Reliability Kernel.
 *
 * beforeToolCall decodes + validates the model's raw tool call and blocks
 * invalid actions. afterToolCall records observed evidence. agentEnd proposes a
 * final candidate and runs the completion gate.
 */
export class ReliabilitySessionBridge {
	constructor(
		readonly runtime: MissionRuntime,
		private readonly schema: ToolSchemaValidator,
		private readonly policy: ActionPolicyAdapter,
	) {}

	/** beforeToolCall handler — block invalid tool calls before execution. */
	async beforeToolCall(toolCall: ToolCallAction): Promise<{ block: boolean; reason?: string }> {
		const decoded = decodeAction({
			type: "tool_call",
			tool: toolCall.tool,
			toolCallId: toolCall.toolCallId,
			arguments: toolCall.arguments,
		});
		if (!decoded.ok) {
			return { block: true, reason: decoded.failure.message };
		}
		const action = decoded.action;
		if (action.type !== "tool_call") {
			return { block: true, reason: `expected tool_call, got ${action.type}` };
		}
		const result = validateToolCallAction(action, { schema: this.schema, policy: this.policy });
		if (!result.ok) {
			this.runtime.recorder.record("action_validation_failure", {
				tool: action.tool,
				category: result.failure.category,
			});
			return { block: true, reason: result.failure.message };
		}
		return { block: false };
	}

	/** afterToolCall handler — record observed tool outcome as evidence. */
	afterToolCall(toolCall: ToolCallAction, isError: boolean, summary?: string): void {
		this.runtime.recordToolEvidence({
			id: `tool_${toolCall.toolCallId}`,
			type: "tool_result",
			source: "runtime",
			summary: summary ?? `${toolCall.tool} ${isError ? "failed" : "executed"}`,
			success: !isError,
			timestamp: new Date().toISOString(),
			data: { tool: toolCall.tool },
		});
		this.runtime.recorder.record(isError ? "tool_failed" : "tool_executed", { tool: toolCall.tool });
	}

	/** agentEnd handler — propose a final candidate and run the completion gate. */
	onAgentEnd(): ReturnType<MissionRuntime["proposeFinalCandidate"]> {
		return this.runtime.proposeFinalCandidate();
	}
}
