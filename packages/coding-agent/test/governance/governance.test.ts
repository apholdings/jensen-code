import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createGovernanceLedger,
	DEFAULT_GOVERNANCE_POLICY,
	effectiveBudget,
	evaluateGovernance,
	FileGovernanceStore,
	type GovernanceContext,
	type GovernancePolicy,
	GovernanceService,
	governancePolicyFromEnv,
	recordGovernanceDecision,
	recordGovernanceEscalation,
	recordGovernanceRetry,
	resolveGovernanceModel,
	validateGovernanceLedger,
} from "../../src/core/governance/index.js";

const repoRoot = join(fileURLToPath(new URL("../../../..", import.meta.url)));
const tsxCli = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
const raceFixture = fileURLToPath(new URL("./multiprocess-governance-client.ts", import.meta.url));
const usage = () => ({
	turns: 0,
	contextTokens: 0,
	generatedTokens: 0,
	toolCalls: 0,
	retries: 0,
	wallClockMs: 0,
	inferenceRequests: 0,
	children: 0,
	logicalAgents: 0,
	totalRetries: 0,
	replans: 0,
	fanOut: 0,
	depth: 0,
	readyChildren: 0,
	cloudSpendUsd: 0,
	modelEscalations: 0,
});
const retries = () => ({
	tool: 0,
	output_contract: 0,
	execution: 0,
	planner: 0,
	replan: 0,
	remote_execution: 0,
	provider: 0,
});
function context(overrides: Partial<GovernanceContext> = {}): GovernanceContext {
	return {
		missionId: "mission-1",
		scope: "child",
		provider: "llamacpp-qwen38-bucephalus",
		model: "qwen3.8-27b",
		usage: usage(),
		retries: retries(),
		cost: { status: "NONE", knownUsd: 0, unknownPaidEvents: 0, localInferenceRequests: 0 },
		wallClockNowMs: 100,
		wallClockStartedAtMs: 0,
		...overrides,
	};
}
function policy(overrides: Partial<GovernancePolicy> = {}): GovernancePolicy {
	return { ...DEFAULT_GOVERNANCE_POLICY, ...overrides };
}
describe("Governance evaluator", () => {
	it("enforces hard child budget and preserves soft behavior", () => {
		expect(
			evaluateGovernance(context({ usage: { ...usage(), turns: 8 } }), policy({ child: { maxTurns: 10 } })).action,
		).toBe("CONTINUE");
		const result = evaluateGovernance(
			context({ usage: { ...usage(), turns: 10 } }),
			policy({ child: { maxTurns: 10 } }),
		);
		expect(result.action).toBe("TERMINATE_CHILD");
		expect(result.status).toBe("LIMIT_REACHED");
	});
	it("applies operator precedence and denies excessive fanout", () => {
		expect(
			effectiveBudget(
				policy({ operator: { maxFanOut: 2 }, orchestration: { maxFanOut: 8 }, child: { maxFanOut: 4 } }),
			).maxFanOut,
		).toBe(2);
		expect(evaluateGovernance(context({ requestedChildren: 3 }), policy({ operator: { maxFanOut: 2 } })).action).toBe(
			"REQUEST_REPLAN",
		);
	});
	it("parks resource and dependency wait", () => {
		expect(evaluateGovernance(context({ resourceWait: true }), policy()).action).toBe("PARK");
		expect(evaluateGovernance(context({ dependencyBlocked: true }), policy()).action).toBe("PARK");
	});
	it("bounds empty-output recovery separately", () => {
		const p = policy({ stagnation: { maxNoProgressTurns: 10, maxRepeatedFailure: 3, maxOutputContractRetries: 1 } });
		expect(evaluateGovernance(context({ outputContractMissing: true }), p).action).toBe("RETRY_OUTPUT_CONTRACT");
		expect(
			evaluateGovernance(context({ outputContractMissing: true, retries: { ...retries(), output_contract: 1 } }), p)
				.action,
		).toBe("TERMINATE_CHILD");
	});
	it("selectively escalates local work under wall-clock pressure", () => {
		const result = evaluateGovernance(
			context({
				wallClockNowMs: 900,
				progress: { state: "ACTIVE_PROGRESS", noProgressTurns: 0, repeatedFailureCount: 0 },
			}),
			policy({
				child: { maxWallClockMs: 1000 },
				cloudEscalation: { provider: "openrouter", model: "openai/gpt-5.6-luna" },
			}),
		);
		expect(result.action).toBe("ESCALATE_MODEL");
		expect(result.to).toEqual({ provider: "openrouter", model: "openai/gpt-5.6-luna" });
		expect(result.preserveIdentity).toBe(true);
	});
	it("blocks prohibited cloud and unknown paid cost", () => {
		expect(
			evaluateGovernance(
				context({ provider: "openrouter", model: "openai/gpt-5.6-luna", isPaidInference: true }),
				policy({ cloudAllowed: false }),
			).action,
		).toBe("DENY_INFERENCE");
		const result = evaluateGovernance(
			context({
				provider: "openrouter",
				model: "openai/gpt-5.6-luna",
				isPaidInference: true,
				cost: { status: "UNKNOWN", knownUsd: 0, unknownPaidEvents: 1, localInferenceRequests: 0 },
			}),
			policy({ operator: { maxCloudSpendUsd: 1 } }),
		);
		expect(result.reason).toBe("UNKNOWN_CLOUD_COST");
	});
	it("does not classify resource wait as stagnation", () => {
		expect(
			evaluateGovernance(
				context({
					resourceWait: true,
					progress: { state: "RESOURCE_WAIT", noProgressTurns: 100, repeatedFailureCount: 100 },
				}),
				policy(),
			).action,
		).toBe("PARK");
	});
	it("recognizes local Qwen and configured Luna", () => {
		expect(
			resolveGovernanceModel(policy({ cloudEscalation: { provider: "openrouter", model: "openai/gpt-5.6-luna" } }))
				.selected,
		).toEqual({ provider: "llamacpp-qwen38-bucephalus", model: "qwen3.8-27b" });
		expect(
			resolveGovernanceModel(policy({ modelMode: "cloud_prohibited" }), {
				provider: "openrouter",
				model: "openai/gpt-5.6-luna",
			}).selected,
		).toEqual({ provider: "llamacpp-qwen38-bucephalus", model: "qwen3.8-27b" });
		const env = governancePolicyFromEnv({
			JENSEN_GOVERNANCE_CLOUD_PROVIDER: "openrouter",
			JENSEN_GOVERNANCE_CLOUD_MODEL: "openai/gpt-5.6-luna",
			JENSEN_GOVERNANCE_CLOUD_ALLOWED: "0",
		});
		expect(env.cloudAllowed).toBe(false);
	});
});
describe("durable Governance ledger", () => {
	it("is idempotent across reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-governance-"));
		try {
			const store = new FileGovernanceStore({ root });
			await store.create(createGovernanceLedger("mission-1"));
			const service = new GovernanceService({ store, policy: policy({ operator: { maxTurns: 1 } }) });
			await service.consume("mission-1", {
				eventId: "turn-1",
				scope: "child",
				resource: "turns",
				amount: 1,
				atMs: 1,
			});
			const duplicate = await service.consume("mission-1", {
				eventId: "turn-1",
				scope: "child",
				resource: "turns",
				amount: 1,
				atMs: 2,
			});
			expect(duplicate.reason).toBe("TURNS_HARD_LIMIT");
			const loaded = await store.load("mission-1");
			expect(loaded.status === "ok" && loaded.ledger.usage.turns).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("keeps retry classes separate and durably records decisions and escalations", async () => {
		let ledger = createGovernanceLedger("mission-1");
		ledger = recordGovernanceRetry(ledger, "tool-1", "tool", 1);
		ledger = recordGovernanceRetry(ledger, "contract-1", "output_contract", 2);
		const decision = evaluateGovernance(context(), policy());
		ledger = recordGovernanceDecision(ledger, "decision-1", decision);
		ledger = recordGovernanceEscalation(ledger, "escalation-1", {
			escalationId: "escalation-1",
			from: { provider: "local", model: "qwen" },
			to: { provider: "openrouter", model: "openai/gpt-5.6-luna" },
			reason: "STAGNATION",
			missionId: "mission-1",
			atMs: 3,
		});
		expect(ledger.retries.tool).toBe(1);
		expect(ledger.retries.output_contract).toBe(1);
		expect(ledger.usage.totalRetries).toBe(2);
		expect(ledger.decisionHistory).toEqual([decision]);
		expect(ledger.lastDecision).toEqual(decision);
		expect(ledger.escalationHistory).toHaveLength(1);
		const root = await mkdtemp(join(tmpdir(), "jensen-governance-history-"));
		try {
			const service = new GovernanceService({ store: new FileGovernanceStore({ root }), policy: policy() });
			await service.ensureMission("service-mission");
			await service.recordDecision("service-mission", "decision-1", decision);
			await service.recordEscalation("service-mission", "escalation-1", {
				escalationId: "escalation-1",
				from: { provider: "local", model: "qwen" },
				to: { provider: "openrouter", model: "openai/gpt-5.6-luna" },
				reason: "STAGNATION",
				missionId: "service-mission",
				atMs: 3,
			});
			const loaded = await service.store.load("service-mission");
			expect(loaded.status === "ok" && loaded.ledger.decisionHistory).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("rejects malformed nested history and allows only valid ledger shapes", () => {
		const ledger = createGovernanceLedger("mission-1");
		const malformed = { ...ledger, decisionHistory: [{ action: "CONTINUE" }] };
		expect(validateGovernanceLedger(malformed, "mission-1")).toEqual({
			valid: false,
			diagnostic: "invalid decision history entry",
		});
		expect(validateGovernanceLedger(ledger, "mission-1").valid).toBe(true);
	});
	it("rejects unsafe IDs, invalid count amounts, local monetary cost, and fractional cost double-accounting", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-governance-validation-"));
		try {
			const service = new GovernanceService({
				store: new FileGovernanceStore({ root }),
				policy: policy({ operator: { maxCloudSpendUsd: 1 } }),
			});
			await expect(service.ensureMission("../escape")).rejects.toThrow("UNSAFE_GOVERNANCE_MISSION_ID");
			const invalid = await service.consume("mission-1", {
				eventId: "bad",
				scope: "child",
				resource: "turns",
				amount: 0,
				atMs: 1,
			});
			expect(invalid.allowed).toBe(false);
			await expect(
				service.recordInferenceResult({
					missionId: "mission-1",
					eventId: "local",
					provider: "llamacpp-qwen38-bucephalus",
					model: "qwen3.8-27b",
					costUsd: 0.1,
					atMs: 1,
				}),
			).rejects.toThrow("LOCAL_COST_MUST_BE_NONE");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("permits exactly one process to consume the last hard-budget unit", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-governance-race-"));
		try {
			const run = () =>
				new Promise<{ allowed: boolean }>((resolve, reject) => {
					const child = spawn(process.execPath, [tsxCli, raceFixture, root], {
						cwd: repoRoot,
						stdio: ["ignore", "pipe", "pipe"],
					});
					let output = "";
					let error = "";
					child.stdout.on("data", (chunk: Buffer) => {
						output += chunk.toString();
					});
					child.stderr.on("data", (chunk: Buffer) => {
						error += chunk.toString();
					});
					child.on("error", reject);
					child.on("exit", (code) => {
						if (code !== 0) reject(new Error(error));
						else resolve(JSON.parse(output.trim()) as { allowed: boolean });
					});
				});
			const results = await Promise.all([run(), run()]);
			expect(results.filter((result) => result.allowed)).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
