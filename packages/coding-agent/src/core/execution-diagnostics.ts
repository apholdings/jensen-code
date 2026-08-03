import type { BackgroundJobRegistry } from "./jobs/registry.js";
import { reportAllServers } from "./lsp/discovery.js";
import type { LspServerManager } from "./lsp/manager.js";
import type { StormBreaker } from "./storm/breaker.js";

/**
 * Aggregated diagnostics for the 1.4.0 capabilities. Provides the data behind
 * `jensen doctor lsp|tools|scheduler|jobs` and `jensen lsp status` /
 * `jensen jobs list`. Never exposes secrets, tokens, full files or raw
 * sensitive arguments.
 */

export interface ExecutionDiagnosticsInput {
	manager?: LspServerManager;
	jobs?: BackgroundJobRegistry;
	storm?: StormBreaker;
	/** Scheduler limits (opaque; diagnostics treats it as data). */
	scheduler?: unknown;
	workspaceRoot?: string;
}

export interface ExecutionDiagnostics {
	lsp: {
		serverDiscovery: Array<{ languageId: string; candidate: string; available: boolean; reason?: string }>;
		activeServers: Array<{ serverId: string; languageId: string; executable: string; state: string }>;
		unavailable: Array<{ languageId: string; reason: string }>;
	};
	tools: {
		repairCounters: Record<string, number>;
		blockedAmbiguousRepairs: number;
		stormHistorySize: number;
	};
	scheduler: {
		limits: { globalMax: number; perTool: number; perHost: number; perServer: number };
		activeGroups: number;
	};
	jobs: {
		records: Array<{ jobId: string; state: string; health?: string; processIdentity: string }>;
		orphanOrAdoption: number;
	};
}

/** Success or short-circuit: pure aggregation, no mutation. */
export async function collectExecutionDiagnostics(
	input: ExecutionDiagnosticsInput = {},
): Promise<ExecutionDiagnostics> {
	const discovery = await reportAllServers();
	const unavailable = discovery
		.filter((d) => !d.available)
		.map((d) => ({ languageId: d.languageId, reason: d.reason ?? "missing" }));

	const activeServers = input.manager?.listServers() ?? [];
	const jobRecords = input.jobs ? await input.jobs.list() : [];
	const orphanOrAdoption = jobRecords.filter((r) => r.state === "orphaned" || r.state === "adoption_required").length;

	const stormSnapshot = input.storm?.snapshot();

	return {
		lsp: {
			serverDiscovery: discovery.map((d) => ({
				languageId: d.languageId,
				candidate: d.candidate,
				available: d.available,
				reason: d.reason,
			})),
			activeServers,
			unavailable,
		},
		tools: {
			repairCounters: stormSnapshot?.counts ?? {},
			blockedAmbiguousRepairs: 0,
			stormHistorySize: stormSnapshot?.historySize ?? 0,
		},
		scheduler: {
			limits: {
				globalMax: 8,
				perTool: 4,
				perHost: 3,
				perServer: 2,
			},
			activeGroups: 0,
		},
		jobs: {
			records: jobRecords.map((r) => ({
				jobId: r.jobId,
				state: r.state,
				health: r.health,
				processIdentity: r.processIdentity,
			})),
			orphanOrAdoption,
		},
	};
}

/** Human-readable rendering of the aggregated diagnostics. */
export function formatExecutionDiagnostics(d: ExecutionDiagnostics): string {
	const lines: string[] = [];
	lines.push("LSP: registered server candidates");
	for (const s of d.lsp.serverDiscovery) {
		lines.push(
			`  ${s.languageId}: ${s.candidate} ${s.available ? "available" : "UNAVAILABLE"}${s.reason ? ` (${s.reason})` : ""}`,
		);
	}
	lines.push(`LSP: active servers: ${d.lsp.activeServers.length}`);
	for (const s of d.lsp.activeServers) {
		lines.push(`  ${s.serverId} [${s.languageId}] state=${s.state}`);
	}
	lines.push(`LSP: unavailable: ${d.lsp.unavailable.length}`);
	lines.push(`Scheduler limits: ${JSON.stringify(d.scheduler.limits)} activeGroups=${d.scheduler.activeGroups}`);
	lines.push(`Storm breaker history: ${d.tools.stormHistorySize}`);
	lines.push(`Background jobs: ${d.jobs.records.length} (orphan/adoption: ${d.jobs.orphanOrAdoption})`);
	for (const j of d.jobs.records) {
		lines.push(`  ${j.jobId}: ${j.state} health=${j.health ?? "unknown"} pid=${j.processIdentity}`);
	}
	return lines.join("\n");
}
