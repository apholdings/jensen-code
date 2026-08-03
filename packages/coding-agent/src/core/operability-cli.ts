import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateMcpConfig, validateMcpToolSchemas } from "./mcp.js";
import { createMcpClient } from "./mcp-client.js";
import {
	collectDiagnostics,
	createSupportBundle,
	diffRuns,
	listEvidence,
	loadProjectionFromSession,
	renderReplay,
	supportBundlePreview,
} from "./operability.js";
import {
	inspectSupportBundle,
	rebuildStorageIndex,
	reexecuteRun,
	simulateReplay,
	storagePrune,
} from "./operability-runtime.js";
import { handleSubagentCommand } from "./subagent-cli.js";

function output(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function usage(): string {
	return [
		"Usage: jensen <run|evidence|doctor|support-bundle|mcp|storage> ...",
		"  run inspect|status|timeline|events|replay|simulate|reexecute|replay-state|diff <session-file> [other-session-file]",
		"  evidence list|inspect <session-file>",
		"  doctor [providers|tools|workspace|safety|web|lsp|jobs|budgets|routing|events|evidence|mcp|release|index|embeddings|retrieval]",
		"  support-bundle create|preview|inspect|verify <session-file|bundle> <destination>",
		"  mcp validate-config|validate-tools|resources|resource|prompts|prompt <json-file|config-file>",
		"  storage prune --preview|--execute <directory>",
		"  storage index status|rebuild <session-file> [index-file]",
	].join("\n");
}

export async function handleOperabilityCommand(args: string[]): Promise<boolean> {
	if (args[0] === "doctor" && (args[1] === "subagents" || args[1] === "skills")) {
		return handleSubagentCommand([args[1] === "subagents" ? "agents" : "skills", "validate", "--json"]);
	}
	const namespace = args[0];
	if (!["run", "evidence", "doctor", "support-bundle", "mcp", "storage"].includes(namespace ?? "")) return false;
	try {
		if (namespace === "doctor") {
			const sessionFile = args[1]?.endsWith(".jsonl") ? resolve(args[1]) : undefined;
			const report = collectDiagnostics({ cwd: process.cwd(), sessionFile, checkMcp: args.includes("mcp") });
			output(report);
			process.exitCode = report.exitCode;
			return true;
		}
		if (namespace === "run") return handleRun(args.slice(1));
		if (namespace === "evidence") return handleEvidence(args.slice(1));
		if (namespace === "support-bundle") return handleBundle(args.slice(1));
		if (namespace === "storage") return handleStorage(args.slice(1));
		return handleMcp(args.slice(1));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
		return true;
	}
}

async function handleRun(args: string[]): Promise<boolean> {
	const command = args[0];
	const file = args[1];
	if (command === "diff") {
		if (!file || !args[2]) throw new Error(usage());
		const left = loadProjectionFromSession(resolve(file)).projection;
		const right = loadProjectionFromSession(resolve(args[2])).projection;
		output(diffRuns(left, right));
		return true;
	}
	if (!file) throw new Error(usage());
	const loaded = loadProjectionFromSession(resolve(file));
	if (command === "replay") output(renderReplay(loaded.events));
	else if (command === "simulate") output(simulateReplay(loaded.events));
	else if (command === "reexecute")
		output(reexecuteRun(loaded.events, { cwd: process.cwd(), plan: true, outputDir: dirname(resolve(file)) }));
	else if (command === "replay-state" || command === "inspect" || command === "status")
		output({ projection: loaded.projection, issues: loaded.events.issues });
	else if (command === "timeline" || command === "events") output(loaded.events);
	else throw new Error(usage());
	return true;
}

async function handleEvidence(args: string[]): Promise<boolean> {
	const file = args[1];
	if (!file) throw new Error(usage());
	const loaded = loadProjectionFromSession(resolve(file));
	output({ evidence: listEvidence(loaded.events), projection: loaded.projection });
	return true;
}

async function handleBundle(args: string[]): Promise<boolean> {
	const command = args[0];
	const file = args[1];
	if (!file) throw new Error(usage());
	const loaded = loadProjectionFromSession(resolve(file));
	const report = collectDiagnostics({ cwd: process.cwd(), sessionFile: resolve(file) });
	if (command === "preview") output(supportBundlePreview(report, loaded.projection));
	else if (command === "create") {
		if (!args[2]) throw new Error("support-bundle create requires a destination");
		output(createSupportBundle(resolve(args[2]), report, loaded.projection));
	} else if (command === "inspect" || command === "verify") output(inspectSupportBundle(resolve(file)));
	else throw new Error(usage());
	return true;
}

async function handleStorage(args: string[]): Promise<boolean> {
	if (args[0] === "prune") {
		const root = args.find((arg) => !arg.startsWith("--") && arg !== "prune") ?? process.cwd();
		output(storagePrune(root, { preview: !args.includes("--execute") }));
		return true;
	}
	if (args[0] === "index") {
		const file = args[2];
		if (!file) throw new Error(usage());
		if (args[1] === "rebuild") output(rebuildStorageIndex(resolve(file), args[3] ? resolve(args[3]) : undefined));
		else if (args[1] === "status")
			output({
				path: resolve(file),
				exists: existsSync(resolve(file)),
				bytes: existsSync(resolve(file)) ? statSync(resolve(file)).size : 0,
			});
		else throw new Error(usage());
		return true;
	}
	throw new Error(usage());
}

async function handleMcp(args: string[]): Promise<boolean> {
	const command = args[0];
	const file = args[1];
	if (!file || !existsSync(file)) throw new Error("MCP validation requires a JSON file");
	const value = JSON.parse(readFileSync(file, "utf8"));
	if (command === "validate-config") {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("MCP configuration must be a JSON object");
		const issues = validateMcpConfig(value);
		output({ valid: issues.length === 0, issues });
	} else if (command === "validate-tools") {
		if (!Array.isArray(value)) throw new Error("MCP tools must be a JSON array");
		output(validateMcpToolSchemas(value));
	} else if (["resources", "resource", "prompts", "prompt"].includes(command ?? "")) {
		const client = createMcpClient(value, { env: process.env });
		await client.connect();
		const response =
			command === "resources"
				? await client.listResources()
				: command === "resource"
					? await client.readResource(args[2] ?? "")
					: command === "prompts"
						? await client.listPrompts()
						: await client.inspectPrompt(args[2] ?? "");
		output(response.result ?? response);
		await client.close();
	} else throw new Error(usage());
	return true;
}

export { usage as operabilityUsage };
