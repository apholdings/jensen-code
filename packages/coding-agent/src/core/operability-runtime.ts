import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type { EventReadResult, JensenEventEnvelope, RenderReplay } from "./operability.js";
import { renderReplay, sha256 } from "./operability.js";
import type { FileEntry, SessionHeader } from "./session-manager.js";

export interface SimulationReplay {
	runId: string;
	simulationId: string;
	mode: "simulation";
	recordedEvidence: number;
	lines: string[];
	missingArtifacts: string[];
	externalEffects: RenderReplay["externalEffects"];
	canonicalOrdering: "valid" | "invalid";
	warnings: string[];
}

export interface ReexecutionOptions {
	authorizeExecute?: boolean;
	plan?: boolean;
	cwd?: string;
	outputDir?: string;
	currentPolicy?: (event: JensenEventEnvelope<FileEntry>) => "allow" | "deny";
}

export interface ReexecutionResult {
	historicalRunId: string;
	newRunId: string;
	mode: "plan" | "execute";
	causationId: string;
	workspace: { historical: string; current: string; drifted: boolean };
	proposedEvents: number;
	mutations: 0;
	policy: "current";
	warnings: string[];
	path?: string;
}

function canonicalOrdering(events: JensenEventEnvelope<FileEntry>[]): boolean {
	return events.every(
		(event, index) => event.sequence === index && (index === 0 || event.recordedAt >= events[index - 1]!.recordedAt),
	);
}

export function simulateReplay(result: EventReadResult): SimulationReplay {
	const replay = renderReplay(result);
	const warnings = [...result.issues.map((issue) => `${issue.reasonCode}:${issue.detail}`)];
	if (replay.missingArtifacts.length > 0) warnings.push("recorded_artifact_missing");
	if (!canonicalOrdering(result.events)) warnings.push("canonical_event_order_invalid");
	return {
		runId: result.header?.id ?? result.events[0]?.runId ?? "unknown",
		simulationId: `simulation-${randomUUID()}`,
		mode: "simulation",
		recordedEvidence: result.events.length,
		lines: replay.lines,
		missingArtifacts: replay.missingArtifacts,
		externalEffects: { modelCalls: 0, toolCalls: 0, networkCalls: 0, mutations: 0 },
		canonicalOrdering: canonicalOrdering(result.events) ? "valid" : "invalid",
		warnings,
	};
}

