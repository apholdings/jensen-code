import { Agent } from "@apholdings/jensen-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import type { ToolDefinition } from "./extensions/index.js";
import { SESSION_TODOS_CUSTOM_TYPE } from "./memory.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { SESSION_ULTRAPLAN_CUSTOM_TYPE } from "./ultraplan.js";

function createSession(options?: { sessionManager?: SessionManager; customTools?: ToolDefinition[] }): AgentSession {
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: "/tmp/project",
		agentDir: "/tmp/agent",
		settingsManager,
	});
	const authStorage = AuthStorage.create("/tmp/agent/auth.json");
	const modelRegistry = new ModelRegistry(authStorage);
	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			thinkingLevel: "off",
			tools: [],
		},
	});

	return new AgentSession({
		agent,
		sessionManager: options?.sessionManager ?? SessionManager.inMemory("/tmp/project"),
		settingsManager,
		cwd: "/tmp/project",
		resourceLoader,
		modelRegistry,
		customTools: options?.customTools,
	});
}

function createSubagentTool(
	handler: (params: { agent: string; task: string; agentScope?: string }) => string,
): ToolDefinition {
	return {
		name: "subagent",
		label: "subagent",
		description: "Fake subagent tool for Ultraplan apply tests",
		parameters: Type.Object({}),
		execute: async (_toolCallId, params) => {
			const typedParams = params as unknown as { agent: string; task: string; agentScope?: string };
			return {
				content: [{ type: "text", text: handler(typedParams) }],
				details: undefined,
			};
		},
	};
}

describe("AgentSession.applyUltraplan()", () => {
	it("applies the latest persisted plan artifact into persisted session todo state", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		const writer = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() =>
					JSON.stringify({
						objective: "Apply latest plan",
						assumptions: [],
						constraints: ["Do not auto-execute"],
						phases: [{ title: "Prepare", steps: ["Inspect the repo", "Write the todo state"] }],
						risks: [],
						recommendedExecutionOrder: ["Plan", "Apply", "Execute later"],
						actionableNextSteps: ["Inspect the repo", "Write the todo state"],
					}),
				),
			],
		});

		await writer.runUltraplan("Apply latest plan");

		const applier = createSession({ sessionManager });
		const result = applier.applyUltraplan();
		const reloaded = createSession({ sessionManager });

		expect(result.applied).toEqual([
			{ content: "Inspect the repo", activeForm: "Inspect the repo", status: "pending" },
			{ content: "Write the todo state", activeForm: "Write the todo state", status: "pending" },
		]);
		expect(reloaded.getTodos()).toEqual(result.applied);
		expect(result.displayText).toContain("Applied 2 Ultraplan step(s)");
		expect(result.displayText).toContain("session todo state");
		expect(result.displayText).toContain("Apply did not start execution");
	});

	it("uses the latest persisted Ultraplan artifact when multiple plans exist on the branch", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		const outputs = [
			JSON.stringify({
				objective: "Older plan",
				assumptions: [],
				constraints: [],
				phases: [{ title: "Old", steps: ["Use the outdated step"] }],
				risks: [],
				recommendedExecutionOrder: [],
				actionableNextSteps: ["Use the outdated step"],
			}),
			JSON.stringify({
				objective: "Latest plan",
				assumptions: [],
				constraints: [],
				phases: [{ title: "Latest", steps: ["Use the latest step"] }],
				risks: [],
				recommendedExecutionOrder: [],
				actionableNextSteps: ["Use the latest step"],
			}),
		];
		const writer = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() => {
					const output = outputs.shift();
					if (!output) {
						throw new Error("Unexpected extra planner call");
					}
					return output;
				}),
			],
		});

		await writer.runUltraplan("Older plan");
		await writer.runUltraplan("Latest plan");

		const applier = createSession({ sessionManager });
		const result = applier.applyUltraplan();

		expect(result.applied).toEqual([
			{ content: "Use the latest step", activeForm: "Use the latest step", status: "pending" },
		]);
		expect(applier.getLatestUltraplanPlan()?.objective).toBe("Latest plan");
	});

	it("falls back to first-phase steps when actionable next steps are empty", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		const writer = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() =>
					JSON.stringify({
						objective: "Fallback plan",
						assumptions: [],
						constraints: [],
						phases: [{ title: "First phase", steps: ["Phase step one", "Phase step two"] }],
						risks: [],
						recommendedExecutionOrder: [],
						actionableNextSteps: [],
					}),
				),
			],
		});

		await writer.runUltraplan("Fallback plan");

		const applier = createSession({ sessionManager });
		const result = applier.applyUltraplan();

		expect(result.applied).toEqual([
			{ content: "Phase step one", activeForm: "Phase step one", status: "pending" },
			{ content: "Phase step two", activeForm: "Phase step two", status: "pending" },
		]);
		expect(result.displayText).toContain("Source: first phase steps");
	});

	it("preserves existing todo state, avoids duplicate todos, and keeps the plan artifact intact", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		sessionManager.appendCustomEntry(SESSION_TODOS_CUSTOM_TYPE, [
			{ content: "Existing task", activeForm: "Existing task", status: "in_progress" },
			{ content: "Shared step", activeForm: "Shared step", status: "completed" },
		]);
		const writer = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() =>
					JSON.stringify({
						objective: "Preserve state",
						assumptions: [],
						constraints: [],
						phases: [{ title: "Apply", steps: ["Shared step", "New step"] }],
						risks: [],
						recommendedExecutionOrder: [],
						actionableNextSteps: ["Shared step", "New step"],
					}),
				),
			],
		});

		await writer.runUltraplan("Preserve state");

		const applier = createSession({ sessionManager });
		const beforeApplyArtifact = applier.getLatestUltraplanPlan();
		const result = applier.applyUltraplan();
		const afterApplyArtifact = applier.getLatestUltraplanPlan();

		expect(result.applied).toEqual([{ content: "New step", activeForm: "New step", status: "pending" }]);
		expect(applier.getTodos()).toEqual([
			{ content: "Existing task", activeForm: "Existing task", status: "in_progress" },
			{ content: "Shared step", activeForm: "Shared step", status: "completed" },
			{ content: "New step", activeForm: "New step", status: "pending" },
		]);
		expect(afterApplyArtifact).toEqual(beforeApplyArtifact);
		expect(
			sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === SESSION_ULTRAPLAN_CUSTOM_TYPE),
		).toBe(true);
	});

	it("does not auto-execute or misrepresent delegated work as applied state", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		const writer = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() =>
					JSON.stringify({
						objective: "Apply only",
						assumptions: [],
						constraints: ["No execution"],
						phases: [{ title: "Plan", steps: ["Keep execution separate"] }],
						risks: [],
						recommendedExecutionOrder: [],
						actionableNextSteps: ["Keep execution separate"],
					}),
				),
			],
		});

		await writer.runUltraplan("Apply only");

		const applier = createSession({ sessionManager });
		const result = applier.applyUltraplan();

		expect(applier.getDelegatedWorkSummary().total).toBe(0);
		expect(applier.state.messages).toHaveLength(0);
		expect(result.displayText).not.toContain("running");
		expect(result.displayText).not.toContain("executing");
		expect(result.displayText).toContain("Apply did not start execution");
	});

	it("fails honestly when no persisted plan exists", () => {
		const session = createSession();

		expect(() => session.applyUltraplan()).toThrow(
			"No persisted Ultraplan plan found. Run /ultraplan <objective> first.",
		);
	});
});
