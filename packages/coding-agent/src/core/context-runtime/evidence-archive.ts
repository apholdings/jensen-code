/**
 * Cold evidence archive (L3) for context virtualization.
 *
 * Large raw tool outputs, command logs, diagnostics, and file excerpts are
 * persisted here durably and replaced in the hot working set by a concise
 * synopsis + a deterministic evidence reference. This is not the Reliability
 * Kernel evidence ledger — it stores raw operational artifacts; verification
 * authority remains with the Evidence Store / Completion Gate.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export type EvidenceKind = "tool-result" | "file" | "log" | "diagnostic";

export interface EvidenceRecord {
	evidenceId: string;
	kind: EvidenceKind;
	/** Tool name, file path, or command that produced this artifact. */
	source: string;
	/** Redacted raw content (secrets scrubbed before persistence). */
	content: string;
	contentHash: string;
	contentBytes: number;
	createdAtMs: number;
}

export interface EvidenceArchive {
	store(record: Omit<EvidenceRecord, "evidenceId" | "contentHash" | "contentBytes" | "createdAtMs">): Promise<string>;
	load(evidenceId: string): Promise<EvidenceRecord | undefined>;
	has(evidenceId: string): Promise<boolean>;
}

export function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Conservative secret redaction. Never persist API keys, bearer tokens, GitHub
 * personal access tokens, or common credential assignments into cold evidence.
 * This is a best-effort scrub for raw operational artifacts only.
 */
export function redactSecrets(text: string): string {
	return text
		.replace(/(sk-[A-Za-z0-9_-]{16,})/g, "[REDACTED_API_KEY]")
		.replace(/(ghp_[A-Za-z0-9]{20,})/g, "[REDACTED_GITHUB_TOKEN]")
		.replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/g, "$1[REDACTED]")
		.replace(/(AKIA[0-9A-Z]{16})/g, "[REDACTED_AWS_KEY]")
		.replace(
			/((?:api[_-]?key|secret|password|token|credential)\s*[=:]\s*)(["']?)[^\s"']{8,}\2/gi,
			"$1$2[REDACTED]$2",
		);
}

/** Deterministic, content-addressed evidence id (not secret, not random-only). */
export function deriveEvidenceId(kind: EvidenceKind, source: string, contentHash: string): string {
	const short = contentHash.slice(0, 16);
	return `${kind}:${source.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64)}:${short}`;
}

export function buildEvidenceRecord(input: {
	kind: EvidenceKind;
	source: string;
	content: string;
	now?: number;
}): EvidenceRecord {
	const content = redactSecrets(input.content);
	const contentHash = hashContent(content);
	return {
		evidenceId: deriveEvidenceId(input.kind, input.source, contentHash),
		kind: input.kind,
		source: input.source,
		content,
		contentHash,
		contentBytes: Buffer.byteLength(content, "utf8"),
		createdAtMs: input.now ?? Date.now(),
	};
}

export class InMemoryEvidenceArchive implements EvidenceArchive {
	private readonly records = new Map<string, EvidenceRecord>();

	async store(
		record: Omit<EvidenceRecord, "evidenceId" | "contentHash" | "contentBytes" | "createdAtMs">,
	): Promise<string> {
		const built = buildEvidenceRecord(record);
		this.records.set(built.evidenceId, built);
		return built.evidenceId;
	}

	async load(evidenceId: string): Promise<EvidenceRecord | undefined> {
		return this.records.get(evidenceId);
	}

	async has(evidenceId: string): Promise<boolean> {
		return this.records.has(evidenceId);
	}

	get size(): number {
		return this.records.size;
	}
}

const SUFFIX = ".tmp";

/**
 * Atomic file-backed cold evidence store. Writes go temp-then-rename so a
 * process exit never leaves a partial artifact; reads fail closed to undefined
 * on corruption (never fabricate evidence).
 */
export class EvidenceFileStore implements EvidenceArchive {
	private readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	private resolve(evidenceId: string): string {
		return path.join(this.root, `${evidenceId}.evidence.json`);
	}

	async store(
		record: Omit<EvidenceRecord, "evidenceId" | "contentHash" | "contentBytes" | "createdAtMs">,
	): Promise<string> {
		const built = buildEvidenceRecord(record);
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.resolve(built.evidenceId);
		const tmp = `${target}${SUFFIX}`;
		await fsp.writeFile(tmp, JSON.stringify(built), "utf8");
		const fh = await fsp.open(tmp, "r");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
		await fsp.rename(tmp, target);
		return built.evidenceId;
	}

	async load(evidenceId: string): Promise<EvidenceRecord | undefined> {
		try {
			const data = await fsp.readFile(this.resolve(evidenceId), "utf8");
			const parsed = JSON.parse(data) as EvidenceRecord;
			// Fail closed on malformed artifacts.
			if (typeof parsed.evidenceId !== "string" || typeof parsed.content !== "string") return undefined;
			return parsed;
		} catch {
			return undefined;
		}
	}

	async has(evidenceId: string): Promise<boolean> {
		return fs.existsSync(this.resolve(evidenceId));
	}
}
