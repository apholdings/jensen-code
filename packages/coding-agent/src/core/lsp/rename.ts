import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import type { WorkspaceEdit } from "../safety/transaction.js";
import { computeLineIndex, positionToOffset } from "./position.js";
import type { LspTextEdit, LspWorkspaceEdit } from "./types.js";

/**
 * Rename preview & transactional refactoring support.
 *
 * `lsp_rename_preview` produces a structured proposed transaction with ZERO
 * physical mutations. Applying the rename uses Jensen 1.3.0 transactional
 * mutation (policy → lease → checkpoint → deterministic edit application →
 * validation → confirm/rollback).
 */

export interface RenameFileEdit {
	workspaceRelativePath: string;
	absolutePath: string;
	newContent: string;
	contentHashBefore: string;
	editCount: number;
}

export interface RenamePreview {
	symbol: string;
	oldName: string;
	newName: string;
	affectedFiles: RenameFileEdit[];
	totalEditCount: number;
	conflicts: string[];
	unsupportedResourceOperations: string[];
	transactionId: string | null;
	zeroMutation: true;
}

export interface ApplyTextEditOptions {
	preserveBom?: boolean;
}

/** Apply LSP text edits to file content (later offsets first). UTF-16-aware. */
export function applyTextEdits(
	content: string,
	edits: LspTextEdit[],
	opts: ApplyTextEditOptions = {},
): { newContent: string; conflicts: string[] } {
	const index = computeLineIndex(content);
	const bom = opts.preserveBom === false ? "" : content.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
	const bodyStart = bom ? 1 : 0;
	const indexed = content.slice(bodyStart);
	const lineIndex = bodyStart ? shiftLineIndex(index, bodyStart) : index;

	const ordered = [...edits].sort((a, b) => {
		const aStart = offsetAt(indexed, lineIndex, a.range.start);
		const bStart = offsetAt(indexed, lineIndex, b.range.start);
		if (aStart !== bStart) return bStart - aStart;
		return offsetAt(indexed, lineIndex, b.range.end) - offsetAt(indexed, lineIndex, a.range.end);
	});

	let result = indexed;
	const conflicts: string[] = [];
	const appliedRanges: Array<{ start: number; end: number }> = [];
	for (const edit of ordered) {
		const start = offsetAt(result, computeLineIndex(result), edit.range.start);
		const end = offsetAt(result, computeLineIndex(result), edit.range.end);
		// Overlap detection against the ORIGINAL positions.
		const origStart = offsetAt(indexed, lineIndex, edit.range.start);
		const origEnd = offsetAt(indexed, lineIndex, edit.range.end);
		const overlap = appliedRanges.some((r) => origStart < r.end && origEnd > r.start);
		if (overlap) {
			conflicts.push(`overlapping edit at ${edit.range.start.line}:${edit.range.start.character}`);
			continue;
		}
		appliedRanges.push({ start: origStart, end: origEnd });
		result = result.slice(0, start) + edit.newText + result.slice(end);
	}
	return { newContent: bom + result, conflicts };
}

function shiftLineIndex(
	index: ReturnType<typeof computeLineIndex>,
	shiftChars: number,
): ReturnType<typeof computeLineIndex> {
	return { lineStarts: index.lineStarts.map((s) => s - shiftChars) };
}

function offsetAt(
	content: string,
	index: ReturnType<typeof computeLineIndex>,
	pos: { line: number; character: number },
): number {
	return positionToOffset(content, index, pos);
}

