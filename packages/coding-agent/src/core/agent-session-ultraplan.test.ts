import { Agent } from "@apholdings/jensen-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import type { ToolDefinition } from "./extensions/index.js";
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
		description: "Fake subagent tool for Ultraplan tests",
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

describe("AgentSession.runUltraplan()", () => {
	it("runs a local planner-backed pass, persists a structured artifact, and does not auto-execute", async () => {
		let capturedParams: { agent: string; task: string; agentScope?: string } | undefined;
		const session = createSession({
			customTools: [
				createSubagentTool((params) => {
					capturedParams = params;
					return JSON.stringify({
						objective: "Ship local-first Ultraplan",
						assumptions: ["Subagent planner is available locally"],
						constraints: ["Do not auto-execute the plan"],
						phases: [
							{ title: "Command entrypoint", steps: ["Add /ultraplan", "Wire it to AgentSession.runUltraplan"] },
						],
						risks: ["Planner output may be malformed JSON"],
						recommendedExecutionOrder: ["Plan", "Review", "Execute later"],
						actionableNextSteps: ["Review the stored plan", "Choose a first execution step"],
					});
				}),
			],
		});

		const result = await session.runUltraplan("Ship local-first Ultraplan");

		expect(capturedParams).toMatchObject({
			agent: "planner",
			agentScope: "user",
		});
		expect(capturedParams?.task).toContain("Objective: Ship local-first Ultraplan");
		expect(result.artifact.objective).toBe("Ship local-first Ultraplan");
		expect(result.artifact.phases).toEqual([
			{ title: "Command entrypoint", steps: ["Add /ultraplan", "Wire it to AgentSession.runUltraplan"] },
		]);
		expect(result.displayText).toContain("Execution: planning only; no execution has started");
		expect(result.displayText).toContain("Persisted as session-owned Ultraplan state on the current branch.");
		expect(session.getLatestUltraplanPlan()?.objective).toBe("Ship local-first Ultraplan");
		expect(session.getDelegatedWorkSummary().total).toBe(0);
		expect(session.state.messages).toHaveLength(0);
		expect(
			session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === SESSION_ULTRAPLAN_CUSTOM_TYPE),
		).toBe(true);
	});

	it("restores the persisted Ultraplan artifact from session-owned state", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		const writer = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() =>
					JSON.stringify({
						objective: "Restore persisted plan",
						assumptions: [],
						constraints: ["Persist on current branch"],
						phases: [{ title: "Persist", steps: ["Write structured artifact"] }],
						risks: [],
						recommendedExecutionOrder: ["Inspect", "Execute later"],
						actionableNextSteps: ["Show the stored plan"],
					}),
				),
			],
		});

		await writer.runUltraplan("Restore persisted plan");
		const restored = createSession({ sessionManager });

		expect(restored.getLatestUltraplanPlan()).toMatchObject({
			objective: "Restore persisted plan",
			executionState: "plan_only",
			plannerMode: "local_subagent",
		});
	});

	it("fails honestly when no local subagent tool is available", async () => {
		const session = createSession();

		await expect(session.runUltraplan("Plan without a planner tool")).rejects.toThrow(
			"Ultraplan requires the local subagent tool to be available.",
		);
	});
});

