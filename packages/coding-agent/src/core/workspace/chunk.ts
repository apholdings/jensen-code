/**
 * Deterministic chunking. Prefers symbol boundaries, then markdown/config
 * sections, then bounded line windows. Chunk identity is content-addressed.
 */

import { sha256 } from "./guard.js";
import type { ExtractedSymbol } from "./symbols.js";

export interface ChunkInput {
	fileId: string;
	content: string;
	contentSha256: string;
	languageId?: string;
	classification: string;
	symbols?: ExtractedSymbol[];
}

export interface ChunkOutput {
	chunkId: string;
	fileId: string;
	contentSha256: string;
	startLine: number;
	endLine: number;
	startByte?: number;
	endByte?: number;
	languageId?: string;
	symbolId?: string;
	chunkKind: "symbol" | "section" | "paragraph" | "configuration" | "fallback_window";
	textHash: string;
	embeddingStatus: "not_requested" | "pending" | "ready" | "failed" | "excluded";
	text: string;
}

export const MAX_CHUNK_LINES = 160;
export const MAX_CHUNK_CHARS = 6000;

function byteRange(content: string, startLine: number, endLine: number): [number, number] {
	const lines = content.split("\n");
	let start = 0;
	for (let i = 0; i < startLine && i < lines.length; i++) start += lines[i].length + 1;
	let end = start;
	for (let i = startLine; i < endLine && i < lines.length; i++) end += lines[i].length + 1;
	return [start, end];
}

export function chunkFile(input: ChunkInput): ChunkOutput[] {
	const content = input.content.replace(/^\uFEFF/, "");
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	const chunks: ChunkOutput[] = [];
	const isConfig = ["configuration", "schema", "lockfile"].includes(input.classification);

	if (isConfig) {
		chunks.push(...chunkConfig(input, normalized, lines));
		return chunks;
	}

	if (input.languageId === "markdown" || input.classification === "documentation") {
		chunks.push(...chunkMarkdown(input, normalized, lines));
		return chunks;
	}

	// Symbol-bounded chunking.
	if (input.symbols && input.symbols.length > 0) {
		const sorted = [...input.symbols].sort((a, b) => a.startLine - b.startLine);
		let cursor = 0;
		const made = new Set<number>();
		for (const sym of sorted) {
			if (sym.startLine < cursor) continue;
			const start = sym.startLine;
			const end = Math.min(sym.endLine, Math.max(start + 1, lines.length));
			if (end > start) {
				const text = lines.slice(start, end).join("\n");
				const chunk = makeChunk(input, start, end, text, "symbol", sym);
				if (!made.has(chunk.startLine)) {
					chunks.push(chunk);
					made.add(chunk.startLine);
				}
			}
			// import/header prologue before the first symbol
			if (cursor < start && chunks.length === 0) {
				const head = lines.slice(cursor, Math.min(start, cursor + 20)).join("\n");
				if (head.trim())
					chunks.unshift(makeChunk(input, cursor, Math.min(start, cursor + 20), head, "section", undefined));
			}
			cursor = Math.max(cursor, end);
		}
		if (chunks.length === 0 && lines.length) {
			chunks.push(makeChunk(input, 0, lines.length, lines.join("\n"), "fallback_window", undefined));
		}
		return chunks;
	}

	// Fallback bounded line windows.
	chunks.push(...fallbackWindows(input, normalized, lines));
	return chunks;
}

function makeChunk(
	input: ChunkInput,
	start: number,
	end: number,
	rawText: string,
	kind: ChunkOutput["chunkKind"],
	symbol?: ExtractedSymbol,
): ChunkOutput {
	let text = rawText;
	let effEnd = end;
	// Split oversized symbol chunks deterministically.
	if (text.length > MAX_CHUNK_CHARS) {
		const maxLines = Math.max(20, Math.floor((MAX_CHUNK_CHARS / Math.max(1, text.length)) * (end - start)));
		const slice = text.split("\n").slice(0, maxLines).join("\n");
		text = slice;
		effEnd = start + slice.split("\n").length;
	}
	const [sb, eb] = byteRange(input.content, start, effEnd);
	return {
		chunkId: sha256(`${input.fileId}:${start}:${effEnd}:${sha256(text).slice(0, 16)}`).slice(0, 32),
		fileId: input.fileId,
		contentSha256: input.contentSha256,
		startLine: start,
		endLine: effEnd,
		startByte: sb,
		endByte: eb,
		languageId: input.languageId,
		symbolId: symbol ? sha256(`${input.fileId}:${symbol.qualifiedName ?? symbol.name}`).slice(0, 32) : undefined,
		chunkKind: kind,
		textHash: sha256(text),
		embeddingStatus: "not_requested",
		text,
	};
}

function fallbackWindows(input: ChunkInput, normalized: string, lines: string[]): ChunkOutput[] {
	const out: ChunkOutput[] = [];
	const step = 60;
	for (let i = 0; i < lines.length; i += step) {
		const start = i;
		const end = Math.min(i + step, lines.length);
		const text = lines.slice(start, end).join("\n");
		out.push(makeChunk(input, start, end, text, "fallback_window", undefined));
	}
	if (out.length === 0 && lines.length) {
		out.push(makeChunk(input, 0, lines.length, normalized, "fallback_window", undefined));
	}
	return out;
}

function chunkMarkdown(input: ChunkInput, normalized: string, lines: string[]): ChunkOutput[] {
	const headers = lines.map((l, i) => ({ i, m: l.match(/^(#{1,6})\s+(.+)/) })).filter((x) => x.m);
	const out: ChunkOutput[] = [];
	if (headers.length === 0) return fallbackWindows(input, normalized, lines);
	for (let h = 0; h < headers.length; h++) {
		const start = headers[h].i;
		const end = h + 1 < headers.length ? headers[h + 1].i : lines.length;
		const text = lines.slice(start, end).join("\n");
		out.push(makeChunk(input, start, end, text, "section", undefined));
	}
	return out;
}

function chunkConfig(input: ChunkInput, normalized: string, lines: string[]): ChunkOutput[] {
	// Split top-level keys for YAML/TOML/properties; for JSON, single chunk if small.
	const out: ChunkOutput[] = [];
	if (input.languageId === "json" && normalized.length <= MAX_CHUNK_CHARS) {
		out.push(makeChunk(input, 0, lines.length, normalized, "configuration", undefined));
		return out;
	}
	let sectionStart = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isTopLevel = /^[A-Za-z0-9_".'`-]+\s*[:=]/.test(line) && !line.startsWith(" ") && !line.startsWith("\t");
		if (isTopLevel && i > 0) {
			const text = lines.slice(sectionStart, i).join("\n");
			if (text.trim()) out.push(makeChunk(input, sectionStart, i, text, "configuration", undefined));
			sectionStart = i;
		}
	}
	if (sectionStart < lines.length) {
		const text = lines.slice(sectionStart).join("\n");
		if (text.trim()) out.push(makeChunk(input, sectionStart, lines.length, text, "configuration", undefined));
	}
	if (out.length === 0) out.push(makeChunk(input, 0, lines.length, normalized, "configuration", undefined));
	return out;
}
