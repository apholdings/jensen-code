/**
 * Unity MCP Vertical Slice — CLI (2.13.0).
 *
 * `jensen unity inspect [--json]`
 * `jensen unity schedule-proof [--json]`
 * `jensen unity server-config [--json]`
 *
 * One-shot, process-lifetime operations. `inspect` verifies SSH, connects to
 * the real Unity MCP relay, discovers enabled tools, performs a read-only
 * Console observation, records Evidence, and disconnects. `schedule-proof`
 * proves Mission → Scheduler → Assignment → Unity executor designation and
 * STOPS there; it does not execute anything. No persistent worker is implied.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { getAgentDir } from "../../config.js";
import { EvidenceFileStore } from "../context-runtime/evidence-archive.js";
import { McpClientService } from "../mcp-foundation/mcp-client-service.js";
import { inspectUnity } from "./unity-inspect.js";
import { runUnitySchedulerProof } from "./unity-scheduler-proof.js";
import { buildUnityMcpServerDefinition, LOTG_UNITY_TARGET } from "./unity-server-config.js";
import type { UnityInspectionResult } from "./unity-types.js";

const SUBCOMMANDS = new Set(["inspect", "schedule-proof", "server-config"]);

function flag(args: string[], name: string): boolean {
	return args.includes(name);
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

function renderInspection(result: UnityInspectionResult): void {
	process.stdout.write(`UNITY MCP INSPECTION\n`);
	process.stdout.write(`  server: ${result.serverId}\n`);
	process.stdout.write(`  machine: ${result.machine}\n`);
	process.stdout.write(`  connection: ${result.connection}\n`);
	if (result.connectionReason) process.stdout.write(`  reason: ${result.connectionReason}\n`);
	if (result.serverIdentity)
		process.stdout.write(`  identity: ${result.serverIdentity.name}@${result.serverIdentity.version}\n`);
	if (result.protocolVersion) process.stdout.write(`  protocol: ${result.protocolVersion}\n`);
	if (result.protocolEra) process.stdout.write(`  protocol era: ${result.protocolEra}\n`);
	if (result.sessionId) process.stdout.write(`  session: ${result.sessionId}\n`);
	if (result.tools.length > 0) {
		process.stdout.write(`  tools:\n`);
		for (const tool of result.tools) {
			process.stdout.write(`    ${tool.mutating ? "WRITE" : "READ"}  ${tool.name}\n`);
		}
	}
	for (const obs of result.observations) {
		process.stdout.write(`  ${obs.category}: ${obs.status}`);
		if (obs.missingTool) process.stdout.write(` (missing: ${obs.missingTool})`);
		process.stdout.write("\n");
	}
	for (const id of result.evidenceIds) {
		process.stdout.write(`  evidence: ${id}\n`);
	}
}

export function printUnityUsage(): string {
	return ["  unity inspect [--json]", "  unity schedule-proof [--json]", "  unity server-config [--json]"].join("\n");
}

export async function handleUnityCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "unity") return false;
	const sub = args[1];
	if (!sub || !SUBCOMMANDS.has(sub)) return false;

	const json = flag(args, "--json");

	try {
		switch (sub) {
			case "server-config": {
				const definition = buildUnityMcpServerDefinition(LOTG_UNITY_TARGET);
				if (json) printJson(definition);
				else {
					process.stdout.write(`${definition.id}\n`);
					process.stdout.write(`  command: ${definition.command}\n`);
					for (const arg of definition.args ?? []) process.stdout.write(`  arg: ${arg}\n`);
				}
				return true;
			}

			case "inspect": {
				const archive = new EvidenceFileStore(join(getAgentDir(), "context-evidence"));
				const service = new McpClientService({ evidenceArchive: archive });
				const result = await inspectUnity({ target: LOTG_UNITY_TARGET, service });
				if (json) printJson(result);
				else renderInspection(result);
				if (result.connection !== "PASS") process.exitCode = 1;
				return true;
			}

			case "schedule-proof": {
				const root = mkdtempSync(join(tmpdir(), "unity-scheduler-proof-"));
				const result = await runUnitySchedulerProof({ root });
				if (json) printJson(result);
				else {
					process.stdout.write(`UNITY SCHEDULER PROOF\n`);
					process.stdout.write(`  mission: ${result.missionId}\n`);
					process.stdout.write(`  intent: ${result.intentId}\n`);
					process.stdout.write(`  decision: ${result.decision}\n`);
					process.stdout.write(`  executor: ${result.executorId}\n`);
					if (result.assignmentId) process.stdout.write(`  assignment: ${result.assignmentId}\n`);
					if (result.reason) process.stdout.write(`  reason: ${result.reason}\n`);
				}
				if (result.decision !== "ASSIGN") process.exitCode = 1;
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
