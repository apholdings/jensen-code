/** Content addressing and lightweight security guards for workspace indexing. */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export function sha256(input: string | Buffer): string {
	return createHash("sha256").update(input).digest("hex");
}

/** Constant-time string equality (for internal integrity checks). */
export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Validate that a workspace-relative target stays inside the workspace root.
 * Rejects absolute paths, parent traversal, and empty targets.
 */
export function assertInsideWorkspace(root: string, relative: string): string {
	const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalized || normalized.includes("\u0000")) {
		throw new Error(`Invalid workspace-relative path: ${JSON.stringify(relative)}`);
	}
	const parts = normalized.split("/");
	if (parts.some((p) => p === "..")) {
		throw new Error(`Path escapes workspace: ${JSON.stringify(relative)}`);
	}
	const resolved = path.resolve(root, ...parts);
	const rootResolved = path.resolve(root);
	if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
		throw new Error(`Path escapes workspace: ${JSON.stringify(relative)}`);
	}
	return parts.join("/");
}

/**
 * Detect a symlink escape: a resolved real path that leaves the workspace root.
 * Returns the escaped path or null when safe.
 */
export function detectSymlinkEscape(root: string, candidate: string): string | null {
	try {
		const rootReal = realpathSync(root);
		const candReal = realpathSync(candidate);
		if (candReal === rootReal) return null;
		if (!candReal.startsWith(rootReal + path.sep)) return candReal;
		return null;
	} catch {
		return null; // path does not exist yet — treat as not-an-escape
	}
}

/** Reject characters that could enable an FTS/query injection from untrusted text. */
export function sanitizeQueryTerm(term: string): string {
	return term.replace(/["'()*:^<>-]/g, " ");
}

export function isSuperficiallyBinary(buf: Buffer): boolean {
	const sample = buf.subarray(0, 8192);
	for (let i = 0; i < sample.length; i++) {
		const b = sample[i];
		if (b === 0) return true;
		// High control byte ratio heuristic excluding common whitespace/escapes.
		if (b < 0x09 || (b > 0x0d && b < 0x20)) return true;
	}
	return false;
}
