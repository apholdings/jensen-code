/**
 * Executor Registry — CLI (2.10.0).
 *
 * `jensen executor list|show|status|register|activate|heartbeat|deactivate|retire`
 *
 * Machine-readable `--json` exposes stable DTOs; human output is a compact
 * key: value block. Operators never need to inspect registry files.
 */

import chalk from "chalk";
import { ExecutorControlService } from "./executor-control-service.js";
import type {
	ActivateExecutorInput,
	ExecutorActivationOutcome,
	ExecutorCapabilities,
	ExecutorDeactivateOutcome,
	ExecutorDetail,
	ExecutorHeartbeatOutcome,
	ExecutorListResult,
	ExecutorRetireOutcome,
	ExecutorRuntimeProof,
} from "./executor-registry-types.js";
import { createFileExecutorRegistry } from "./file-executor-registry.js";
import { ExecutorRuntimeRegistration } from "./runtime-harness.js";

const CONTROL_SUBCOMMANDS = new Set([
	"list",
	"show",
	"status",
	"register",
	"activate",
	"heartbeat",
	"deactivate",
	"retire",
]);

function buildService(): ExecutorControlService {
	return new ExecutorControlService({ store: createFileExecutorRegistry() });
}

function valueArgs(args: string[]): string[] {
	return args.filter((a) => !a.startsWith("--"));
}

function flag(args: string[], name: string): boolean {
	return args.includes(name);
}

function flagValue(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

function flagValues(args: string[], name: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === name && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) {
			values.push(args[i + 1]);
		}
	}
	return values;
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function codeOf(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		return String((error as { code: unknown }).code);
	}
	return undefined;
}

function renderError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const code = codeOf(error);
	process.stderr.write(`${chalk.red(code ? `${code}: ${message}` : message)}\n`);
}

// =============================================================================
// Human renderers
// =============================================================================

function renderList(result: ExecutorListResult): void {
	if (result.entries.length === 0 && result.corrupt.length === 0) {
		process.stdout.write("(no executors)\n");
		return;
	}
	for (const entry of result.entries) {
		process.stdout.write(
			[
				`${entry.executorId}  [${entry.status}]`,
				entry.runtimeInstanceId ? ` runtime=${entry.runtimeInstanceId}` : "",
				` epoch=${entry.runtimeEpoch}`,
				entry.hostname ? ` host=${entry.hostname}` : "",
				entry.platform ? ` platform=${entry.platform}` : "",
				entry.arch ? ` arch=${entry.arch}` : "",
				entry.lastHeartbeatAtMs ? ` heartbeat=${entry.lastHeartbeatAtMs}` : "",
			].join(""),
		);
		process.stdout.write("\n");
	}
	for (const corrupt of result.corrupt) {
		process.stdout.write(chalk.yellow(`${corrupt.executorId}  [CORRUPT] ${corrupt.diagnostic}\n`));
	}
}

function renderDetail(detail: ExecutorDetail): void {
	process.stdout.write(`EXECUTOR\n`);
	process.stdout.write(`  id: ${detail.executorId}\n`);
	process.stdout.write(`  status: ${detail.status}\n`);
	if (detail.displayName) process.stdout.write(`  display: ${detail.displayName}\n`);
	process.stdout.write(`  epoch: ${detail.runtimeEpoch}\n`);
	process.stdout.write(`  retired: ${detail.retired ? "yes" : "no"}\n`);
	if (detail.labels.length > 0) process.stdout.write(`  labels: ${detail.labels.join(", ")}\n`);
	if (detail.runtime) {
		const r = detail.runtime;
		process.stdout.write(`RUNTIME\n`);
		process.stdout.write(`  instance: ${r.runtimeInstanceId}\n`);
		process.stdout.write(`  owner: ${r.ownerId}\n`);
		if (r.hostname) process.stdout.write(`  host: ${r.hostname}\n`);
		if (r.pid !== undefined) process.stdout.write(`  pid: ${r.pid}\n`);
		if (r.platform) process.stdout.write(`  platform: ${r.platform}/${r.arch ?? ""}\n`);
		if (r.jensenVersion) process.stdout.write(`  version: ${r.jensenVersion}\n`);
		process.stdout.write(`  started: ${r.startedAtMs}\n`);
		process.stdout.write(`  last heartbeat: ${r.lastHeartbeatAtMs}\n`);
		process.stdout.write(`  expires: ${r.expiresAtMs}\n`);
		const caps = r.advertisedCapabilities;
		if (caps.providers?.length) process.stdout.write(`  providers: ${caps.providers.join(", ")}\n`);
		if (caps.models?.length) process.stdout.write(`  models: ${caps.models.join(", ")}\n`);
		if (r.resources) {
			process.stdout.write(`  resources: observed=${r.resources.observedAtMs}`);
			if (r.resources.cpuLogicalCount !== undefined) process.stdout.write(` cpu=${r.resources.cpuLogicalCount}`);
			process.stdout.write("\n");
		}
	}
}

