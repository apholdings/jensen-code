import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { MemoryItem } from "../memory.js";

const memoryWriteSchema = Type.Object({
	action: Type.Union([Type.Literal("set"), Type.Literal("clear")], {
		description: "Whether to set a memory item or clear all session memory",
	}),
	key: Type.Optional(Type.String({ description: "Memory key, such as constraints.test_command" })),
	value: Type.Optional(Type.String({ description: "Memory value to retain across compaction" })),
});

export type MemoryWriteInput = Static<typeof memoryWriteSchema>;

export interface MemoryWriteOperations {
	set: (key: string, value: string) => MemoryItem[];
	clear: () => MemoryItem[];
}

export function createMemoryWriteTool(operations: MemoryWriteOperations): AgentTool<typeof memoryWriteSchema> {
	return {
		name: "memory_write",
		label: "memory_write",
		description:
			"Record or clear structured session memory that should survive compaction. Use for stable facts, constraints, and decisions that matter on future turns.",
		parameters: memoryWriteSchema,
		execute: async (_toolCallId: string, input: MemoryWriteInput) => {
			if (input.action === "clear") {
				const items = operations.clear();
				return {
					content: [{ type: "text", text: `Cleared session memory (${items.length} items remain)` }],
					details: { items },
				};
			}

			const key = input.key?.trim();
			const value = input.value?.trim();
			if (!key) {
				return {
					content: [{ type: "text", text: "Error: key is required when action=set" }],
					details: undefined,
				};
			}
			if (!value) {
				return {
					content: [{ type: "text", text: "Error: value is required when action=set" }],
					details: undefined,
				};
			}

			const items = operations.set(key, value);
			return {
				content: [{ type: "text", text: `Stored memory: ${key}` }],
				details: { items },
			};
		},
	};
}

export const memoryWriteTool: AgentTool<typeof memoryWriteSchema> = createMemoryWriteTool({
	set: () => [],
	clear: () => [],
});
