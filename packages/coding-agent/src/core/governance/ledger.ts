import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import type {
	GovernanceBudgetUsage,
	GovernanceConsumeRequest,
	GovernanceConsumeResult,
	GovernanceCorrelation,
	GovernanceDecision,
	GovernanceEscalationRecord,
	GovernanceEvent,
	GovernanceLedger,
	GovernanceRetryClass,
	GovernanceStore,
} from "./types.js";
import { GOVERNANCE_DECISION_HISTORY_LIMIT } from "./types.js";
import { validateGovernanceLedger } from "./validation.js";

const SAFE_MISSION_ID = /^[A-Za-z0-9._-]+$/u;

export function isSafeGovernanceMissionId(missionId: string): boolean {
	return SAFE_MISSION_ID.test(missionId) && missionId !== "." && missionId !== ".." && missionId.length <= 256;
}

export function defaultGovernanceRoot(): string {
	return process.env.JENSEN_GOVERNANCE_DIR?.trim() || path.join(os.homedir(), ".jensen", "governance");
}
export function createGovernanceLedger(missionId: string, parentMissionId?: string): GovernanceLedger {
	return {
		schemaVersion: 1,
		missionId,
		parentMissionId,
		revision: 0,
		usage: {
			turns: 0,
			contextTokens: 0,
			generatedTokens: 0,
			toolCalls: 0,
			retries: 0,
			wallClockMs: 0,
			inferenceRequests: 0,
			children: 0,
			logicalAgents: 0,
			totalRetries: 0,
			replans: 0,
			fanOut: 0,
			depth: 0,
			readyChildren: 0,
			cloudSpendUsd: 0,
			modelEscalations: 0,
		},
		retries: { tool: 0, output_contract: 0, execution: 0, planner: 0, replan: 0, remote_execution: 0, provider: 0 },
		cost: { status: "NONE", knownUsd: 0, unknownPaidEvents: 0, localInferenceRequests: 0 },
		escalationHistory: [],
		decisionHistory: [],
		events: [],
	};
}
const USAGE_KEYS = new Set<keyof GovernanceBudgetUsage>([
	"turns",
	"contextTokens",
	"generatedTokens",
	"toolCalls",
	"retries",
	"wallClockMs",
	"inferenceRequests",
	"children",
	"logicalAgents",
	"totalRetries",
	"replans",
	"fanOut",
	"depth",
	"readyChildren",
	"cloudSpendUsd",
	"modelEscalations",
]);
function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
export function consumeGovernanceInternal(
	ledger: GovernanceLedger,
	request: GovernanceConsumeRequest,
): GovernanceConsumeResult {
	if (!request.eventId.trim() || !USAGE_KEYS.has(request.resource))
		return { allowed: false, reason: "INVALID_CONSUMPTION", ledger };
	if (!Number.isFinite(request.amount) || request.amount < 0)
		return { allowed: false, reason: "INVALID_AMOUNT", ledger };
	if (ledger.events.some((event) => event.eventId === request.eventId)) return { allowed: true, ledger };
	const next = clone(ledger);
	const event: GovernanceEvent = {
		eventId: request.eventId,
		scope: request.scope,
		kind: "consume",
		resource: request.resource,
		amount: request.amount,
		provider: request.provider,
		model: request.model,
		costStatus: request.costStatus,
		costUsd: request.costUsd,
		childId: request.childId,
		correlation: request.correlation,
		atMs: request.atMs,
	};
	next.usage[request.resource] += request.amount;
	if (request.costStatus === "UNKNOWN" && request.provider && request.costUsd === undefined) {
		next.cost.unknownPaidEvents += 1;
		next.cost.status = "UNKNOWN";
	} else if (request.costUsd !== undefined && request.costUsd >= 0) {
		next.cost.knownUsd += request.costUsd;
		next.usage.cloudSpendUsd += request.costUsd;
		next.cost.status = "KNOWN";
	} else if (request.provider?.startsWith("llamacpp-")) {
		next.cost.localInferenceRequests += request.amount;
		next.cost.status = next.cost.unknownPaidEvents > 0 ? "UNKNOWN" : "NONE";
	}
	next.events.push(event);
	next.revision += 1;
	return { allowed: true, ledger: next };
}
export function recordGovernanceRetry(
	ledger: GovernanceLedger,
	eventId: string,
	retryClass: GovernanceRetryClass,
	atMs: number,
	correlation?: GovernanceCorrelation,
): GovernanceLedger {
	if (ledger.events.some((event) => event.eventId === eventId)) return ledger;
	const next = clone(ledger);
	next.retries[retryClass] += 1;
	next.usage.retries += 1;
	next.usage.totalRetries += 1;
	next.events.push({ eventId, scope: "orchestration", kind: "retry", retryClass, correlation, atMs });
	next.revision += 1;
	return next;
}