function renderActivation(outcome: ExecutorActivationOutcome): void {
	process.stdout.write(
		[
			`activated ${outcome.executorId}`,
			`instance=${outcome.runtimeInstanceId}`,
			`epoch=${outcome.runtimeEpoch}`,
			`expires=${outcome.expiresAtMs}`,
		].join(" "),
	);
	process.stdout.write("\n");
}

function renderHeartbeat(outcome: ExecutorHeartbeatOutcome): void {
	process.stdout.write(
		`heartbeat ${outcome.executorId} instance=${outcome.runtimeInstanceId} epoch=${outcome.runtimeEpoch} expires=${outcome.expiresAtMs}\n`,
	);
}

function renderDeactivate(outcome: ExecutorDeactivateOutcome): void {
	process.stdout.write(
		`deactivated ${outcome.executorId} instance=${outcome.runtimeInstanceId} epoch=${outcome.runtimeEpoch}\n`,
	);
}

function renderRetire(outcome: ExecutorRetireOutcome): void {
	process.stdout.write(`retired ${outcome.executorId} status=${outcome.status}\n`);
}

// =============================================================================
// Handler
// =============================================================================

export function printExecutorUsage(): string {
	return [
		"  executor list [--json] [--status S] [--platform OS] [--arch A] [--label L] [--capability C] [--provider P] [--model M]",
		"  executor show <EXECUTOR_ID> [--json]",
		"  executor status <EXECUTOR_ID> [--json]",
		"  executor register <EXECUTOR_ID> [--json] [--display-name N] [--label L]... [--capability C]... [--provider P]... [--model M]...",
		"  executor activate <EXECUTOR_ID> [--json] [--provider P]... [--model M]... [--tool T]... [--label L]...",
		"  executor heartbeat <EXECUTOR_ID> --instance I --epoch N [--json]",
		"  executor deactivate <EXECUTOR_ID> --instance I --epoch N [--json]",
		"  executor retire <EXECUTOR_ID> [--json]",
	].join("\n");
}

