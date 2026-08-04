import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { cleanupFixture, type MaterializedFixture, materializeFixture } from "./fixtures.js";
import { sha256 } from "./identity.js";
import type {
	EvaluationCandidatePolicy,
	EvaluationEvent,
	EvaluationFixtureSpec,
	EvaluationSandboxEventType,
	EvaluationSandboxIdentity,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface EvaluationSandboxPolicy {
	allowedTools: string[];
	deniedEffects: string[];
	workspaceBoundary: string;
	networkPolicy: "none" | "loopback_only" | "provider_only" | "explicit_allowlist";
	maximumProcesses: number;
	maximumToolCalls: number;
	maximumWallTimeMs: number;
	maximumOutputBytes: number;
	maximumDiskBytes: number;
	maximumCostUsd?: number;
}

export interface SandboxProcessResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	cancelled: boolean;
}

export interface EvaluationSandbox {
	readonly root: string;
	readonly identity: EvaluationSandboxIdentity;
	readonly policy: Readonly<EvaluationSandboxPolicy>;
	readonly events: EvaluationEvent[];
	runProcess(
		command: string,
		args?: string[],
		options?: { signal?: AbortSignal; env?: Record<string, string> },
	): Promise<SandboxProcessResult>;
	retain(): Promise<void>;
	cleanup(): Promise<void>;
}

export function policyFromCandidate(
	candidate: EvaluationCandidatePolicy,
	workspaceBoundary = "",
): EvaluationSandboxPolicy {
	const budget = candidate.budget;
	const policy: EvaluationSandboxPolicy = {
		allowedTools: [...(candidate.allowedTools ?? ["node", "git"])].sort(),
		deniedEffects: [...(candidate.deniedEffects ?? ["publish", "credential_read", "evaluator_write"])].sort(),
		workspaceBoundary: candidate.workspaceBoundary ?? workspaceBoundary,
		networkPolicy: candidate.networkPolicy ?? (candidate.allowNetwork ? "explicit_allowlist" : "none"),
		maximumProcesses: candidate.maximumProcesses ?? 32,
		maximumToolCalls: candidate.maximumToolCalls ?? budget?.maximumToolCalls ?? 64,
		maximumWallTimeMs: candidate.maximumWallTimeMs ?? budget?.maximumWallTimeMs ?? 120_000,
		maximumOutputBytes: candidate.maximumOutputBytes ?? budget?.maximumOutputBytes ?? 1_000_000,
		maximumDiskBytes: candidate.maximumDiskBytes ?? budget?.maximumDiskBytes ?? 10_000_000,
		maximumCostUsd: candidate.maximumCostUsd ?? budget?.maximumCostUsd,
	};
	if (policy.maximumProcesses < 1) throw new Error("maximumProcesses must be positive");
	if (policy.maximumToolCalls < 0) throw new Error("maximumToolCalls must not be negative");
	if (policy.maximumWallTimeMs < 1) throw new Error("maximumWallTimeMs must be positive");
	if (policy.maximumOutputBytes < 1) throw new Error("maximumOutputBytes must be positive");
	if (policy.maximumDiskBytes < 1) throw new Error("maximumDiskBytes must be positive");
	return policy;
}

export function assertSandboxPath(root: string, candidate: string): string {
	const resolvedRoot = resolve(root);
	const resolvedCandidate = resolve(resolvedRoot, candidate);
	const rootPrefix = `${resolvedRoot}${sep}`;
	if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(rootPrefix))
		throw new Error(`sandbox path escapes workspace boundary: ${candidate}`);
	return resolvedCandidate;
}

function event(type: EvaluationSandboxEventType, details: Record<string, string | number | boolean>): EvaluationEvent {
	return { eventId: randomUUID(), type, timestamp: new Date().toISOString(), details };
}

async function directorySize(root: string): Promise<number> {
	const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	let total = 0;
	for (const entry of entries) {
		const path = assertSandboxPath(root, entry.name);
		if (entry.isDirectory()) total += await directorySize(path);
		else if (entry.isFile()) total += (await stat(path)).size;
	}
	return total;
}

async function makeReadOnly(root: string): Promise<void> {
	const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	for (const entry of entries) {
		const path = assertSandboxPath(root, entry.name);
		if (entry.isDirectory()) await makeReadOnly(path);
		else if (entry.isFile()) await chmod(path, 0o444);
	}
	await chmod(root, 0o555);
}

function safeEnvironment(
	input: Record<string, string> | undefined,
	root: string,
	policy: EvaluationSandboxPolicy,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: root,
		TMPDIR: root,
		TEMP: root,
		TMP: root,
		JENSEN_EVALUATION_SANDBOX: "1",
		JENSEN_EVALUATION_NETWORK_POLICY: policy.networkPolicy,
	};
	for (const [key, value] of Object.entries(input ?? {})) {
		if (/token|secret|password|api[_-]?key|private[_-]?key|auth/i.test(key))
			throw new Error(`sandbox environment rejects secret-like variable: ${key}`);
		environment[key] = value;
	}
	return environment;
}

