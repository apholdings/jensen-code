import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertSandboxPath,
	createDeterministicProvider,
	createDeterministicReviewer,
	createEvaluationSandbox,
	createPruneManifest,
	EvaluationRpcService,
	preflightLiveEvaluation,
	pruneEvaluationStore,
	runIndependentReviewer,
	verifyReleaseProvenance,
} from "../../src/core/evaluation/index.js";
import { builtInEvaluationScenarios } from "../../src/core/evaluation/packs.js";
import { runEvaluation } from "../../src/core/evaluation/runner.js";

describe("production evaluation runtime", () => {
	it("blocks sandbox path traversal and owns candidate process lifecycle", async () => {
		const sandbox = await createEvaluationSandbox({
			evaluationRunId: "run-sandbox",
			fixture: { kind: "inline", files: { "fixture.txt": "immutable\n" } },
			policy: {
				allowedModes: ["sandbox"],
				allowNetwork: false,
				allowLiveProvider: false,
				allowMutation: true,
				allowedTools: ["node"],
				maximumWallTimeMs: 5_000,
			},
		});
		try {
			expect(() => assertSandboxPath(sandbox.root, "../outside")).toThrow("escapes");
			const result = await sandbox.runProcess(process.execPath, ["-e", "process.stdout.write('ok')"]);
			expect(result.stdout).toBe("ok");
			expect(sandbox.events.map((event) => event.type)).toEqual(
				expect.arrayContaining(["EVAL_SANDBOX_ALLOCATED", "EVAL_SANDBOX_VERIFIED", "EVAL_CANDIDATE_COMPLETED"]),
			);
		} finally {
			await sandbox.cleanup();
		}
	});

	it("retains failed evidence as read-only and cleans normal sandboxes", async () => {
		const sandbox = await createEvaluationSandbox({
			evaluationRunId: "run-retained",
			fixture: { kind: "inline", files: { "fixture.txt": "retained\n" } },
			policy: {
				allowedModes: ["sandbox"],
				allowNetwork: false,
				allowLiveProvider: false,
				allowMutation: true,
				allowedTools: ["node"],
			},
		});
		const root = sandbox.root;
		await sandbox.retain();
		await sandbox.cleanup();
		await expect(writeFile(join(root, "fixture.txt"), "changed\n")).rejects.toBeDefined();
		await chmod(root, 0o755);
		await rm(root, { recursive: true, force: true });
	});

	it("requires explicit live confirmation and all live budgets", () => {
		const profile = {
			profileId: "openrouter",
			provider: "openrouter",
			configuredModel: "model",
			resolvedModel: "model",
			baseUrl: "https://example.invalid",
			apiKeyEnv: "OPENROUTER_API_KEY",
			apiKey: "synthetic",
		};
		expect(() =>
			preflightLiveEvaluation({
				profile,
				confirmed: false,
				budget: { maximumCostUsd: 1, maximumModelCalls: 1, maximumWallTimeMs: 1000 },
			}),
		).toThrow("confirmation");
		expect(() => preflightLiveEvaluation({ profile, confirmed: true, budget: { maximumCostUsd: 1 } })).toThrow(
			"model calls",
		);
	});

	it("runs an independent reviewer against a bounded evidence packet", async () => {
		const artifact = await runEvaluation(builtInEvaluationScenarios()[0]!, {
			mode: "fixture",
			executor: {
				execute: async () => ({
					events: [
						{
							eventId: "e",
							type: "tool.failure",
							timestamp: new Date().toISOString(),
							details: { status: "pass" },
						},
					],
				}),
			},
		});
		const result = await runIndependentReviewer({
			artifact,
			reviewer: createDeterministicReviewer(),
			reviewerDefinition: "fixture-reviewer",
			rubricId: "core",
			rubricVersion: 1,
		});
		expect(result.assignment.candidateEvaluationRunId).toBe(artifact.run.evaluationRunId);
		expect(result.semanticResult.candidateIdentityHidden).toBe(true);
		expect(result.semanticResult.toolExecutionAllowed).toBe(false);
	});

	it("serves evaluation RPC operations with durable artifact IDs", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-eval-rpc-"));
		try {
			const service = new EvaluationRpcService({ root });
			const response = await service.handle({ version: 2, requestId: "packs", operation: "eval.packs" });
			expect(response.error).toBeUndefined();
			expect(Array.isArray(response.data)).toBe(true);
			const run = await service.handle({
				version: 2,
				requestId: "run",
				operation: "eval.run",
				parameters: { target: "core-runtime.tool-failure-recovery", mode: "fixture" },
			});
			expect(run.error).toBeUndefined();
			expect(typeof (run.data as { artifactId: string }).artifactId).toBe("string");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("prunes only temporary evidence and preserves baselines", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-eval-prune-"));
		try {
			await mkdir(join(root, "temporary", "sandbox"), { recursive: true });
			await writeFile(join(root, "temporary", "sandbox", "log.txt"), "temporary");
			const preview = await createPruneManifest(root);
			expect(preview.entries.some((entry) => entry.artifactId === "temporary/sandbox")).toBe(true);
			const result = await pruneEvaluationStore(root, true, undefined, preview);
			expect(result.mutationCount).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("verifies one release commit across all provenance surfaces", () => {
		const result = verifyReleaseProvenance({
			releaseCommit: "abc",
			versionCommit: "abc",
			tagCommit: "abc",
			githubReleaseCommit: "abc",
			binaryManifestCommit: "abc",
			embeddedBinaryCommits: ["abc"],
		});
		expect(result.valid).toBe(true);
		expect(
			verifyReleaseProvenance({
				...result,
				releaseCommit: "abc",
				versionCommit: "def",
				tagCommit: "abc",
				githubReleaseCommit: "abc",
				binaryManifestCommit: "abc",
			}).valid,
		).toBe(false);
	});

	it("keeps fake providers deterministic without live network calls", async () => {
		const provider = createDeterministicProvider();
		const first = await provider.complete({ prompt: "test", model: "fixture" });
		const second = await provider.complete({ prompt: "test", model: "fixture" });
		expect(second).toEqual(first);
	});
});