export async function handleExecutorCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "executor") return false;
	const sub = args[1];
	if (!sub || !CONTROL_SUBCOMMANDS.has(sub)) return false;

	const json = flag(args, "--json");
	const service = buildService();

	try {
		switch (sub) {
			case "list": {
				const limitArg = flagValue(args, "--limit");
				const result = await service.listExecutors({
					filter: {
						status: flagValue(args, "--status") as ExecutorListResult["entries"][number]["status"] | undefined,
						platform: flagValue(args, "--platform"),
						arch: flagValue(args, "--arch"),
						label: flagValue(args, "--label"),
						capability: flagValue(args, "--capability"),
						provider: flagValue(args, "--provider"),
						model: flagValue(args, "--model"),
					},
					limit: limitArg !== undefined ? Number(limitArg) : undefined,
				});
				if (json) printJson(result);
				else renderList(result);
				return true;
			}

			case "show":
			case "status": {
				const executorId = valueArgs(args)[2];
				if (!executorId) return missingExecutorId();
				const detail = await service.getExecutor(executorId);
				if (json) printJson(detail);
				else renderDetail(detail);
				return true;
			}

			case "register": {
				const executorId = valueArgs(args)[2];
				if (!executorId) return missingExecutorId();
				const capabilities = capabilitiesFromFlags(args);
				const outcome = await service.registerExecutor({
					executorId,
					displayName: flagValue(args, "--display-name"),
					labels: unique(flagValues(args, "--label")),
					configuredCapabilities: capabilities,
				});
				if (json) printJson(outcome);
				else process.stdout.write(`registered ${outcome.executorId} status=${outcome.status}\n`);
				return true;
			}

			case "activate": {
				const executorId = valueArgs(args)[2];
				if (!executorId) return missingExecutorId();
				const capabilities = capabilitiesFromFlags(args);
				const registration = new ExecutorRuntimeRegistration(service, executorId, {
					expiryMs: optionalNumber(flagValue(args, "--expiry")),
				});
				const input: Parameters<ExecutorRuntimeRegistration["activate"]>[0] = {
					advertisedCapabilities: capabilities,
				};
				if (flagValue(args, "--hostname")) input.hostname = flagValue(args, "--hostname");
				const outcome = await registration.activate(input as ActivateExecutorInput);
				if (json) printJson(outcome);
				else renderActivation(outcome);
				return true;
			}

			case "heartbeat": {
				const proof = proofFromArgs(args);
				if (!proof) return missingProof();
				const outcome = await service.heartbeatExecutor(proof);
				if (json) printJson(outcome);
				else renderHeartbeat(outcome);
				return true;
			}

			case "deactivate": {
				const proof = proofFromArgs(args);
				if (!proof) return missingProof();
				const outcome = await service.deactivateExecutor(proof);
				if (json) printJson(outcome);
				else renderDeactivate(outcome);
				return true;
			}

			case "retire": {
				const executorId = valueArgs(args)[2];
				if (!executorId) return missingExecutorId();
				const outcome = await service.retireExecutor(executorId);
				if (json) printJson(outcome);
				else renderRetire(outcome);
				return true;
			}

			default:
				return false;
		}
	} catch (error) {
		renderError(error);
		process.exitCode = 1;
		return true;
	}
}

function missingExecutorId(): boolean {
	process.stderr.write("missing executor id\n");
	process.exitCode = 1;
	return true;
}

function missingProof(): boolean {
	process.stderr.write("missing runtime proof (--instance and --epoch are required)\n");
	process.exitCode = 1;
	return true;
}

function optionalNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function unique(values: string[]): string[] {
	return [...new Set(values)].sort();
}

function proofFromArgs(args: string[]): ExecutorRuntimeProof | undefined {
	const executorId = valueArgs(args)[2];
	const instance = flagValue(args, "--instance");
	const epochArg = flagValue(args, "--epoch");
	if (!executorId || !instance || epochArg === undefined) return undefined;
	const epoch = Number(epochArg);
	if (!Number.isSafeInteger(epoch) || epoch < 1) return undefined;
	return { executorId, runtimeInstanceId: instance, runtimeEpoch: epoch };
}

function capabilitiesFromFlags(args: string[]): ExecutorCapabilities {
	const capabilities: ExecutorCapabilities = {};
	const providers = unique(flagValues(args, "--provider"));
	const models = unique(flagValues(args, "--model"));
	const tools = unique(flagValues(args, "--tool"));
	const specialized = unique(flagValues(args, "--specialized"));
	const execution = unique(flagValues(args, "--execution"));
	const extra = unique(flagValues(args, "--capability"));
	if (providers.length > 0) capabilities.providers = providers;
	if (models.length > 0) capabilities.models = models;
	if (tools.length > 0) capabilities.tools = tools;
	if (specialized.length > 0) capabilities.specialized = specialized;
	if (execution.length > 0) capabilities.execution = execution;
	if (extra.length > 0) capabilities.extra = extra;
	return capabilities;
}