export function recordGovernanceDecision(
	ledger: GovernanceLedger,
	eventId: string,
	decision: GovernanceDecision,
): GovernanceLedger {
	if (ledger.events.some((event) => event.eventId === eventId)) return ledger;
	const next = clone(ledger);
	next.lastDecision = decision;
	next.decisionHistory = [...next.decisionHistory, decision].slice(-GOVERNANCE_DECISION_HISTORY_LIMIT);
	next.events.push({ eventId, scope: "session", kind: "decision", reason: decision.reason, atMs: decision.atMs });
	next.revision += 1;
	return next;
}

export function recordGovernanceEscalation(
	ledger: GovernanceLedger,
	eventId: string,
	record: GovernanceEscalationRecord,
): GovernanceLedger {
	if (ledger.events.some((event) => event.eventId === eventId)) return ledger;
	const next = clone(ledger);
	next.escalationHistory.push(record);
	next.usage.modelEscalations += 1;
	next.events.push({
		eventId,
		scope: "orchestration",
		kind: "escalation",
		provider: record.to.provider,
		model: record.to.model,
		reason: record.reason,
		atMs: record.atMs,
	});
	next.revision += 1;
	return next;
}
export class FileGovernanceStore implements GovernanceStore {
	readonly storeId: string;
	private readonly root: string;
	constructor(options: { root?: string; storeId?: string } = {}) {
		this.root = path.resolve(options.root ?? defaultGovernanceRoot());
		this.storeId = options.storeId ?? "file";
	}
	private file(missionId: string): string {
		if (!isSafeGovernanceMissionId(missionId)) throw new Error(`UNSAFE_GOVERNANCE_MISSION_ID:${missionId}`);
		return path.join(this.root, `${missionId}.json`);
	}
	private async locked<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
		await fsp.mkdir(this.root, { recursive: true });
		const release = await lockfile.lock(this.file(missionId), {
			realpath: false,
			stale: 30_000,
			retries: { retries: 8, minTimeout: 20, maxTimeout: 250, factor: 2, randomize: true },
		});
		try {
			return await fn();
		} finally {
			await release().catch(() => undefined);
		}
	}
	private async read(
		missionId: string,
	): Promise<
		{ status: "ok"; ledger: GovernanceLedger } | { status: "missing" } | { status: "corrupt"; diagnostic: string }
	> {
		try {
			const parsed = JSON.parse(await fsp.readFile(this.file(missionId), "utf8")) as GovernanceLedger;
			const validation = validateGovernanceLedger(parsed, missionId);
			if (!validation.valid) return { status: "corrupt", diagnostic: validation.diagnostic };
			return { status: "ok", ledger: validation.ledger };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
			return { status: "corrupt", diagnostic: error instanceof Error ? error.message : String(error) };
		}
	}
	private async write(ledger: GovernanceLedger): Promise<void> {
		const target = this.file(ledger.missionId);
		const tmp = `${target}.${randomUUID()}.tmp`;
		const handle = await fsp.open(tmp, "w");
		try {
			await handle.writeFile(JSON.stringify(ledger, null, 2), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fsp.rename(tmp, target);
	}
	async create(ledger: GovernanceLedger): Promise<"created" | "idempotent" | "conflict"> {
		return this.locked(ledger.missionId, async () => {
			const existing = await this.read(ledger.missionId);
			if (existing.status === "ok")
				return JSON.stringify(existing.ledger) === JSON.stringify(ledger) ? "idempotent" : "conflict";
			if (existing.status === "corrupt") return "conflict";
			await this.write(ledger);
			return "created";
		});
	}
	async load(missionId: string) {
		return this.read(missionId);
	}
	async mutate<T>(
		missionId: string,
		mutation: (
			ledger: GovernanceLedger,
		) => { kind: "write"; ledger: GovernanceLedger; value: T } | { kind: "noop"; value: T },
	) {
		return this.locked(missionId, async () => {
			const current = await this.read(missionId);
			if (current.status !== "ok")
				return current.status === "missing"
					? current
					: { status: "corrupt" as const, diagnostic: current.diagnostic };
			const output = mutation(current.ledger);
			if (output.kind === "write") {
				const validation = validateGovernanceLedger(output.ledger, missionId);
				if (!validation.valid) throw new Error(`INVALID_GOVERNANCE_MUTATION:${validation.diagnostic}`);
				if (output.ledger.revision < current.ledger.revision) throw new Error("GOVERNANCE_REVISION_REGRESSION");
				await this.write(output.ledger);
			}
			return { status: "ok" as const, value: output.value };
		});
	}
}
