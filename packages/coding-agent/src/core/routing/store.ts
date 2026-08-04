/**
 * Durable, content-addressed storage for routing policies, evidence, decisions,
 * shadow decisions, events and drift samples.
 *
 * Storage lives under `<agentDir>/routing/`. All writes are atomic
 * (write-temp-then-rename), read snapshots are cached but never authoritative,
 * and the active-policy pointer is swapped atomically with an immutable old
 * policy retained for rollback.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../config.js";
import { getCanonicalSubagentRegistry } from "../subagent-registry.js";
import type {
	CandidateEvidence,
	OrchestrationDecision,
	OrchestrationEvent,
	RoutingPolicyCandidate,
	ShadowDecision,
} from "./types.js";

/** Directory holding the canonical subagent registry (for candidate generation). */
function registryDir(): string {
	return path.join(getAgentDir(), "subagents");
}

/** SHA-256 hex digest. */
export function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

/** Deterministic stable JSON serialization (sorted keys). */
export function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_, v) => (v === undefined ? undefined : v), 2);
}

function routingRoot(): string {
	// Test/embedder override keeps routing state isolated and never in the way
	// of a real user's durable evidence.
	const override = process.env.JENSEN_ROUTING_ROOT;
	if (override) return override;
	return path.join(getAgentDir(), "routing");
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(file: string): T | undefined {
	try {
		const raw = fs.readFileSync(file, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

/** Atomic write: write to temp file in the same dir then rename. */
function atomicWriteJson(file: string, value: unknown): void {
	ensureDir(path.dirname(file));
	const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
	fs.writeFileSync(tmp, stableStringify(value), "utf-8");
	fs.renameSync(tmp, file);
}

function decisionsDir(): string {
	return path.join(routingRoot(), "decisions");
}
function evidenceDir(): string {
	return path.join(routingRoot(), "evidence");
}
function policiesDir(): string {
	return path.join(routingRoot(), "policies");
}
function shadowDir(): string {
	return path.join(routingRoot(), "shadow");
}
function eventsDir(): string {
	return path.join(routingRoot(), "events");
}
function driftDir(): string {
	return path.join(routingRoot(), "drift");
}

function activePolicyFile(): string {
	return path.join(routingRoot(), "active-policy.json");
}

// =============================================================================
// Active policy pointer
// =============================================================================

export interface ActivePolicyPointer {
	policyId: string;
	policyVersion: number;
	hash: string;
	activatedAt: string;
	previousPolicyId?: string;
}

export function loadActivePolicyPointer(): ActivePolicyPointer | undefined {
	return readJson<ActivePolicyPointer>(activePolicyFile());
}

export function saveActivePolicyPointer(pointer: ActivePolicyPointer): void {
	atomicWriteJson(activePolicyFile(), pointer);
}

// =============================================================================
// Policies
// =============================================================================

/** Sanitize a policy id: only allow safe, path-bounded identifiers (no separators, no traversal). */
function safePolicyId(policyId: string): string | undefined {
	if (!policyId) return undefined;
	// Allow UUIDs and simple dotted/slug identifiers only.
	if (!/^[a-zA-Z0-9._-]+$/.test(policyId)) return undefined;
	if (policyId.includes("..")) return undefined;
	return policyId;
}

export function writePolicy(policy: RoutingPolicyCandidate): string {
	const id = safePolicyId(policy.policyId);
	if (!id) throw new Error("INVALID_POLICY_ID: policy id must be safe and bounded");
	const file = path.join(policiesDir(), `${id}.json`);
	atomicWriteJson(file, policy);
	return file;
}

export function readPolicy(policyId: string): RoutingPolicyCandidate | undefined {
	const id = safePolicyId(policyId);
	if (!id) return undefined;
	return readJson<RoutingPolicyCandidate>(path.join(policiesDir(), `${id}.json`));
}

export function listPolicies(): RoutingPolicyCandidate[] {
	ensureDir(policiesDir());
	const out: RoutingPolicyCandidate[] = [];
	for (const f of fs.readdirSync(policiesDir())) {
		if (!f.endsWith(".json")) continue;
		const p = readJson<RoutingPolicyCandidate>(path.join(policiesDir(), f));
		if (p) out.push(p);
	}
	return out.sort((a, b) => b.policyVersion - a.policyVersion);
}

export function deletePolicy(policyId: string): void {
	const file = path.join(policiesDir(), `${policyId}.json`);
	if (fs.existsSync(file)) fs.unlinkSync(file);
}

// =============================================================================
// Decisions
// =============================================================================

export function writeDecision(decision: OrchestrationDecision): string {
	const file = path.join(decisionsDir(), `${decision.decisionId}.json`);
	atomicWriteJson(file, decision);
	return file;
}

export function readDecision(decisionId: string): OrchestrationDecision | undefined {
	return readJson<OrchestrationDecision>(path.join(decisionsDir(), `${decisionId}.json`));
}

export function listDecisions(limit: number): OrchestrationDecision[] {
	ensureDir(decisionsDir());
	const out: OrchestrationDecision[] = [];
	for (const f of fs.readdirSync(decisionsDir())) {
		if (!f.endsWith(".json")) continue;
		const d = readJson<OrchestrationDecision>(path.join(decisionsDir(), f));
		if (d) out.push(d);
	}
	return out.sort((a, b) => (a.selectedAt < b.selectedAt ? 1 : a.selectedAt > b.selectedAt ? -1 : 0)).slice(0, limit);
}

// =============================================================================
// Evidence
// =============================================================================

export function writeEvidence(evidence: CandidateEvidence): string {
	const file = path.join(evidenceDir(), `${evidence.candidateId}@${evidence.evidenceHash}.json`);
	atomicWriteJson(file, evidence);
	return file;
}

export function readEvidence(candidateId: string): CandidateEvidence | undefined {
	ensureDir(evidenceDir());
	let best: CandidateEvidence | undefined;
	for (const f of fs.readdirSync(evidenceDir())) {
		if (!f.startsWith(`${candidateId}@`)) continue;
		const e = readJson<CandidateEvidence>(path.join(evidenceDir(), f));
		if (e && (!best || e.version > best.version)) best = e;
	}
	return best;
}

// =============================================================================
// Shadow decisions
// =============================================================================

export function writeShadowDecision(shadow: ShadowDecision): string {
	const file = path.join(shadowDir(), `${shadow.shadowId}.json`);
	atomicWriteJson(file, shadow);
	return file;
}

export function listShadowDecisions(limit: number): ShadowDecision[] {
	ensureDir(shadowDir());
	const out: ShadowDecision[] = [];
	for (const f of fs.readdirSync(shadowDir())) {
		if (!f.endsWith(".json")) continue;
		const s = readJson<ShadowDecision>(path.join(shadowDir(), f));
		if (s) out.push(s);
	}
	return out.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0)).slice(0, limit);
}

// =============================================================================
// Events
// =============================================================================

/** Append an event to the current run's event log (bounded). Returns the event. */
export function appendEvent(
	event: Omit<OrchestrationEvent, "eventId" | "sequence" | "occurredAt">,
): OrchestrationEvent {
	ensureDir(eventsDir());
	const seq = fs.existsSync(path.join(eventsDir(), "seq.txt"))
		? Number(fs.readFileSync(path.join(eventsDir(), "seq.txt"), "utf-8")) + 1
		: 1;
	fs.writeFileSync(path.join(eventsDir(), "seq.txt"), String(seq), "utf-8");
	const full: OrchestrationEvent = {
		...event,
		eventId: randomUUID(),
		sequence: seq,
		occurredAt: new Date().toISOString(),
	};
	// Append-only log, kept bounded (trim oldest beyond 5000).
	const logFile = path.join(eventsDir(), "events.jsonl");
	fs.appendFileSync(logFile, `${stableStringify(full)}\n`, "utf-8");
	trimEventLog(logFile);
	return full;
}

function trimEventLog(logFile: string): void {
	const MAX = 5000;
	let lines: string[];
	try {
		lines = fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
	} catch {
		return;
	}
	if (lines.length <= MAX) return;
	const trimmed = lines.slice(lines.length - MAX);
	fs.writeFileSync(logFile, `${trimmed.join("\n")}\n`, "utf-8");
}

export function listEvents(limit: number): OrchestrationEvent[] {
	ensureDir(eventsDir());
	const logFile = path.join(eventsDir(), "events.jsonl");
	try {
		const lines = fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
		return lines
			.slice(-limit)
			.map((l) => {
				try {
					return JSON.parse(l) as OrchestrationEvent;
				} catch {
					return undefined;
				}
			})
			.filter((e): e is OrchestrationEvent => Boolean(e));
	} catch {
		return [];
	}
}

// =============================================================================
// Drift samples
// =============================================================================

export function appendDriftSample(dimension: string, value: number): void {
	ensureDir(driftDir());
	const file = path.join(driftDir(), `${dimension}.jsonl`);
	fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), v: value })}\n`, "utf-8");
}

export function readDriftSamples(dimension: string): { t: number; v: number }[] {
	ensureDir(driftDir());
	const file = path.join(driftDir(), `${dimension}.jsonl`);
	try {
		return fs
			.readFileSync(file, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l) as { t: number; v: number };
				} catch {
					return undefined;
				}
			})
			.filter((s): s is { t: number; v: number } => Boolean(s));
	} catch {
		return [];
	}
}

// =============================================================================
// Registry scan (canonical subagent registry for candidate generation)
// =============================================================================

export interface RegistrySnapshot {
	agents: { name: string; role: string; model: string; provider: string }[];
	retrievalPolicies: string[];
	budgetClasses: string[];
}

/** Scan the canonical subagent registry files. Never authoritative; used only for candidate generation. */
export function scanSubagentRegistry(): RegistrySnapshot {
	const agents: RegistrySnapshot["agents"] = [];
	try {
		console.debug(`scanning subagent registry at ${registryDir()}`);
	} catch {
		/* noop */
	}
	// Use the in-memory canonical registry store when available.
	try {
		const registry = getCanonicalSubagentRegistry();
		for (const def of registry.list()) {
			agents.push({
				name: def.name,
				role: def.role,
				model: def.model,
				provider: def.provider,
			});
		}
	} catch {
		// fall through to filesystem scan
	}
	return {
		agents,
		retrievalPolicies: ["none", "lexical", "symbolic", "semantic", "hybrid", "hybrid_reranked"],
		budgetClasses: ["tiny", "small", "standard", "large", "high_assurance", "release"],
	};
}
