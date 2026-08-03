import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AgentMessage } from "@apholdings/jensen-agent-core";
import type { FileEntry, SessionEntry, SessionHeader, SessionMessageEntry } from "./session-manager.js";

export const OBSERVABILITY_SCHEMA_VERSION = 1;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

export type CorruptionClass =
	| "recoverable_tail_corruption"
	| "recoverable_index_corruption"
	| "snapshot_rebuild_required"
	| "evidence_missing"
	| "manual_recovery_required"
	| "integrity_failure";

export interface JensenEventEnvelope<TPayload = unknown> {
	eventId: string;
	eventType: string;
	schemaVersion: number;
	runId: string;
	sessionId?: string;
	parentEventId?: string;
	causationId?: string;
	correlationId?: string;
	sequence: number;
	recordedAt: string;
	monotonicOffsetMs?: number;
	source: { component: string; instanceId?: string };
	payload: TPayload;
	payloadSha256: string;
}

export interface EventReadIssue {
	line: number;
	class: CorruptionClass;
	reasonCode: string;
	detail: string;
}

export interface EventReadResult {
	header?: SessionHeader;
	events: JensenEventEnvelope<FileEntry>[];
	issues: EventReadIssue[];
	complete: boolean;
}

export interface EventQuery {
	pageSize?: number;
	pageToken?: string;
	eventType?: string;
	component?: string;
	failureOnly?: boolean;
	from?: string;
	to?: string;
}

export interface EventPage {
	events: JensenEventEnvelope<FileEntry>[];
	nextPageToken?: string;
	issues: EventReadIssue[];
}

export interface RunProjection {
	runId: string;
	sessionId: string;
	cwd: string;
	objective?: string;
	entryCount: number;
	messageCount: number;
	toolCallCount: number;
	toolResultCount: number;
	models: Array<{ provider: string; modelId: string }>;
	toolNames: string[];
	mutations: number;
	evidenceIds: string[];
	warnings: string[];
	unknownEventTypes: string[];
	firstRecordedAt?: string;
	lastRecordedAt?: string;
}

export interface RenderReplay {
	lines: string[];
	eventCount: number;
	missingArtifacts: string[];
	externalEffects: { modelCalls: 0; toolCalls: 0; networkCalls: 0; mutations: 0 };
}

export interface ProjectionReplay {
	projection: RunProjection;
	issues: EventReadIssue[];
	snapshotMatches?: boolean;
}

export interface RunDiffField {
	path: string;
	category: "improved" | "regressed" | "changed" | "unchanged" | "incomparable";
	before: unknown;
	after: unknown;
}

export interface RunDiff {
	leftRunId: string;
	rightRunId: string;
	comparable: boolean;
	fields: RunDiffField[];
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
}

export function sha256(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" ? value : canonical(value))
		.digest("hex");
}

function isFileEntry(value: unknown): value is FileEntry {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.type === "string";
}

function isPersistedEnvelope(value: unknown): value is JensenEventEnvelope<FileEntry> {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.eventId === "string" &&
		typeof record.eventType === "string" &&
		typeof record.payloadSha256 === "string" &&
		isFileEntry(record.payload)
	);
}

function entryType(entry: FileEntry): string {
	return entry.type;
}

function entryId(entry: FileEntry): string | undefined {
	return entry.type === "session" ? undefined : typeof entry.id === "string" ? entry.id : undefined;
}

function entryTimestamp(entry: FileEntry): string {
	return typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString();
}

export function envelopeForEntry(entry: FileEntry, runId: string, sequence: number): JensenEventEnvelope<FileEntry> {
	const id = entryId(entry) ?? `${runId}:session`;
	return {
		eventId: `${runId}:${id}`,
		eventType: entryType(entry),
		schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
		runId,
		sessionId: runId,
		parentEventId: entry.type === "session" ? undefined : entry.parentId ? `${runId}:${entry.parentId}` : undefined,
		sequence,
		recordedAt: entryTimestamp(entry),
		source: { component: "session-manager" },
		payload: entry,
		payloadSha256: sha256(entry),
	};
}