describe("AgentSession.runUltraplanRevise()", () => {
	it("uses latest artifact as context and passes revision instruction to planner", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		let capturedParams: { agent: string; task: string; agentScope?: string } | undefined;

		// Create initial plan
		const planner = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() =>
					JSON.stringify({
						objective: "Initial plan",
						assumptions: ["Assumption one"],
						constraints: [],
						phases: [{ title: "Phase 1", steps: ["Step A", "Step B"] }],
						risks: [],
						recommendedExecutionOrder: [],
						actionableNextSteps: ["Step A", "Step B"],
					}),
				),
			],
		});

		await planner.runUltraplan("Initial plan");

		// Create session that will call revise
		const reviser = createSession({
			sessionManager,
			customTools: [
				createSubagentTool((params) => {
					capturedParams = params;
					return JSON.stringify({
						objective: "Revised plan",
						assumptions: ["Assumption one"],
						constraints: [],
						phases: [{ title: "Phase 1", steps: ["Step A", "Step B", "Step C"] }],
						risks: [],
						recommendedExecutionOrder: [],
						actionableNextSteps: ["Step A", "Step B", "Step C"],
					});
				}),
			],
		});

		const result = await reviser.runUltraplanRevise("Add a third step to Phase 1");

		// Verify revision instruction was passed to planner
		expect(capturedParams).toMatchObject({
			agent: "planner",
			agentScope: "user",
		});
		expect(capturedParams?.task).toContain("Revision instruction: Add a third step to Phase 1");
		expect(capturedParams?.task).toContain('"objective": "Initial plan"');
		expect(capturedParams?.task).toContain("Phase 1");

		// Verify revised artifact
		expect(result.artifact.objective).toBe("Revised plan");
		expect(result.artifact.phases[0].steps).toContain("Step C");
		expect(result.displayText).toContain("Persisted as a new latest session-owned Ultraplan state");
		expect(result.displayText).toContain("Prior plan artifacts remain preserved separately");
		expect(result.displayText).toContain("Apply remains manual; no execution has started");
	});

	it("persists revised plan as new latest, preserving append-only semantics", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");

		const planner = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() =>
					JSON.stringify({
						objective: "Original plan",
						assumptions: [],
						constraints: [],
						phases: [{ title: "Phase", steps: ["Original step"] }],
						risks: [],
						recommendedExecutionOrder: [],
						actionableNextSteps: ["Original step"],
					}),
				),
			],
		});

		await planner.runUltraplan("Original plan");

		const reviser = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() =>
					JSON.stringify({
						objective: "Revised plan",
						assumptions: [],
						constraints: [],
						phases: [{ title: "Phase", steps: ["Revised step"] }],
						risks: [],
						recommendedExecutionOrder: [],
						actionableNextSteps: ["Revised step"],
					}),
				),
			],
		});

		await reviser.runUltraplanRevise("Update the step");

		// Verify new latest is the revised plan
		const latest = reviser.getLatestUltraplanPlan();
		expect(latest?.objective).toBe("Revised plan");

		// Verify branch still contains both plans (append-only)
		const branch = sessionManager.getBranch();
		const ultraplanEntries = branch.filter(
			(entry) => entry.type === "custom" && entry.customType === SESSION_ULTRAPLAN_CUSTOM_TYPE,
		);
		expect(ultraplanEntries).toHaveLength(2);
	});

	it("does not auto-apply or auto-execute when revising", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");

		const planner = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() =>
					JSON.stringify({
						objective: "Plan for apply test",
						assumptions: [],
						constraints: [],
						phases: [{ title: "Phase", steps: ["Actionable step"] }],
						risks: [],
						recommendedExecutionOrder: [],
						actionableNextSteps: ["Actionable step"],
					}),
				),
			],
		});

		await planner.runUltraplan("Plan for apply test");

		const reviser = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() =>
					JSON.stringify({
						objective: "Revised plan",
						assumptions: [],
						constraints: [],
						phases: [{ title: "Phase", steps: ["Revised step"] }],
						risks: [],
						recommendedExecutionOrder: [],
						actionableNextSteps: ["Revised step"],
					}),
				),
			],
		});

		await reviser.runUltraplanRevise("Revise it");

		// Verify no auto-apply: todos should be empty after revision
		expect(reviser.getTodos()).toHaveLength(0);
		expect(reviser.getDelegatedWorkSummary().total).toBe(0);
		expect(reviser.state.messages).toHaveLength(0);

		// Verify apply is still separate/manual
		const applyResult = reviser.applyUltraplan();
		expect(applyResult.applied).toHaveLength(1);
		expect(applyResult.displayText).toContain("Apply did not start execution");
	});

	it("fails honestly when no existing plan to revise", async () => {
		const session = createSession({
			customTools: [createSubagentTool(() => JSON.stringify({}))],
		});

		await expect(session.runUltraplanRevise("Try to revise without a plan")).rejects.toThrow(
			"No persisted Ultraplan plan found. Run /ultraplan <objective> first.",
		);
	});

	it("fails honestly with empty revision instruction", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");

		const planner = createSession({
			sessionManager,
			customTools: [
				createSubagentTool(() =>
					JSON.stringify({
						objective: "Existing plan",
						assumptions: [],
						constraints: [],
						phases: [{ title: "Phase", steps: ["Step"] }],
						risks: [],
						recommendedExecutionOrder: [],
						actionableNextSteps: ["Step"],
					}),
				),
			],
		});

		await planner.runUltraplan("Existing plan");

		const reviser = createSession({
			sessionManager,
			customTools: [createSubagentTool(() => JSON.stringify({}))],
		});

		await expect(reviser.runUltraplanRevise("   ")).rejects.toThrow(
			"Ultraplan revision requires a non-empty instruction.",
		);
	});
});
