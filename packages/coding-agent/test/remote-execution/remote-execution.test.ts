/**
 * Remote Execution Foundation — deterministic tests (2.14.0).
 *
 * Covers the transport-independent core with a fake transport/runner. Real SSH
 * + Blackpearl + Qwen are covered by the separate real QA. Local execution
 * regression is covered by the existing Worker/Assignment/Mission suites.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createMissionRequest, type MissionRequest } from "../../src/core/mission-domain/mission-request.js";
import { createFileRemoteTargetRegistry } from "../../src/core/remote-execution/file-remote-target-registry.js";
import { RemoteExecutionError } from "../../src/core/remote-execution/remote-execution-error.js";
import { RemoteMissionExecutor } from "../../src/core/remote-execution/remote-mission-executor.js";
import { parseRemoteFrame, serializeRemoteFrame } from "../../src/core/remote-execution/remote-protocol.js";
import { RemoteTargetRegistry } from "../../src/core/remote-execution/remote-target-registry.js";
import {
	parseRemoteExecutionTarget,
	type RemoteExecutionTarget,
	type RemoteTargetHealth,
} from "../../src/core/remote-execution/remote-target-types.js";
import type {
	RemoteCommandRunner,
	RemoteExecutionHandle,
	RemoteExecutionTransport,
	RemoteLaunchSpec,
	RemoteTransportOutcome,
} from "../../src/core/remote-execution/remote-transport.js";
import { buildRemoteAcceptanceCriteriaVerifier } from "../../src/core/remote-execution/remote-verification.js";
import { encodePowerShellCommand } from "../../src/core/remote-execution/ssh-transport.js";

// =============================================================================
// Fixtures
// =============================================================================

const TARGET: RemoteExecutionTarget = {
	targetId: "blackpearl",
	transport: "ssh",
	host: "blackpearl",
	user: "sparrow",
	platform: "windows",
	arch: "x64",
	connection: { remoteTempRoot: "C:\\Users\\sparrow\\AppData\\Local\\Temp" },
};

function request(overrides: Partial<Parameters<typeof createMissionRequest>[0]> = {}): MissionRequest {
	return createMissionRequest({
		missionId: overrides.missionId ?? `mission_test_${Math.random().toString(36).slice(2)}`,
		objective: overrides.objective ?? "fix the bug",
		agent: overrides.agent ?? "worker",
		executionMode: overrides.executionMode ?? "execute",
		acceptanceCriteria: overrides.acceptanceCriteria ?? [
			{ id: "test", description: "test passes", verification: { kind: "test", command: "node test.js" } },
		],
		workspaceScope: overrides.workspaceScope ?? { cwd: "/tmp/ws" },
		modelPolicy: overrides.modelPolicy ?? { provider: "llamacpp-qwen38-bucephalus", model: "qwen3.8-27b" },
		childSessionId: overrides.childSessionId ?? "child_test",
	});
}

function fakeHandle(outcome: Partial<RemoteTransportOutcome> & { exitCode?: number | null }): RemoteExecutionHandle {
	const full: RemoteTransportOutcome = {
		exitCode: outcome.exitCode ?? 0,
		stdout: outcome.stdout ?? "",
		stderr: outcome.stderr ?? "",
		...outcome,
	};
	return {
		executionId: "exec_test",
		launchId: "launch_test",
		outcomePromise: Promise.resolve(full),
		cancel: async () => {},
	};
}

class FakeTransport implements RemoteExecutionTransport, RemoteCommandRunner {
	readonly transportId = "fake";
	launched: RemoteLaunchSpec[] = [];
	probeResult: RemoteTargetHealth = {
		targetId: "blackpearl",
		status: "reachable",
		summary: "ok",
		observedAtMs: 0,
	};
	launchImpl: (spec: RemoteLaunchSpec) => Promise<RemoteExecutionHandle> = async () => fakeHandle({ exitCode: 0 });
	commandResults = new Map<string, { exitCode: number | null; stdout: string; stderr: string }>();
	cancelCalls = 0;

	async probe(): Promise<RemoteTargetHealth> {
		return this.probeResult;
	}
	async launch(_target: RemoteExecutionTarget, spec: RemoteLaunchSpec): Promise<RemoteExecutionHandle> {
		this.launched.push(spec);
		return this.launchImpl(spec);
	}
	async runCommand(
		_target: RemoteExecutionTarget,
		command: string,
		_cwd: string,
	): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
		return this.commandResults.get(command) ?? { exitCode: 0, stdout: "True", stderr: "" };
	}
}

let transport: FakeTransport;

beforeEach(() => {
	transport = new FakeTransport();
});

function makeExecutor(
	overrides: Partial<ConstructorParameters<typeof RemoteMissionExecutor>[0]> = {},
): RemoteMissionExecutor {
	return new RemoteMissionExecutor({
		target: TARGET,
		transport,
		buildRemoteLaunch: ({ request: r, sessionDir }) => ({
			command: "node",
			args: ["cli.js", "--child-mission", r.missionId, "--session-dir", sessionDir],
			cwd: "",
			env: { JENSEN_CODE_CODING_AGENT_DIR: "agent" },
		}),
		modelsJson: '{"providers":{}}',
		childSessionId: "child_test",
		sessionFileContent: "{}\n",
		remoteTempRoot: "C:\\Users\\sparrow\\AppData\\Local\\Temp",
		evidenceFiles: ["bug.js"],
		executionIdFactory: () => "exec_test",
		launchIdFactory: () => "launch_test",
		...overrides,
	});
}

// =============================================================================
// TEST A — remote target config
// =============================================================================

describe("remote target config", () => {
	it("parses a valid target", () => {
		const result = parseRemoteExecutionTarget(TARGET);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.target.targetId).toBe("blackpearl");
			expect(result.target.host).toBe("blackpearl");
			expect(result.target.platform).toBe("windows");
		}
	});

	it("rejects invalid targets structurally", () => {
		expect(parseRemoteExecutionTarget({ ...TARGET, transport: "http" }).ok).toBe(false);
		expect(parseRemoteExecutionTarget({ ...TARGET, platform: "plan9" }).ok).toBe(false);
		expect(parseRemoteExecutionTarget({ ...TARGET, targetId: "../escape" }).ok).toBe(false);
		expect(parseRemoteExecutionTarget({ ...TARGET, host: "" }).ok).toBe(false);
	});

	it("never leaks secrets (target model has no secret field)", () => {
		const result = parseRemoteExecutionTarget(TARGET);
		if (result.ok) {
			expect(JSON.stringify(result.target)).not.toMatch(/api[_-]?key|secret|token|password/i);
		}
	});

	it("file registry persists and reloads a target", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "remote-target-"));
		try {
			const registry = new RemoteTargetRegistry({ store: createFileRemoteTargetRegistry(root) });
			await registry.register(TARGET);
			const loaded = await registry.get("blackpearl");
			expect(loaded.host).toBe("blackpearl");
			const list = await registry.list();
			expect(list.entries.map((t) => t.targetId)).toContain("blackpearl");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// =============================================================================
// Protocol + PowerShell quoting
// =============================================================================

describe("remote protocol framing", () => {
	it("parses valid frames and ignores noise (TEST F)", () => {
		expect(parseRemoteFrame("NOT JSON")).toBeUndefined();
		expect(parseRemoteFrame("")).toBeUndefined();
		expect(parseRemoteFrame("plain child stdout")).toBeUndefined();
		const frame = parseRemoteFrame(serializeRemoteFrame("REMOTE_STARTED", { executionId: "e1" }));
		expect(frame?.type).toBe("REMOTE_STARTED");
		expect(frame?.payload.executionId).toBe("e1");
	});

	it("encodes PowerShell commands without shell interpolation (TEST E)", () => {
		const script = `Set-Location -LiteralPath 'C:\\Program Files\\My App'; & node 'C:\\Program Files\\My App\\cli.js'`;
		const encoded = encodePowerShellCommand(script);
		// Base64 of UTF-16LE, decodable round-trip.
		const decoded = Buffer.from(encoded, "base64").toString("utf16le");
		expect(decoded).toBe(script);
	});
});

describe("remote launch path uses argv, never a shell string (TEST E)", () => {
	it("carries a spaced remote CLI entry as a single argv element", async () => {
		const spaced = "C:\\Program Files\\jensen\\dist\\cli.js";
		const executor = makeExecutor({
			buildRemoteLaunch: ({ request: r, sessionDir }) => ({
				command: "node",
				args: [spaced, "--child-mission", r.missionId, "--session-dir", sessionDir],
				cwd: "",
				env: { JENSEN_CODE_CODING_AGENT_DIR: "agent" },
			}),
		});
		await executor.launch(request(), {});
		const args = transport.launched[0].launch.args;
		// The spaced path is one argv element, not shell-interpolated fragments.
		expect(args).toContain(spaced);
		expect(args.every((a) => typeof a === "string")).toBe(true);
	});
});

// =============================================================================
// RemoteMissionExecutor
// =============================================================================

describe("RemoteMissionExecutor", () => {
	it("launches exactly one child per execution identity (TEST G)", async () => {
		const executor = makeExecutor();
		const handle = await executor.launch(request(), {});
		expect(handle.executionId).toBe("exec_test");
		expect(transport.launched).toHaveLength(1);
		expect(transport.launched[0].launch.command).toBe("node");
	});

	it("rejects duplicate launch of the same execution identity (TEST H)", async () => {
		const executor = makeExecutor();
		await executor.launch(request(), {});
		await expect(executor.launch(request(), {})).rejects.toThrow(RemoteExecutionError);
		await expect(executor.launch(request(), {})).rejects.toMatchObject({ code: "REMOTE_DUPLICATE_LAUNCH" });
		expect(transport.launched).toHaveLength(1);
	});

	it("carries fencing identity in the remote launch spec (TEST I)", async () => {
		const executor = makeExecutor();
		await executor.launch(request(), {
			fencing: { leaseId: "lease_1", fencingToken: 7 },
		});
		expect(transport.launched[0].fencing).toEqual({ leaseId: "lease_1", fencingToken: 7 });
	});

	it("materialises workspace files + evidence files (TEST S)", async () => {
		const executor = makeExecutor({
			workspaceFiles: () => [{ path: "bug.js", content: "broken" }],
		});
		await executor.launch(request(), {});
		const spec = transport.launched[0];
		expect(spec.workspaceFiles?.some((f) => f.path === "bug.js")).toBe(true);
		expect(spec.evidenceFiles).toContain("bug.js");
	});

	it("classifies a verified remote exit-0 as SUCCEEDED (TEST J)", async () => {
		transport.commandResults.set("node test.js", { exitCode: 0, stdout: "ok", stderr: "" });
		const executor = makeExecutor();
		const handle = await executor.launch(request(), {});
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("SUCCEEDED");
		expect(result.verification.status).toBe("verified");
	});

	it("keeps remote child failure a failure (TEST K)", async () => {
		transport.launchImpl = async () => fakeHandle({ exitCode: 1, stdout: "", stderr: "boom" });
		const executor = makeExecutor();
		const handle = await executor.launch(request(), {});
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("FAILED");
	});

	it("classifies a remote launch crash as CRASHED (TEST L)", async () => {
		transport.launchImpl = async () => fakeHandle({ exitCode: null, launchError: "connection refused" });
		const executor = makeExecutor();
		const handle = await executor.launch(request(), {});
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("CRASHED");
	});

	it("transport drop before launch never fabricates success (TEST M)", async () => {
		transport.launchImpl = async () => ({
			executionId: "exec_test",
			launchId: "launch_test",
			outcomePromise: Promise.reject(new RemoteExecutionError("REMOTE_TARGET_UNAVAILABLE", "host unreachable", {})),
			cancel: async () => {},
		});
		const executor = makeExecutor();
		const handle = await executor.launch(request(), {});
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("FAILED");
		expect(result.success).toBe(false);
	});

	it("emits stable remote retry correlation for transport loss", async () => {
		transport.launchImpl = async () => ({
			executionId: "exec_test",
			launchId: "launch_test",
			outcomePromise: Promise.reject(
				new RemoteExecutionError("REMOTE_EXECUTION_LOST", "transport closed without terminal result", {}),
			),
			cancel: async () => {},
		});
		const events: Array<{ eventId: string; type: string; payload?: unknown }> = [];
		const executor = makeExecutor({ eventObserver: (event) => events.push(event) });
		const handle = await executor.launch(request({ missionId: "mission_remote_events" }), {
			attemptId: "attempt_remote",
			assignmentId: "assignment_remote",
			executionId: "exec_test",
			sessionId: "session_remote",
		});
		await executor.awaitResult(handle);
		expect(events[0]).toMatchObject({
			eventId: "mission_remote_events:exec_test:connected",
			type: "connected",
		});
		expect(events.find((event) => event.eventId.endsWith(":transport_error"))).toMatchObject({
			type: "transport_error",
		});
		const retry = events.find((event) => event.eventId.endsWith(":transport_error"));
		expect(retry?.payload).toMatchObject({
			errorCode: "REMOTE_EXECUTION_LOST",
			correlation: {
				missionId: "mission_remote_events",
				assignmentId: "assignment_remote",
				attemptId: "attempt_remote",
				executionId: "exec_test",
				sessionId: "session_remote",
			},
		});
	});

	it("transport drop after launch (lost terminal) never fabricates success (TEST N)", async () => {
		transport.launchImpl = async () => ({
			executionId: "exec_test",
			launchId: "launch_test",
			outcomePromise: Promise.reject(
				new RemoteExecutionError("REMOTE_EXECUTION_LOST", "transport closed without terminal result", {}),
			),
			cancel: async () => {},
		});
		const executor = makeExecutor();
		const handle = await executor.launch(request(), {});
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("FAILED");
		expect(result.success).toBe(false);
	});

	it("cancel produces CANCELLED, never success (TEST P)", async () => {
		transport.launchImpl = async () => fakeHandle({ exitCode: 0, cancelled: true, stdout: "" });
		const executor = makeExecutor();
		const handle = await executor.launch(request(), {});
		await executor.cancel(handle, "operator");
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("CANCELLED");
		expect(result.success).toBe(false);
	});

	it("late success after ownership loss is rejected at the fence (TEST R)", async () => {
		// The executor reports the observed result; the durable coordinator is the
		// authority that rejects a stale terminal commit. Here we assert the
		// executor does not itself upgrade a cancelled execution to SUCCEEDED.
		transport.launchImpl = async () => fakeHandle({ exitCode: 0, stdout: "late success" });
		const executor = makeExecutor();
		const handle = await executor.launch(request(), {});
		await executor.cancel(handle, "ownership lost");
		const result = await executor.awaitResult(handle);
		expect(result.state).toBe("CANCELLED");
	});

	it("model location is independent of execution host (TEST U)", async () => {
		// The target model has no model/inference host; the executor's modelsJson
		// is supplied independently.
		expect((TARGET as unknown as Record<string, unknown>).modelHost).toBeUndefined();
		const executor = makeExecutor({ modelsJson: '{"providers":{"remote-model":{}}}' });
		await executor.launch(request(), {});
		expect(transport.launched[0].modelsJson).toContain("remote-model");
	});

	it("never launches a model runtime on the remote target (TEST V)", async () => {
		const executor = makeExecutor();
		await executor.launch(request(), {});
		const spec = transport.launched[0];
		expect(spec.launch.command).toBe("node");
		expect(JSON.stringify(spec.launch.args)).not.toMatch(/llama|gguf|server/i);
	});
});

describe("remote verification", () => {
	it("runs verification commands against the remote cwd", async () => {
		const verifier = buildRemoteAcceptanceCriteriaVerifier(request(), {
			runner: transport,
			target: TARGET,
			cwd: "C:\\Users\\sparrow\\AppData\\Local\\Temp\\jensen-remote-qa\\exec_test",
		});
		expect(verifier).toBeDefined();
		transport.commandResults.set("node test.js", { exitCode: 0, stdout: "ok", stderr: "" });
		const result = await verifier!({
			request: request(),
			outcome: { exitCode: 0, stdout: "", stderr: "" },
		});
		expect(result.verified).toBe(true);
		expect(result.criterionIds).toContain("test");
	});
});