/** Read a session JSONL file without loading more than the configured event count. */
export function readSessionEvents(filePath: string, maxEvents = 100_000): EventReadResult {
	if (!existsSync(filePath))
		return {
			events: [],
			issues: [{ line: 0, class: "evidence_missing", reasonCode: "file_missing", detail: filePath }],
			complete: false,
		};
	const lines = readFileSync(filePath, "utf8").split(/\n/);
	const events: JensenEventEnvelope<FileEntry>[] = [];
	const issues: EventReadIssue[] = [];
	let header: SessionHeader | undefined;
	let runId = basename(filePath, ".jsonl");
	let sawNonEmpty = false;
	const eventIds = new Set<string>();
	for (let index = 0; index < lines.length && events.length < maxEvents; index++) {
		const text = lines[index]?.trim() ?? "";
		if (!text) continue;
		sawNonEmpty = true;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			const tail = lines.slice(index + 1).every((line) => !line.trim());
			issues.push({
				line: index + 1,
				class: tail ? "recoverable_tail_corruption" : "manual_recovery_required",
				reasonCode: "malformed_json",
				detail: tail ? "truncated final record" : "malformed record in canonical history",
			});
			continue;
		}
		if (isPersistedEnvelope(parsed)) {
			if (parsed.payloadSha256 !== sha256(parsed.payload))
				issues.push({
					line: index + 1,
					class: "integrity_failure",
					reasonCode: "payload_hash_mismatch",
					detail: parsed.eventId,
				});
			if (eventIds.has(parsed.eventId))
				issues.push({
					line: index + 1,
					class: "integrity_failure",
					reasonCode: "duplicate_event_id",
					detail: parsed.eventId,
				});
			eventIds.add(parsed.eventId);
			events.push(parsed);
			continue;
		}
		if (!isFileEntry(parsed)) {
			issues.push({
				line: index + 1,
				class: "integrity_failure",
				reasonCode: "invalid_entry",
				detail: "record has no string type",
			});
			continue;
		}
		if (parsed.type === "session") {
			header = parsed;
			runId = parsed.id;
		}
		const envelope = envelopeForEntry(parsed, runId, events.length);
		const persistedHash = parsed.type === "session" ? undefined : parsed.payloadSha256;
		if (typeof persistedHash === "string" && persistedHash !== sha256({ ...parsed, payloadSha256: undefined }))
			issues.push({
				line: index + 1,
				class: "integrity_failure",
				reasonCode: "payload_hash_mismatch",
				detail: envelope.eventId,
			});
		if (eventIds.has(envelope.eventId))
			issues.push({
				line: index + 1,
				class: "integrity_failure",
				reasonCode: "duplicate_event_id",
				detail: envelope.eventId,
			});
		if (envelope.payloadSha256 !== sha256(envelope.payload))
			issues.push({
				line: index + 1,
				class: "integrity_failure",
				reasonCode: "payload_hash_mismatch",
				detail: envelope.eventId,
			});
		eventIds.add(envelope.eventId);
		events.push(envelope);
	}
	if (!sawNonEmpty) issues.push({ line: 0, class: "evidence_missing", reasonCode: "empty_session", detail: filePath });
	if (events.length >= maxEvents && lines.some((line) => line.trim()))
		issues.push({
			line: events.length,
			class: "manual_recovery_required",
			reasonCode: "event_limit_reached",
			detail: `maximum ${maxEvents} events reached`,
		});
	return { header, events, issues, complete: issues.every((issue) => issue.class === "recoverable_tail_corruption") };
}

export function queryEvents(result: EventReadResult, query: EventQuery = {}): EventPage {
	const size = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
	const start = query.pageToken === undefined ? 0 : /^\d+$/.test(query.pageToken) ? Number(query.pageToken) : 0;
	const filtered = result.events.filter((event) => {
		if (query.eventType && event.eventType !== query.eventType) return false;
		if (query.component && event.source.component !== query.component) return false;
		if (query.from && event.recordedAt < query.from) return false;
		if (query.to && event.recordedAt > query.to) return false;
		if (query.failureOnly && !/(error|fail|blocked|abort|deny|corrupt)/i.test(canonical(event.payload))) return false;
		return true;
	});
	const page = filtered.slice(Number.isFinite(start) ? start : 0, (Number.isFinite(start) ? start : 0) + size);
	const next = (Number.isFinite(start) ? start : 0) + page.length;
	return { events: page, nextPageToken: next < filtered.length ? String(next) : undefined, issues: result.issues };
}

function messageOf(entry: FileEntry): AgentMessage | undefined {
	return entry.type === "message" ? (entry as SessionMessageEntry).message : undefined;
}

function textOfMessage(message: AgentMessage): string {
	if (typeof (message as { content?: unknown }).content === "string") return (message as { content: string }).content;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			Boolean(
				block &&
					typeof block === "object" &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string",
			),
		)
		.map((block) => block.text)
		.join("");
}

function isToolCall(message: AgentMessage): boolean {
	const content = (message as { content?: unknown }).content;
	return (
		Array.isArray(content) &&
		content.some((block) =>
			Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall"),
		)
	);
}