async function terminateProcess(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(() => undefined);
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

async function runProcess(
	root: string,
	policy: EvaluationSandboxPolicy,
	events: EvaluationEvent[],
	command: string,
	args: string[],
	options: { signal?: AbortSignal; env?: Record<string, string> } = {},
): Promise<SandboxProcessResult> {
	if (policy.allowedTools.length > 0 && !policy.allowedTools.includes(basename(command)))
		throw new Error(`sandbox tool is not allowed: ${basename(command)}`);
	for (const argument of args) {
		if (/\.jensen[\\/]evaluations|baseline|evaluator|result\.json|\.env|npmrc/i.test(argument))
			throw new Error("sandbox policy denied evaluator, baseline, result, or credential path");
		if (isAbsoluteLike(argument) && !argument.startsWith(resolve(root)))
			throw new Error(`sandbox argument escapes workspace boundary: ${argument}`);
	}
	const started = Date.now();
	const child = spawn(command, args, {
		cwd: root,
		env: safeEnvironment(options.env, root, policy),
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	events.push(event("EVAL_CANDIDATE_STARTED", { command: basename(command) }));
	let stdout = "";
	let stderr = "";
	let exceededOutput = false;
	let timedOut = false;
	let cancelled = false;
	const append = (current: string, chunk: Buffer): string => {
		const next = `${current}${chunk.toString("utf8")}`;
		if (Buffer.byteLength(next) > policy.maximumOutputBytes) {
			exceededOutput = true;
			void terminateProcess(child);
			return next.slice(0, policy.maximumOutputBytes);
		}
		return next;
	};
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout = append(stdout, chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = append(stderr, chunk);
	});
	const timeout = setTimeout(() => {
		timedOut = true;
		void terminateProcess(child);
	}, policy.maximumWallTimeMs);
	const onAbort = () => {
		cancelled = true;
		void terminateProcess(child);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
		(resolvePromise, reject) => {
			child.once("error", reject);
			child.once("exit", (exitCode, signal) => resolvePromise({ exitCode, signal }));
		},
	);
	clearTimeout(timeout);
	options.signal?.removeEventListener("abort", onAbort);
	const diskBytes = await directorySize(root);
	if (diskBytes > policy.maximumDiskBytes) {
		events.push(event("EVAL_CANDIDATE_FAILED", { reason: "disk_limit", diskBytes }));
		throw new Error(`sandbox disk limit exceeded: ${diskBytes}`);
	}
	if (exceededOutput) {
		events.push(event("EVAL_CANDIDATE_FAILED", { reason: "output_limit" }));
		throw new Error("sandbox output limit exceeded");
	}
	if (timedOut) {
		events.push(event("EVAL_CANDIDATE_FAILED", { reason: "timeout" }));
		throw new Error("sandbox wall-time limit exceeded");
	}
	if (cancelled) {
		events.push(event("EVAL_CANDIDATE_FAILED", { reason: "cancelled" }));
		throw new Error("sandbox execution cancelled");
	}
	events.push(event("EVAL_CANDIDATE_COMPLETED", { exitCode: result.exitCode ?? -1 }));
	return { ...result, stdout, stderr, durationMs: Date.now() - started, timedOut, cancelled };
}

function isAbsoluteLike(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export async function createEvaluationSandbox(input: {
	evaluationRunId: string;
	fixture: EvaluationFixtureSpec;
	policy: EvaluationCandidatePolicy;
	retainOnFailure?: boolean;
	signal?: AbortSignal;
}): Promise<EvaluationSandbox> {
	const events: EvaluationEvent[] = [];
	let fixture: MaterializedFixture | undefined;
	let retained = false;
	try {
		fixture = await materializeFixture(input.fixture, { retainOnFailure: false });
		const root = resolve(fixture.root);
		const policy = Object.freeze(policyFromCandidate(input.policy, root));
		const identity: EvaluationSandboxIdentity = {
			sandboxId: randomUUID(),
			evaluationRunId: input.evaluationRunId,
			canonicalRoot: root,
			fixtureHash: fixture.fixtureHash,
			platform: `${process.platform}-${process.arch}`,
			createdAt: new Date().toISOString(),
			retained: false,
		};
		events.push(event("EVAL_SANDBOX_ALLOCATED", { sandboxId: identity.sandboxId }));
		events.push(event("EVAL_SANDBOX_MATERIALIZED", { fixtureHash: fixture.fixtureHash }));
		const diskBytes = await directorySize(root);
		if (diskBytes > policy.maximumDiskBytes) throw new Error("fixture exceeds sandbox disk limit");
		const verifiedHash = sha256(JSON.stringify({ fixtureHash: fixture.fixtureHash, diskBytes }));
		if (!verifiedHash) throw new Error("sandbox verification failed");
		events.push(event("EVAL_SANDBOX_VERIFIED", { fixtureHash: fixture.fixtureHash }));
		return {
			root,
			identity,
			policy,
			events,
			runProcess: (command, args, options) => runProcess(root, policy, events, command, args ?? [], options),
			retain: async () => {
				if (retained) return;
				retained = true;
				identity.retained = true;
				await makeReadOnly(root);
				events.push(event("EVAL_SANDBOX_RETAINED", { sandboxId: identity.sandboxId }));
			},
			cleanup: async () => {
				events.push(event("EVAL_SANDBOX_CLEANUP_STARTED", { sandboxId: identity.sandboxId }));
				if (!retained) await rm(root, { recursive: true, force: true });
				events.push(event("EVAL_SANDBOX_CLEANUP_COMPLETED", { sandboxId: identity.sandboxId }));
			},
		};
	} catch (error) {
		if (fixture) await cleanupFixture(fixture);
		throw error;
	}
}

export async function writeSandboxMetadata(sandbox: EvaluationSandbox): Promise<void> {
	await mkdir(sandbox.root, { recursive: true });
	await writeFile(resolve(sandbox.root, ".jensen-sandbox.json"), JSON.stringify(sandbox.identity, null, 2), "utf8");
}

export async function readSandboxMetadata(root: string): Promise<EvaluationSandboxIdentity> {
	const metadataPath = assertSandboxPath(root, ".jensen-sandbox.json");
	return JSON.parse(await readFile(metadataPath, "utf8")) as EvaluationSandboxIdentity;
}
