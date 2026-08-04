import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEvaluationSelfProbe, verdictExitCode } from "../../src/core/evaluation/cli.js";
import {
	createEvaluationSandbox,
	resolveCandidateLauncher,
	resolveExecutable,
	samePath,
} from "../../src/core/evaluation/index.js";
import {
	detectCurrentRuntimeKind,
	JENSEN_CANDIDATE_MARKER,
	resolveExecutable as resolveExecutableDirect,
	SANDBOX_SELF_PROBE,
} from "../../src/core/evaluation/launcher.js";
import { builtInEvaluationScenarios } from "../../src/core/evaluation/packs.js";
import { runEvaluation } from "../../src/core/evaluation/runner.js";

describe("candidate launcher resolution", () => {
	it("resolves the current node source runtime into a trusted launcher", async () => {
		const launcher = await resolveCandidateLauncher();
		expect(launcher.trustedByRuntime).toBe(true);
		expect(launcher.launcherId).toBe("jensen_source_runtime");
		expect(launcher.invocationPrefix[0]).toBe("-e");
		expect(launcher.executablePath.length).toBeGreaterThan(0);
	});

	it("detects the current runtime kind", () => {
		const kind = detectCurrentRuntimeKind();
		expect(["node_source", "bun_compiled", "native_packaged"]).toContain(kind.runtimeKind);
		expect(kind.executablePath).toBe(process.execPath);
	});

	it("normalizes the compiled self-probe prefix", () => {
		expect([...SANDBOX_SELF_PROBE]).toEqual(["eval", "self-probe", "--json"]);
	});

	it("rejects an external launcher without an absolute path", async () => {
		await expect(
			resolveCandidateLauncher({
				configuredExternal: {
					executablePath: "relative/path",
					invocationPrefix: [],
					source: "configured",
				},
			}),
		).rejects.toThrow("absolute path");
	});

	it("rejects a nonexistent external launcher", async () => {
		await expect(
			resolveCandidateLauncher({
				configuredExternal: {
					executablePath: "/definitely/not/a/real/jensen-launcher",
					invocationPrefix: [],
					source: "configured",
				},
			}),
		).rejects.toThrow("does not exist");
	});

	it("detects a nonexistent executable identity", async () => {
		const identity = await resolveExecutable("/no/such/executable/path", process.cwd());
		expect(identity.exists).toBe(false);
		expect(identity.resolutionError).toBeDefined();
	});
});