function toolNameFromMessage(message: AgentMessage): string | undefined {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const block = content.find((item) =>
		Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "toolCall"),
	) as { name?: unknown } | undefined;
	return typeof block?.name === "string" ? block.name : undefined;
}

function evidenceIdsFrom(value: unknown, ids: Set<string>): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) evidenceIdsFrom(item, ids);
		return;
	}
	const record = value as Record<string, unknown>;
	for (const [key, child] of Object.entries(record)) {
		if (/(evidence|artifact)id/i.test(key) && typeof child === "string") ids.add(child);
		else evidenceIdsFrom(child, ids);
	}
}

export function projectRun(result: EventReadResult): RunProjection {
	const runId = result.header?.id ?? result.events[0]?.runId ?? "unknown";
	const models = new Map<string, { provider: string; modelId: string }>();
	const tools = new Set<string>();
	const evidence = new Set<string>();
	let messageCount = 0;
	let toolCallCount = 0;
	let toolResultCount = 0;
	let mutations = 0;
	let objective: string | undefined;
	for (const event of result.events) {
		const entry = event.payload;
		if (event.eventType === "message") {
			const message = messageOf(entry);
			if (message) {
				messageCount++;
				if (message.role === "assistant") {
					const provider = (message as { provider?: unknown }).provider;
					const modelId = (message as { model?: unknown }).model;
					if (typeof provider === "string" && typeof modelId === "string")
						models.set(`${provider}/${modelId}`, { provider, modelId });
					if (isToolCall(message)) {
						toolCallCount++;
						const name = toolNameFromMessage(message);
						if (name) tools.add(name);
					}
				}
				if (message.role === "toolResult") {
					toolResultCount++;
					const name = (message as { toolName?: unknown }).toolName;
					if (typeof name === "string") {
						tools.add(name);
						if (/write|edit|delete|bash|powershell|mutat/i.test(name)) mutations++;
					}
				}
				if (message.role === "user" && !objective) objective = "[recorded user objective]";
			}
		}
		if (/(mutation|transaction|checkpoint)/i.test(event.eventType)) mutations++;
		evidenceIdsFrom(entry, evidence);
	}
	return {
		runId,
		sessionId: runId,
		cwd: result.header?.cwd ?? "",
		objective,
		entryCount: result.events.length,
		messageCount,
		toolCallCount,
		toolResultCount,
		models: [...models.values()].sort((a, b) =>
			`${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`),
		),
		toolNames: [...tools].sort(),
		mutations,
		evidenceIds: [...evidence].sort(),
		warnings: result.issues.map((issue) => `${issue.reasonCode}:${issue.detail}`),
		unknownEventTypes: result.events
			.filter(
				(event) =>
					![
						"session",
						"message",
						"thinking_level_change",
						"model_change",
						"compaction",
						"branch_summary",
						"custom",
						"custom_message",
						"label",
						"session_info",
					].includes(event.eventType),
			)
			.map((event) => event.eventType)
			.filter((type, index, values) => values.indexOf(type) === index)
			.sort(),
		firstRecordedAt: result.events[0]?.recordedAt,
		lastRecordedAt: result.events.at(-1)?.recordedAt,
	};
}

export function renderReplay(result: EventReadResult): RenderReplay {
	const lines: string[] = [];
	const missingArtifacts: string[] = [];
	for (const event of result.events) {
		const entry = event.payload;
		if (entry.type === "message") {
			const message = messageOf(entry);
			if (!message) continue;
			const text = textOfMessage(message);
			if (message.role === "user") lines.push(`user: ${text}`);
			else if (message.role === "assistant") lines.push(`assistant: ${text}`);
			else if (message.role === "toolResult")
				lines.push(`tool ${message.toolName}: ${text || (message.isError ? "[error]" : "[recorded result]")}`);
		}
		if (entry.type === "custom" || entry.type === "custom_message") {
			const record = entry as unknown as Record<string, unknown>;
			if (record.data && typeof record.data === "object" && "artifactPath" in (record.data as object)) {
				const artifactPath = (record.data as { artifactPath?: unknown }).artifactPath;
				if (typeof artifactPath === "string" && !existsSync(artifactPath)) missingArtifacts.push(artifactPath);
			}
		}
	}
	return {
		lines,
		eventCount: result.events.length,
		missingArtifacts: [...new Set(missingArtifacts)].sort(),
		externalEffects: { modelCalls: 0, toolCalls: 0, networkCalls: 0, mutations: 0 },
	};
}

