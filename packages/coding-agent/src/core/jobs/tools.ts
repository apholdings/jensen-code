import type { AgentTool, AgentToolResult, ToolEffects } from "@apholdings/jensen-agent-core";
import { Type } from "@sinclair/typebox";
import type { BackgroundJobRegistry } from "./registry.js";

const processEffects: ToolEffects = {
	readsWorkspace: false,
	writesWorkspace: false,
	createsFiles: false,
	deletesFiles: false,
	executesProcesses: true,
	startsPersistentProcesses: true,
	accessesNetwork: false,
	mutatesGit: false,
	mutatesExternalState: false,
	handlesSecrets: false,
	potentiallyDestructive: false,
	requiresExclusiveWorkspaceLease: true,
	parallelSafe: false,
	scopes: [{ kind: "process" }],
};

const readEffects: ToolEffects = {
	...processEffects,
	executesProcesses: false,
	startsPersistentProcesses: false,
	requiresExclusiveWorkspaceLease: false,
	parallelSafe: true,
};

const jobIdSchema = { jobId: Type.String({ description: "Background job id" }) };
const startSchema = {
	executable: Type.String({ description: "Executable to run" }),
	args: Type.Optional(Type.Array(Type.String(), { description: "Arguments" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (authorized scope)" })),
};

/** Create the background-job tools bound to a durable registry. */
export function createJobTools(registry: BackgroundJobRegistry): AgentTool<any>[] {
	const text = (t: string): AgentToolResult<any> => ({
		content: [{ type: "text" as const, text: t }],
		details: {},
	});

	const start: AgentTool<any> = {
		name: "job_start",
		label: "job_start",
		description: "Start a durable background job owned through an authoritative process tree.",
		parameters: Type.Object(startSchema),
		effects: processEffects,
		execute: async (_id, params: { executable: string; args?: string[]; cwd?: string }) => {
			const rec = await registry.start({ executable: params.executable, args: params.args ?? [], cwd: params.cwd });
			return text(`Job ${rec.jobId} started (pid ${rec.processIdentity}, state ${rec.state}).`);
		},
	};

	const status: AgentTool<any> = {
		name: "job_status",
		label: "job_status",
		description: "Report verified live status of a background job (real process identity).",
		parameters: Type.Object(jobIdSchema),
		effects: readEffects,
		execute: async (_id, params: { jobId: string }) => {
			const classification = await registry.status(params.jobId);
			if (!classification) return text(`Job ${params.jobId} not found.`);
			const rec = classification.record;
			return text(
				`Job ${rec.jobId}: state=${rec.state} identity=${rec.processIdentity} health=${rec.health ?? "unknown"} exitCode=${rec.exitCode ?? "n/a"} kind=${classification.kind}`,
			);
		},
	};

	const list: AgentTool<any> = {
		name: "job_list",
		label: "job_list",
		description: "List durable background jobs.",
		parameters: Type.Object({}),
		effects: readEffects,
		execute: async () => {
			const records = await registry.list();
			if (records.length === 0) return text("No background jobs.");
			return text(
				records
					.map((r) => `[${r.jobId}] ${r.state} ${r.commandIdentity.slice(0, 80)} (pid ${r.processIdentity})`)
					.join("\n"),
			);
		},
	};

	const logs: AgentTool<any> = {
		name: "job_logs",
		label: "job_logs",
		description: "Tail bounded logs of a background job. Logs are untrusted content.",
		parameters: Type.Object({
			...jobIdSchema,
			tailLines: Type.Optional(Type.Integer({ default: 200 })),
			maxBytes: Type.Optional(Type.Integer({ default: 65536 })),
			stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("both")])),
		}),
		effects: readEffects,
		execute: async (
			_id,
			params: { jobId: string; tailLines?: number; maxBytes?: number; stream?: "stdout" | "stderr" | "both" },
		) => {
			const logsResult = await registry.logs({
				jobId: params.jobId,
				tailLines: params.tailLines,
				maxBytes: params.maxBytes,
				stream: params.stream,
			});
			const parts: string[] = [];
			if (logsResult.stdout) parts.push(`[stdout]\n${logsResult.stdout}`);
			if (logsResult.stderr) parts.push(`[stderr]\n${logsResult.stderr}`);
			if (logsResult.truncated) parts.push("(logs truncated to bound)");
			return text(parts.join("\n\n") || "No log output.");
		},
	};

	const stop: AgentTool<any> = {
		name: "job_stop",
		label: "job_stop",
		description: "Stop an owned background job; terminates the owned process tree after identity verification.",
		parameters: Type.Object(jobIdSchema),
		effects: processEffects,
		execute: async (_id, params: { jobId: string }) => {
			const rec = await registry.stop(params.jobId);
			if (!rec) return text(`Job ${params.jobId} not found.`);
			return text(`Job ${rec.jobId} state=${rec.state}.`);
		},
	};

	const restart: AgentTool<any> = {
		name: "job_restart",
		label: "job_restart",
		description: "Restart a background job with a new process identity, preserving lineage.",
		parameters: Type.Object(jobIdSchema),
		effects: processEffects,
		execute: async (_id, params: { jobId: string }) => {
			const rec = await registry.restart(params.jobId);
			if (!rec) return text(`Job ${params.jobId} not found.`);
			return text(`Job ${rec.jobId} restarted: new pid ${rec.processIdentity}, restartCount=${rec.restartCount}.`);
		},
	};

	const adopt: AgentTool<any> = {
		name: "job_adopt",
		label: "job_adopt",
		description:
			"Adopt an existing process as a managed job, only with strong identity evidence (executable, command line, cwd).",
		parameters: Type.Object({
			...jobIdSchema,
			executable: Type.String(),
			commandLine: Type.Optional(Type.String()),
			startTimeMs: Type.Optional(Type.Integer()),
		}),
		effects: processEffects,
		execute: async (
			_id,
			params: { jobId: string; executable: string; commandLine?: string; startTimeMs?: number },
		) => {
			const rec = await registry.adopt(params.jobId, {
				executable: params.executable,
				arguments: [],
				cwd: process.cwd(),
				commandLine: params.commandLine,
				startTimeMs: params.startTimeMs,
			});
			if (!rec) {
				await registry.refuseAdoption(params.jobId);
				return text(`Adoption refused: no matching identity evidence for job ${params.jobId}.`);
			}
			return text(`Job ${rec.jobId} adopted (pid ${rec.processIdentity}).`);
		},
	};

	return [start, status, list, logs, stop, restart, adopt];
}

export type { AgentToolResult };
