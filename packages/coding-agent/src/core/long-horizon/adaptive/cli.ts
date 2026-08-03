/**
 * Adaptive runtime CLI surfaces.
 *
 * Deterministic, machine-readable diagnostics for the adaptive long-horizon
 * runtime. Follows the existing `jensen <namespace> <command>` dispatch pattern
 * (e.g. `jensen workspace`, `jensen doctor`). Reads durable run state from a
 * bounded on-disk state directory keyed by run id.
 *
 * Surfaces:
 *   jensen run budget <run-id>
 *   jensen run stats <run-id>
 *   jensen run strategies <run-id>
 *   jensen run stalls <run-id>
 *   jensen run criteria <run-id>
 *   jensen run subagents <run-id>
 *   jensen doctor routing
 *   jensen doctor budgets
 *   jensen skills list
 *   jensen skills inspect <name>
 *
 * Never exposes hidden reasoning, secrets, or raw provider credentials.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BudgetLedger } from "./budget-ledger.js";
import { appendEntry, createBudgetLedger, resourcesOfBudget, sumResource } from "./budget-ledger.js";
import { BUILTIN_SKILLS, type BuiltinSkill } from "./builtin-skills.js";
import { createCapabilityRegistry, roleCompatibility } from "./capability-registry.js";
import { deriveRunStatistics } from "./stats.js";
import type { BudgetResource, ModelCapabilities } from "./types.js";

type BudgetLedgerResources = BudgetResource;

export const RUN_STATE_DIR_ENV = "JENSEN_RUN_STATE_DIR";

export function defaultRunStateDir(): string {
	if (process.env[RUN_STATE_DIR_ENV]) return process.env[RUN_STATE_DIR_ENV]!;
	return path.join(os.homedir(), ".local", "state", "jensen", "runs");
}

export function runStatePath(runId: string, kind: string, stateDir: string): string {
	return path.join(stateDir, `${runId}.${kind}.json`);
}

function readLedger(runId: string, stateDir: string): BudgetLedger {
	const p = runStatePath(runId, "ledger", stateDir);
	if (!existsSync(p)) {
		return createBudgetLedger(runId);
	}
	try {
		const parsed = JSON.parse(readFileSync(p, "utf8")) as { entries: unknown[] };
		const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
		let ledger = createBudgetLedger(runId);
		for (const raw of entries) {
			ledger = pushLedgerEntry(ledger, raw as never);
		}
		return ledger;
	} catch {
		return createBudgetLedger(runId);
	}
}

function pushLedgerEntry(
	ledger: BudgetLedger,
	e: {
		entryId?: string;
		runId?: string;
		phaseId?: string;
		role?: string;
		resource?: string;
		amount?: number;
		estimatedOrActual?: "estimated" | "actual";
		provider?: string;
		model?: string;
		sourceEventId?: string;
		recordedAt?: string;
	},
): BudgetLedger {
	const resource = e.resource as BudgetLedgerResources;
	const out = appendEntry(ledger, {
		entryId: e.entryId ?? "",
		runId: e.runId ?? "",
		phaseId: e.phaseId,
		role: e.role,
		resource,
		amount: e.amount ?? 0,
		estimatedOrActual: e.estimatedOrActual ?? "estimated",
		provider: e.provider,
		model: e.model,
		sourceEventId: e.sourceEventId ?? "",
		recordedAt: e.recordedAt ?? "",
	});
	return out.ledger;
}

function json(v: unknown): string {
	return JSON.stringify(v, null, 2);
}

function usage(namespace: string, subcommands: string[]): string {
	return [`Usage: jensen ${namespace} <command> [args]`, "", "Commands:", ...subcommands.map((s) => `  ${s}`)].join(
		"\n",
	);
}

export async function handleAdaptiveCommand(args: string[]): Promise<boolean> {
	const root = args[0];
	if (root === "run") {
		return handleRunCommand(args.slice(1));
	}
	if (root === "doctor") {
		return handleDoctorCommand(args.slice(1));
	}
	if (root === "skills") {
		return handleSkillsCommand(args.slice(1));
	}
	return false;
}

async function handleRunCommand(args: string[]): Promise<boolean> {
	const sub = args[0];
	if (!["budget", "stats", "strategies", "stalls", "criteria", "subagents"].includes(sub)) return false;
	const runId = args[1];
	if (!runId) {
		console.error(
			usage("run", [
				"budget <run-id>",
				"stats <run-id>",
				"strategies <run-id>",
				"stalls <run-id>",
				"criteria <run-id>",
				"subagents <run-id>",
			]),
		);
		return true;
	}
	const stateDir = defaultRunStateDir();
	const ledger = readLedger(runId, stateDir);
	if (sub === "budget") {
		const usageMap: Record<string, number> = {};
		for (const resource of resourcesOfBudget()) {
			usageMap[resource] = sumResource(ledger, resource);
		}
		console.log(
			json({
				runId,
				ledgerEntries: ledger.entries.length,
				usage: usageMap,
				note: "estimated/actual reconciled in ledger; prices effective-date tagged",
			}),
		);
	} else if (sub === "stats") {
		console.log(json(deriveRunStatistics({ runId, ledger })));
	} else if (sub === "strategies") {
		console.log(json({ runId, strategies: readList(runId, "strategies", stateDir) }));
	} else if (sub === "stalls") {
		console.log(json({ runId, stalls: readList(runId, "stalls", stateDir) }));
	} else if (sub === "criteria") {
		console.log(json({ runId, criteria: readList(runId, "criteria", stateDir) }));
	} else if (sub === "subagents") {
		console.log(json({ runId, subagents: readList(runId, "subagents", stateDir) }));
	}
	return true;
}

function readList(runId: string, kind: string, stateDir: string): unknown[] {
	const p = runStatePath(runId, kind, stateDir);
	if (!existsSync(p)) return [];
	try {
		const parsed = JSON.parse(readFileSync(p, "utf8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function handleDoctorCommand(args: string[]): Promise<boolean> {
	const sub = args[0];
	if (sub === "routing") {
		const registry = createCapabilityRegistry(DEFAULT_PROFILES.map(profileFor));
		const models = registry.profiles.map((p) => ({
			provider: p.provider,
			model: p.model,
			executor: roleCompatibility(p, ["supportsTools", "supportsCodeGeneration"]).compatible,
			reviewer: roleCompatibility(p, ["supportsCodeReview"]).compatible,
			cheapSummarizer: p.supportsCheapSummarization === true,
		}));
		console.log(json({ routing: models, invariant: "MODEL_ROUTING_IS_POLICY_CONSTRAINED" }));
		return true;
	}
	if (sub === "budgets") {
		console.log(
			json({
				invariants: [
					"BUDGETS_ARE_DURABLE_AND_AUTHORITATIVE",
					"HARD_LIMITS_CANNOT_BE_OVERRIDDEN_BY_MODELS",
					"FINALIZATION_RESERVE_CANNOT_BE_SPENT_EARLY",
				],
				thresholds: "soft/hard/finalizationReserve applied per resource",
			}),
		);
		return true;
	}
	return false;
}

async function handleSkillsCommand(args: string[]): Promise<boolean> {
	const sub = args[0];
	if (sub === "list") {
		console.log(
			json(
				BUILTIN_SKILLS.map((s) => ({
					name: s.name,
					version: s.version,
					description: s.description,
					mode: s.executionMode,
				})),
			),
		);
		return true;
	}
	if (sub === "inspect") {
		const name = args[1];
		const skill = BUILTIN_SKILLS.find((s) => s.name === name);
		if (!skill) {
			console.error(`Unknown skill: ${name}`);
			return true;
		}
		console.log(json(skill));
		return true;
	}
	return false;
}

function profileFor(m: ModelCapabilities): ModelCapabilities {
	return m;
}

/** Static read-only default capability profiles used only for diagnostics. */
const DEFAULT_PROFILES: ModelCapabilities[] = [
	{
		provider: "static",
		model: "executor",
		supportsTools: true,
		supportsParallelTools: true,
		supportsStructuredOutput: true,
		supportsVision: false,
		supportsPromptCaching: true,
		supportsReasoningEffort: true,
		supportsStreamingToolCalls: true,
		supportsReliableLongContext: true,
		supportsCodeGeneration: true,
		supportsCodeReview: false,
		supportsResearchSynthesis: false,
		supportsCheapSummarization: false,
		supportsToolCallRepair: true,
		pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: "usd", effectiveAt: "2026-01-01" },
	},
	{
		provider: "static",
		model: "reviewer",
		supportsTools: true,
		supportsParallelTools: false,
		supportsStructuredOutput: true,
		supportsVision: false,
		supportsPromptCaching: true,
		supportsReasoningEffort: true,
		supportsStreamingToolCalls: true,
		supportsReliableLongContext: true,
		supportsCodeGeneration: false,
		supportsCodeReview: true,
		supportsResearchSynthesis: false,
		supportsCheapSummarization: false,
		supportsToolCallRepair: false,
		pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: "usd", effectiveAt: "2026-01-01" },
	},
	{
		provider: "static",
		model: "cheap-sum",
		supportsTools: "unknown",
		supportsParallelTools: "unknown",
		supportsStructuredOutput: "unknown",
		supportsVision: "unknown",
		supportsPromptCaching: true,
		supportsReasoningEffort: "unknown",
		supportsStreamingToolCalls: "unknown",
		supportsReliableLongContext: "unknown",
		supportsCodeGeneration: false,
		supportsCodeReview: false,
		supportsResearchSynthesis: false,
		supportsCheapSummarization: true,
		supportsToolCallRepair: false,
		pricing: { inputPerMillion: 0.2, outputPerMillion: 0.6, currency: "usd", effectiveAt: "2026-01-01" },
	},
];

export { BUILTIN_SKILLS };
export type { BuiltinSkill };

/** Ensure the run-state directory exists (used by tests and tooling). */
export function ensureRunStateDir(stateDir: string): string {
	mkdirSync(stateDir, { recursive: true });
	return stateDir;
}