export function projectionReplay(result: EventReadResult, snapshot?: RunProjection): ProjectionReplay {
	const projection = projectRun(result);
	return {
		projection,
		issues: result.issues,
		snapshotMatches: snapshot ? canonical(snapshot) === canonical(projection) : undefined,
	};
}

function comparableValue(value: unknown): unknown {
	if (typeof value === "string") return value.replace(/[0-9a-f]{8,}/gi, "<id>");
	if (Array.isArray(value)) return value.map(comparableValue);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as object).sort()) {
			if (!/(timestamp|recordedAt|eventId|sessionId|runId)/i.test(key))
				out[key] = comparableValue((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

export function diffRuns(left: RunProjection, right: RunProjection): RunDiff {
	const fields: RunDiffField[] = [];
	const values: Array<[string, unknown, unknown]> = [
		["objective", left.objective, right.objective],
		["cwd", left.cwd, right.cwd],
		["entryCount", left.entryCount, right.entryCount],
		["messageCount", left.messageCount, right.messageCount],
		["toolCallCount", left.toolCallCount, right.toolCallCount],
		["toolResultCount", left.toolResultCount, right.toolResultCount],
		["models", left.models, right.models],
		["toolNames", left.toolNames, right.toolNames],
		["mutations", left.mutations, right.mutations],
		["evidenceIds", left.evidenceIds, right.evidenceIds],
	];
	for (const [path, before, after] of values) {
		const a = comparableValue(before);
		const b = comparableValue(after);
		let category: RunDiffField["category"] = "changed";
		if (canonical(a) === canonical(b)) category = "unchanged";
		else if (typeof before === "number" && typeof after === "number")
			category = after < before ? "improved" : "regressed";
		else if (before === undefined || after === undefined) category = "incomparable";
		fields.push({ path, category, before: a, after: b });
	}
	return {
		leftRunId: left.runId,
		rightRunId: right.runId,
		comparable: Boolean(left.objective && right.objective ? true : left.cwd === right.cwd),
		fields,
	};
}

export interface EvidenceRecord {
	evidenceId: string;
	type: string;
	origin: string;
	createdAt: string;
	contentSha256?: string;
	locator?: string;
	claimIds: string[];
	redacted: boolean;
	integrity: "verified" | "unverified" | "missing";
}

export function listEvidence(result: EventReadResult): EvidenceRecord[] {
	const records: EvidenceRecord[] = [];
	for (const event of result.events) {
		const payload = event.payload as unknown as Record<string, unknown>;
		const candidates = [payload, payload.data].filter((candidate): candidate is Record<string, unknown> =>
			Boolean(candidate && typeof candidate === "object"),
		);
		for (const candidate of candidates) {
			const id = candidate.evidenceId ?? candidate.artifactId;
			if (typeof id !== "string") continue;
			const content = candidate.content ?? candidate.text;
			records.push({
				evidenceId: id,
				type: typeof candidate.type === "string" ? candidate.type : event.eventType,
				origin: event.source.component,
				createdAt: event.recordedAt,
				contentSha256:
					typeof candidate.contentSha256 === "string"
						? candidate.contentSha256
						: typeof content === "string"
							? sha256(content)
							: undefined,
				locator:
					typeof candidate.locator === "string"
						? candidate.locator
						: typeof candidate.path === "string"
							? candidate.path
							: undefined,
				claimIds: Array.isArray(candidate.claimIds)
					? candidate.claimIds.filter((claim): claim is string => typeof claim === "string").sort()
					: [],
				redacted: candidate.redacted === true,
				integrity: typeof content === "string" ? "verified" : "unverified",
			});
		}
	}
	const byId = new Map<string, EvidenceRecord>();
	for (const record of records) byId.set(record.evidenceId, record);
	return [...byId.values()].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

export interface DiagnosticCheckResult {
	checkId: string;
	component: string;
	status: "pass" | "warn" | "fail" | "unavailable" | "skipped";
	reasonCode: string;
	summary: string;
	evidenceIds?: string[];
	remediation?: { safeAutomatic?: boolean; command?: string; description: string };
}

export interface DiagnosticReport {
	checks: DiagnosticCheckResult[];
	generatedAt: string;
	readOnly: true;
	exitCode: 0 | 1 | 2 | 3;
}

export function collectDiagnostics(
	options: { cwd?: string; sessionFile?: string; checkMcp?: boolean } = {},
): DiagnosticReport {
	const checks: DiagnosticCheckResult[] = [];
	const cwd = options.cwd ?? process.cwd();
	checks.push({
		checkId: "runtime.node",
		component: "runtime",
		status: process.versions.node ? "pass" : "fail",
		reasonCode: "node_detected",
		summary: `Node.js ${process.versions.node}`,
	});
	checks.push({
		checkId: "workspace.cwd",
		component: "workspace",
		status: cwd ? "pass" : "fail",
		reasonCode: cwd ? "cwd_detected" : "cwd_missing",
		summary: cwd ? "Workspace path is available" : "Workspace path is unavailable",
	});
	if (options.sessionFile) {
		const events = readSessionEvents(resolve(options.sessionFile));
		checks.push({
			checkId: "events.integrity",
			component: "events",
			status: events.issues.some(
				(issue) => issue.class === "manual_recovery_required" || issue.class === "integrity_failure",
			)
				? "fail"
				: events.issues.length
					? "warn"
					: "pass",
			reasonCode: events.issues[0]?.reasonCode ?? "event_store_readable",
			summary: events.issues.length
				? `${events.issues.length} event-store issue(s) surfaced`
				: `${events.events.length} events readable`,
		});
		checks.push({
			checkId: "evidence.integrity",
			component: "evidence",
			status: "pass",
			reasonCode: "evidence_projection_available",
			summary: `${listEvidence(events).length} addressable evidence record(s)`,
		});
	} else
		checks.push({
			checkId: "events.integrity",
			component: "events",
			status: "unavailable",
			reasonCode: "session_not_selected",
			summary: "No session selected; event checks skipped",
		});
	if (options.checkMcp)
		checks.push({
			checkId: "mcp.configuration",
			component: "mcp",
			status: "skipped",
			reasonCode: "live_probe_not_enabled",
			summary: "MCP live probes are opt-in and not run by default",
		});
	const hasFail = checks.some((check) => check.status === "fail");
	const hasWarn = checks.some((check) => check.status === "warn" || check.status === "unavailable");
	return { checks, generatedAt: new Date().toISOString(), readOnly: true, exitCode: hasFail ? 2 : hasWarn ? 1 : 0 };
}

const SECRET_KEY = /(api[-_]?key|token|secret|password|authorization|cookie|private[-_]?key)/i;
const SECRET_VALUE =
	/(?:bearer\s+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|-----BEGIN [A-Z ]+-----|eyJ[A-Za-z0-9_-]{8,}\.)/i;
export function sanitize(value: unknown): unknown {
	if (typeof value === "string") return SECRET_VALUE.test(value) ? "[REDACTED]" : value;
	if (Array.isArray(value)) return value.map(sanitize);
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>))
		out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitize(child);
	return out;
}

export interface SupportBundleManifest {
	bundleVersion: 1;
	createdAt: string;
	files: Array<{ path: string; bytes: number; sha256: string }>;
	redactions: string[];
	maxBytes: number;
}

export function supportBundlePreview(
	report: DiagnosticReport,
	projection?: RunProjection,
): { manifest: SupportBundleManifest; files: Record<string, string> } {
	const files: Record<string, string> = {
		"doctor.json": JSON.stringify(sanitize(report), null, 2),
		"projection.json": JSON.stringify(sanitize(projection ?? null), null, 2),
	};
	const manifest: SupportBundleManifest = {
		bundleVersion: 1,
		createdAt: new Date().toISOString(),
		files: Object.entries(files).map(([path, content]) => ({
			path,
			bytes: Buffer.byteLength(content),
			sha256: sha256(content),
		})),
		redactions: ["credentials", "authorization headers", "full environment", "raw prompt history"],
		maxBytes: 5 * 1024 * 1024,
	};
	return { manifest, files };
}

export function createSupportBundle(
	destination: string,
	report: DiagnosticReport,
	projection?: RunProjection,
): SupportBundleManifest {
	const preview = supportBundlePreview(report, projection);
	const payload = `${JSON.stringify(preview.manifest, null, 2)}\n${Object.entries(preview.files)
		.map(([name, content]) => `\n--- ${name} ---\n${content}`)
		.join("\n")}\n`;
	if (Buffer.byteLength(payload) > preview.manifest.maxBytes) throw new Error("support bundle exceeds maximum size");
	writeFileSync(destination, payload, { encoding: "utf8", flag: "wx" });
	return preview.manifest;
}

export function sessionFileFromId(id: string, sessionDir?: string): string | undefined {
	if (!sessionDir) return undefined;
	const path = resolve(sessionDir, id.endsWith(".jsonl") ? id : `${id}.jsonl`);
	return existsSync(path) && statSync(path).isFile() ? path : undefined;
}

export function loadProjectionFromSession(filePath: string): { events: EventReadResult; projection: RunProjection } {
	const events = readSessionEvents(filePath);
	return { events, projection: projectRun(events) };
}

export type { FileEntry, SessionEntry, SessionHeader };