export function reexecuteRun(result: EventReadResult, options: ReexecutionOptions = {}): ReexecutionResult {
	const historicalRunId = result.header?.id ?? result.events[0]?.runId ?? "unknown";
	const historicalCwd = result.header?.cwd ?? "";
	const currentCwd = resolve(options.cwd ?? process.cwd());
	const drifted = Boolean(historicalCwd && resolve(historicalCwd) !== currentCwd);
	const warnings = [...result.issues.map((issue) => `${issue.reasonCode}:${issue.detail}`)];
	if (drifted) warnings.push("workspace_drift");
	if (result.events.length === 0) warnings.push("historical_evidence_missing");
	if (options.authorizeExecute && !options.plan)
		throw new Error(
			"re-execute execute mode requires an explicit current authorization and is not enabled by this command",
		);
	const newRunId = randomUUID();
	const causationId = `${historicalRunId}:${newRunId}`;
	const proposedEvents = result.events.filter((event) => event.eventType === "message").length;
	for (const event of result.events) {
		if (options.currentPolicy?.(event) === "deny") warnings.push(`current_policy_denied:${event.eventId}`);
	}
	const outputDir = options.outputDir ? resolve(options.outputDir) : undefined;
	let path: string | undefined;
	if (outputDir) {
		mkdirSync(outputDir, { recursive: true });
		path = join(outputDir, `${newRunId}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: newRunId,
			timestamp: new Date().toISOString(),
			cwd: currentCwd,
			parentSession: historicalRunId,
		};
		const marker: FileEntry = {
			type: "custom",
			id: randomUUID().slice(0, 8),
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "jensen.reexecution.plan",
			data: { causationId, historicalRunId, proposedEvents, mode: "plan", mutations: 0 },
		};
		writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx" });
	}
	return {
		historicalRunId,
		newRunId,
		mode: "plan",
		causationId,
		workspace: { historical: historicalCwd, current: currentCwd, drifted },
		proposedEvents,
		mutations: 0,
		policy: "current",
		warnings,
		path,
	};
}

export interface StoragePruneEntry {
	path: string;
	reason: string;
	bytes: number;
}
export interface StoragePruneResult {
	preview: boolean;
	entries: StoragePruneEntry[];
	totalBytes: number;
	preserved: string[];
}

export function storagePrune(
	root: string,
	options: { preview: boolean; retainMs?: number; now?: number },
): StoragePruneResult {
	const base = resolve(root);
	const now = options.now ?? Date.now();
	const retainMs = options.retainMs ?? 30 * 24 * 60 * 60 * 1000;
	const entries: StoragePruneEntry[] = [];
	const preserved: string[] = [];
	if (!existsSync(base) || !lstatSync(base).isDirectory())
		return { preview: options.preview, entries, totalBytes: 0, preserved };
	for (const name of readdirSync(base)) {
		const path = join(base, name);
		const stat = lstatSync(path);
		if (!stat.isFile() || !/\.(jsonl|json|log|zip|idx)$/.test(name)) continue;
		if (stat.mtimeMs >= now - retainMs || /(?:active|checkpoint|acceptance|audit|release)/i.test(name)) {
			preserved.push(name);
			continue;
		}
		entries.push({ path: relative(base, path), reason: "retention_expired", bytes: stat.size });
	}
	if (!options.preview) for (const entry of entries) unlinkSync(join(base, entry.path));
	return {
		preview: options.preview,
		entries,
		totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
		preserved: preserved.sort(),
	};
}

export interface StorageIndex {
	version: 1;
	generatedAt: string;
	entries: Record<string, string[]>;
	sourceSha256: string;
}
export function rebuildStorageIndex(sessionFile: string, indexFile = `${sessionFile}.idx`): StorageIndex {
	const source = readFileSync(sessionFile, "utf8");
	const entries: Record<string, string[]> = {};
	for (const [line, text] of source.split(/\r?\n/).entries()) {
		if (!text.trim()) continue;
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			for (const key of ["type", "eventType", "correlationId"]) {
				if (typeof parsed[key] !== "string") continue;
				const values = entries[key] ?? [];
				values.push(`${line + 1}:${parsed[key]}`);
				entries[key] = values;
			}
		} catch {
			/* canonical reader reports malformed source */
		}
	}
	const index: StorageIndex = {
		version: 1,
		generatedAt: new Date().toISOString(),
		entries,
		sourceSha256: createHash("sha256").update(source).digest("hex"),
	};
	const temporary = `${indexFile}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(index));
	renameSync(temporary, indexFile);
	return index;
}

export function inspectSupportBundle(path: string): { valid: boolean; manifest?: unknown; errors: string[] } {
	if (!existsSync(path) || !statSync(path).isFile()) return { valid: false, errors: ["bundle_missing"] };
	const content = readFileSync(path, "utf8");
	const marker = "\n--- doctor.json ---\n";
	const manifestText = content.split(marker)[0];
	try {
		const manifest = JSON.parse(manifestText) as {
			files?: Array<{ path: string; sha256: string }>;
			maxBytes?: number;
		};
		const errors: string[] = [];
		if (!Array.isArray(manifest.files)) errors.push("manifest_files_missing");
		if (manifest.maxBytes !== undefined && Buffer.byteLength(content) > manifest.maxBytes)
			errors.push("bundle_size_limit");
		for (const file of manifest.files ?? []) {
			const section = `\n--- ${file.path} ---\n`;
			const start = content.indexOf(section);
			if (start < 0) errors.push(`file_missing:${file.path}`);
			else {
				const end = content.indexOf("\n--- ", start + section.length);
				const body = content.slice(start + section.length, end < 0 ? undefined : end);
				if (sha256(body) !== file.sha256) errors.push(`hash_mismatch:${file.path}`);
			}
		}
		return { valid: errors.length === 0, manifest, errors };
	} catch {
		return { valid: false, errors: ["invalid_manifest"] };
	}
}
