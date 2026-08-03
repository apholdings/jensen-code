import type { LspPosition } from "./types.js";

/**
 * Position/offset conversion for LSP using UTF-16 code units (the LSP default
 * and the only encoding we negotiate from servers on initialize). Operates on
 * a per-file line index and is CRLF/LF aware: line breaks are \n (with optional
 * \r ignored as part of the line terminator).
 */

export interface LineIndex {
	/** Byte offsets of each line start (0..n). */
	lineStarts: number[];
}

export function computeLineIndex(text: string): LineIndex {
	const lineStarts: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			lineStarts.push(i + 1);
		}
	}
	return { lineStarts };
}

function lineStart(index: LineIndex, line: number): number {
	if (line <= 0) return 0;
	if (line >= index.lineStarts.length) return index.lineStarts[index.lineStarts.length - 1];
	return index.lineStarts[line];
}

function lineEnd(index: LineIndex, text: string, line: number): number {
	if (line >= index.lineStarts.length - 1) return text.length;
	return index.lineStarts[line + 1] - (text.charCodeAt(index.lineStarts[line + 1] - 1) === 10 ? 1 : 0);
}

/** Convert a UTF-16 code-unit offset to an LSP position (0-based line/char). */
export function offsetToPosition(text: string, index: LineIndex, offset: number): LspPosition {
	const clamped = Math.max(0, Math.min(offset, text.length));
	// Binary search for the line.
	let lo = 0;
	let hi = index.lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (index.lineStarts[mid] <= clamped) lo = mid;
		else hi = mid - 1;
	}
	const line = lo;
	const lineStartOffset = lineStart(index, line);
	// LSP character is a UTF-16 code-unit count; JS string offsets ARE UTF-16
	// code units, so character == offset delta within the line.
	const character = clamped - lineStartOffset;
	return { line, character };
}

/** Convert an LSP position (UTF-16) to a JS string offset. */
export function positionToOffset(text: string, index: LineIndex, pos: LspPosition): number {
	const start = lineStart(index, pos.line);
	const end = lineEnd(index, text, pos.line);
	// JS string offsets are UTF-16 code units.
	return Math.max(start, Math.min(end, start + pos.character));
}

export function offsetToLineCharacter(text: string, offset: number): LspPosition {
	return offsetToPosition(text, computeLineIndex(text), offset);
}