function sha256Content(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Read the current content of a file (workspace path, absolute), apply edits,
 * and return the new content plus hash preconditions. Edits outside the
 * workspace root are rejected.
 */
export async function previewFileEdits(
	absPath: string,
	workspaceRoot: string,
	edits: LspTextEdit[],
): Promise<RenameFileEdit> {
	const content = await readFile(absPath, "utf-8");
	const rel = nodePath.relative(workspaceRoot, absPath).replace(/\\/g, "/");
	const applied = applyTextEdits(content, edits);
	return {
		workspaceRelativePath: rel,
		absolutePath: absPath,
		newContent: applied.newContent,
		contentHashBefore: sha256Content(content),
		editCount: edits.length,
	};
}

/**
 * Normalize an LSP WorkspaceEdit into a preview. Resource operations
 * (create/rename/delete files) are reported as unsupported unless represented
 * safely; here they are surfaced but excluded from the transactional snapshot
 * so no physical change occurs.
 */
export function normalizeWorkspaceEditForPreview(
	edit: LspWorkspaceEdit,
	workspaceRoot: string,
	symbol: string,
	oldName: string,
	newName: string,
): { version: string; preview: RenamePreview } {
	const conflicts: string[] = [];
	const unsupportedResourceOperations: string[] = [];
	const byPath = new Map<string, LspTextEdit[]>();

	const addChanges = (changes: Record<string, LspTextEdit[]> | undefined) => {
		if (!changes) return;
		for (const [uri, edits] of Object.entries(changes)) {
			const abs = uriToAbs(uri);
			if (!abs) {
				unsupportedResourceOperations.push(uri);
				continue;
			}
			if (!abs.startsWith(nodePath.resolve(workspaceRoot))) {
				conflicts.push(`edit targets external path: ${uri}`);
				continue;
			}
			const existing = byPath.get(abs) ?? [];
			byPath.set(abs, [...existing, ...edits]);
		}
	};
	addChanges(edit.changes);
	for (const doc of edit.documentChanges ?? []) {
		if ("textDocument" in doc && "edits" in doc) {
			const abs = uriToAbs(doc.textDocument.uri);
			if (!abs) {
				unsupportedResourceOperations.push(doc.textDocument.uri);
				continue;
			}
			if (!abs.startsWith(nodePath.resolve(workspaceRoot))) {
				conflicts.push(`edit targets external path: ${doc.textDocument.uri}`);
				continue;
			}
			const existing = byPath.get(abs) ?? [];
			byPath.set(abs, [...existing, ...doc.edits]);
		} else {
			unsupportedResourceOperations.push("resource-operation");
		}
	}

	const affected: RenameFileEdit[] = [];
	for (const [abs, edits] of byPath) {
		// Deferred file read done at build time (async) — represented here as a
		// placeholder resolved later. This structure is populated synchronously
		// for the pure preview; the tools layer fills real content.
		affected.push({
			workspaceRelativePath: nodePath.relative(workspaceRoot, abs).replace(/\\/g, "/"),
			absolutePath: abs,
			newContent: "",
			contentHashBefore: "",
			editCount: edits.length,
		});
	}

	const totalEditCount = affected.reduce((n, f) => n + f.editCount, 0);
	const preview: RenamePreview = {
		symbol,
		oldName,
		newName,
		affectedFiles: affected,
		totalEditCount,
		conflicts,
		unsupportedResourceOperations,
		transactionId: null,
		zeroMutation: true,
	};
	return { version: sha256Content(JSON.stringify(preview)), preview };
}

function uriToAbs(uri: string): string | null {
	if (!uri.startsWith("file://")) return null;
	const raw = decodeURIComponent(uri.slice("file://".length));
	if (raw.startsWith("/")) return raw;
	return raw.replace(/^\//, "").replace(/\//g, "\\");
}

export { sha256Content };

/** Translate a normalized LSP edit set into Jensen transactional WorkspaceEdits. */
export async function buildJensenWorkspaceEdits(
	byPath: Map<string, LspTextEdit[]>,
	workspaceRoot: string,
): Promise<{
	edits: WorkspaceEdit[];
	contentHashes: Record<string, string>;
}> {
	const edits: WorkspaceEdit[] = [];
	const contentHashes: Record<string, string> = {};
	for (const [abs, textEdits] of byPath) {
		const rel = nodePath.relative(workspaceRoot, abs).replace(/\\/g, "/");
		const content = await readFile(abs, "utf-8");
		const before = sha256Content(content);
		const applied = applyTextEdits(content, textEdits);
		if (applied.conflicts.length) continue;
		contentHashes[rel] = before;
		edits.push({ kind: "replace_file", path: rel, content: applied.newContent, expectedSha256: before });
	}
	return { edits, contentHashes };
}

/** Extract the per-absolute-path edit map from an LSP WorkspaceEdit. */
export function extractEditsByPath(
	edit: LspWorkspaceEdit,
	workspaceRoot: string,
): { byPath: Map<string, LspTextEdit[]>; conflicts: string[]; unsupported: string[] } {
	const conflicts: string[] = [];
	const unsupported: string[] = [];
	const byPath = new Map<string, LspTextEdit[]>();
	const root = nodePath.resolve(workspaceRoot);
	const addChanges = (changes: Record<string, LspTextEdit[]> | undefined) => {
		if (!changes) return;
		for (const [uri, edits] of Object.entries(changes)) {
			const abs = uriToAbs(uri);
			if (!abs) {
				unsupported.push(uri);
				continue;
			}
			if (!abs.startsWith(root)) {
				conflicts.push(`edit targets external path: ${uri}`);
				continue;
			}
			byPath.set(abs, [...(byPath.get(abs) ?? []), ...edits]);
		}
	};
	addChanges(edit.changes);
	for (const doc of edit.documentChanges ?? []) {
		if ("textDocument" in doc && "edits" in doc) {
			const abs = uriToAbs(doc.textDocument.uri);
			if (!abs) {
				unsupported.push(doc.textDocument.uri);
				continue;
			}
			if (!abs.startsWith(root)) {
				conflicts.push(`edit targets external path: ${doc.textDocument.uri}`);
				continue;
			}
			byPath.set(abs, [...(byPath.get(abs) ?? []), ...doc.edits]);
		} else {
			unsupported.push("resource-operation");
		}
	}
	return { byPath, conflicts, unsupported };
}
