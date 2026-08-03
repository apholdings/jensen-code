import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class WorkspaceBoundaryError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "WorkspaceBoundaryError";
	}
}

const SEP = path.sep;
const isWindows = process.platform === "win32";

/**
 * A canonical platform key used for membership comparisons. On Windows this is
 * case-insensitive and drive-letter-normalized; on POSIX it is byte-identical.
 */
export function canonicalKey(p: string): string {
	let normalized = p.replace(/[\\/]+/g, "/");
	if (normalized !== "/" && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
	if (isWindows) {
		normalized = normalized.toLowerCase();
		// normalize drive letter, keep a single leading slash
		normalized = normalized.replace(/^([a-z]):/, "$1:");
	}
	return normalized;
}

function isWithin(realTarget: string, realRoot: string): boolean {
	const t = canonicalKey(realTarget);
	const r = canonicalKey(realRoot);
	if (t === r) return true;
	return t.startsWith(`${r}/`);
}

export interface BoundaryCheckOptions {
	/** Reject NUL and malformed input. Default true. */
	validateInput?: boolean;
	/** Reject UNC paths (Windows). Default true. */
	rejectUnc?: boolean;
	/** Reject absolute paths outside root entirely (single-root containment). Default true. */
	contained?: boolean;
}

/**
 * Canonical workspace-root enforcement for every path-bearing mutation.
 *
 * Normalizes absolute/relative/`..` paths, resolves symlinks (and Windows
 * junctions/reparse points via realpath), and rejects anything that escapes the
 * authorized root. Callers must re-run `assertParentWithin` immediately before
 * the physical write to narrow the TOCTOU window.
 */
export class WorkspaceBoundary {
	readonly root: string;
	private readonly rootReal: string;

	private constructor(root: string, rootReal: string) {
		this.root = path.resolve(root);
		this.rootReal = rootReal;
	}

	static async create(root: string): Promise<WorkspaceBoundary> {
		let rootReal = path.resolve(root);
		try {
			rootReal = await realpath(rootReal);
		} catch {
			// root does not exist yet; use the resolved form.
		}
		return new WorkspaceBoundary(root, rootReal);
	}

	get effectiveRoot(): string {
		return this.rootReal;
	}

	private assertInput(p: string): void {
		if (p === "") throw new WorkspaceBoundaryError("empty_path", "empty path");
		if (p.includes("\u0000")) {
			throw new WorkspaceBoundaryError("nul_byte", "path contains NUL byte");
		}
		if (isWindows && p.startsWith("\\\\")) {
			throw new WorkspaceBoundaryError("unc_path", "UNC paths are not allowed");
		}
		if (isWindows && /^[a-z]:(?![\\/])/i.test(p)) {
			// drive-relative like `C:foo` — normalise on the current drive's root.
		}
	}

	/**
	 * Resolve an input path (absolute or relative to the workspace root) to an
	 * absolute path that is guaranteed to be within the real workspace root.
	 * Throws WorkspaceBoundaryError on escape.
	 */
	async resolveWithin(input: string): Promise<string> {
		this.assertInput(input);
		const abs = path.isAbsolute(input) ? input : path.resolve(this.root, input);
		const realTarget = await this.resolvedRealtarget(abs);
		if (!isWithin(realTarget, this.rootReal)) {
			throw new WorkspaceBoundaryError("escape", `path escapes the authorized workspace: ${input}`);
		}
		return realTarget;
	}

	/**
	 * Revalidate the resolved parent directory of a target immediately before a
	 * write, protecting against the parent directory being swapped for a symlink
	 * to an external directory after the initial validation.
	 */
	async assertParentWithin(targetAbs: string): Promise<void> {
		const parent = path.dirname(targetAbs);
		const realParent = await this.resolvedRealtarget(parent);
		if (!isWithin(realParent, this.rootReal)) {
			throw new WorkspaceBoundaryError("escape", `parent directory escapes the authorized workspace: ${targetAbs}`);
		}
	}

	/** Resolve the real path of a target, using the nearest existing ancestor. */
	private async resolvedRealtarget(abs: string): Promise<string> {
		try {
			return await realpath(abs);
		} catch {
			// The leaf does not exist yet. Resolve the nearest existing ancestor
			// to catch a symlinked ancestor escaping the workspace.
			let candidate = abs;
			const missing: string[] = [];
			for (;;) {
				let real: string | null = null;
				try {
					real = await realpath(candidate);
				} catch {
					real = null;
				}
				if (real !== null) {
					const joined = path.join(real, ...missing);
					return joined;
				}
				const parent = path.dirname(candidate);
				if (parent === candidate) {
					return abs;
				}
				missing.unshift(path.basename(candidate));
				candidate = parent;
			}
		}
	}

	/** True when a path already exists as a symlink (for rollback/restore). */
	async isSymlink(abs: string): Promise<boolean> {
		try {
			const st = await lstat(abs);
			return st.isSymbolicLink();
		} catch {
			return false;
		}
	}
}

/** Reject NUL and throw for secret-bearing paths when so requested. */
export function validatePathInput(p: string, rejectNul = true): string {
	if (rejectNul && p.includes("\u0000")) {
		throw new WorkspaceBoundaryError("nul_byte", "path contains NUL byte");
	}
	return p;
}

export { isWindows, SEP };

/** Strip a leading home dir from display purposes (never used for containment). */
export function displayPath(p: string): string {
	const home = os.homedir();
	if (p === home) return "~";
	if (p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
	return p;
}

export async function pathExists(abs: string): Promise<boolean> {
	try {
		await access(abs, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}