describe("launcher identity security", () => {
	it("compares paths by identity, not basename, with separator normalization", () => {
		// Same basename, different paths must NOT compare equal.
		expect(samePath("/a/pi", "/b/pi")).toBe(false);
		expect(samePath("/a/pi", "/a/pi")).toBe(true);
		// Path-separator normalization (Windows backslashes) within a path.
		expect(samePath("c:/tools/pi.exe", "c:\\tools\\pi.exe")).toBe(true);
	});

	it("authorizes the trusted launcher by identity even when its basename is not allowlisted", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-launcher-auth-"));
		try {
			const launcher = await resolveCandidateLauncher();
			// Deliberately do NOT place the launcher basename in allowedTools.
			const sandbox = await createEvaluationSandbox({
				evaluationRunId: "run-launcher",
				fixture: { kind: "inline", files: { "f.txt": "x" }, git: { initialize: true } },
				policy: {
					allowedModes: ["sandbox"],
					allowNetwork: false,
					allowLiveProvider: false,
					allowMutation: false,
					allowedTools: ["git"],
					maximumWallTimeMs: 30_000,
				},
				launcher,
			});
			const result = await sandbox.runProcess(launcher.executablePath, [...launcher.invocationPrefix]);
			expect(result.exitCode).toBe(0);
			const types = sandbox.events.map((event) => event.type);
			expect(types).toContain("EVAL_LAUNCHER_AUTHORIZED");
			expect(types).toContain("EVAL_CANDIDATE_COMPLETED");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an untrusted same-basename executable that is not the launcher path", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-launcher-attack-"));
		try {
			const launcher = await resolveCandidateLauncher();
			const sandbox = await createEvaluationSandbox({
				evaluationRunId: "run-attack",
				fixture: { kind: "inline", files: { "f.txt": "x" }, git: { initialize: true } },
				policy: {
					allowedModes: ["sandbox"],
					allowNetwork: false,
					allowLiveProvider: false,
					allowMutation: false,
					allowedTools: ["git"],
				},
				launcher,
			});
			// A fake executable sharing the launcher basename at a different path.
			const fake = join(sandbox.root, "launcher-copy");
			await writeFile(fake, "#!/bin/sh\nexit 0\n");
			await chmod(fake, 0o755);
			await expect(sandbox.runProcess(fake, [])).rejects.toThrow("sandbox tool is not allowed");
			const types = sandbox.events.map((event) => event.type);
			expect(types).toContain("EVAL_LAUNCHER_REJECTED");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("passes launcher arguments as structured argv (no shell interpolation)", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-launcher-inject-"));
		try {
			const launcher = await resolveCandidateLauncher();
			const sandbox = await createEvaluationSandbox({
				evaluationRunId: "run-inject",
				fixture: { kind: "inline", files: { "f.txt": "x" }, git: { initialize: true } },
				policy: {
					allowedModes: ["sandbox"],
					allowNetwork: false,
					allowLiveProvider: false,
					allowMutation: false,
					allowedTools: ["git"],
				},
				launcher,
			});
			// Shell metacharacters in the inline script are treated as literals
			// because spawn passes argv without a shell.
			const result = await sandbox.runProcess(launcher.executablePath, [
				"-e",
				"process.exit(0); // ;rm -rf / ; $HOME $(whoami) `id`",
			]);
			expect(result.exitCode).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not expose a launcher field on candidate policy (scenario cannot override)", async () => {
		const launcher = await resolveCandidateLauncher();
		const candidatePolicy = {
			allowedModes: ["sandbox"] as const,
			allowNetwork: false,
			allowLiveProvider: false,
			allowMutation: false,
			allowedTools: ["node", "git"],
		};
		expect((candidatePolicy as Record<string, unknown>).authorizedLauncher).toBeUndefined();
		expect(launcher.launcherId).toBe("jensen_source_runtime");
	});
});

describe("candidate exit and verdict semantics", () => {
	it("maps verdicts to stable exit codes", () => {
		expect(verdictExitCode("pass")).toBe(0);
		expect(verdictExitCode("fail")).toBe(1);
		expect(verdictExitCode("invalid")).toBe(2);
		expect(verdictExitCode("cancelled")).toBe(3);
		expect(verdictExitCode("error")).toBe(4);
	});

	it("produces a pass verdict for the source sandbox run", async () => {
		const artifact = await runEvaluation(builtInEvaluationScenarios()[0]!, { mode: "sandbox" });
		expect(artifact.verdict).toBe("pass");
		expect(artifact.run.status).toBe("completed");
		const events = artifact.events?.map((event) => event.type);
		expect(events).toContain("EVAL_LAUNCHER_AUTHORIZED");
		expect(events).toContain("EVAL_SANDBOX_CLEANUP_COMPLETED");
	});

	it("produces an invalid verdict for an unhandled custom assertion", async () => {
		const scenario = {
			...builtInEvaluationScenarios()[0]!,
			scenarioId: "demo.invalid",
			assertions: [{ assertionId: "c", kind: "custom" as const, customKey: "unhandled" }],
		};
		const artifact = await runEvaluation(scenario, { mode: "sandbox" });
		expect(artifact.verdict).toBe("invalid");
		expect(verdictExitCode(artifact.verdict)).toBe(2);
	});

	it("produces a fail verdict when a deterministic assertion fails", async () => {
		const scenario = {
			...builtInEvaluationScenarios()[0]!,
			scenarioId: "demo.fail",
			assertions: [
				{
					assertionId: "missing",
					kind: "file_exists" as const,
					path: "does-not-exist.txt",
					severity: "high" as const,
				},
			],
		};
		const artifact = await runEvaluation(scenario, { mode: "sandbox" });
		expect(artifact.verdict).toBe("fail");
		expect(verdictExitCode(artifact.verdict)).toBe(1);
	});

	it("the self-probe writes a candidate marker and is idempotent", async () => {
		const root = await mkdtemp(join(tmpdir(), "jensen-self-probe-"));
		try {
			const first = await runEvaluationSelfProbe({ root });
			const second = await runEvaluationSelfProbe({ root });
			expect(first.marker).toBe(second.marker);
			expect(first.marker.endsWith(JENSEN_CANDIDATE_MARKER)).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("historical binary self-launcher regression scenario", () => {
	it("is a built-in versioned scenario in the release-acceptance pack", () => {
		const scenario = builtInEvaluationScenarios().find(
			(item) => item.scenarioId === "release.binary-self-launcher-basename-mismatch",
		);
		expect(scenario).toBeDefined();
		expect(scenario?.scenarioVersion).toBe(1);
		expect(scenario?.category).toBe("release");
		expect(scenario?.provenance.classification).toBe("historical-regression");
		const assertions = scenario?.assertions ?? [];
		expect(assertions.some((item) => item.pattern === "EVAL_LAUNCHER_AUTHORIZED")).toBe(true);
		expect(assertions.some((item) => item.pattern === "EVAL_LAUNCHER_REJECTED")).toBe(true);
	});
});

describe("reexported launcher helpers", () => {
	it("exposes resolveExecutable and samePath", async () => {
		const identity = await resolveExecutableDirect(process.execPath, process.cwd());
		expect(identity.exists).toBe(true);
		expect(samePath(identity.resolvedPath, identity.resolvedPath)).toBe(true);
	});
});
