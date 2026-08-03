/**
 * Deterministic, cancellable file discovery.
 *
 * Respects .gitignore and Jensen ignore policy, stays inside the workspace
 * boundary, never traverses external symlinks or junctions, skips caches and
 * binary blobs, and returns deterministically sorted workspace-relative paths.
 */

import { type Dirent, readdirSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { type ClassificationResult, classifyPath } from "./classify.js";
import { detectSymlinkEscape, isSuperficiallyBinary } from "./guard.js";

export interface DiscoveryOptions {
	cwd: string;
	root: string; // canonical workspace root
	maxFileBytes?: number;
	additionalIgnores?: string[];
	includeLockfilesAsMetadata?: boolean;
	signal?: AbortSignal;
	onProgress?: (discovered: number) => void;
}

export interface DiscoveredFile {
	workspaceRelativePath: string;
	absolutePath: string;
	sizeBytes: number;
	classification: ClassificationResult;
}

interface IgnoreLayer {
	matcher: Ignore;
	dir: string;
}

function loadGitignore(dir: string): Ignore {
	const ig = ignore();
	try {
		const content = readFileSync(path.join(dir, ".gitignore"), "utf-8");
		ig.add(content);
		ig.add([".git/**", "node_modules/**", "dist/**", "build/**", "coverage/**", ".next/**"]);
	} catch {
		ig.add([".git/**", "node_modules/**", "dist/**", "build/**", "coverage/**", ".next/**"]);
	}
	return ig;
}

interface WalkResult {
	files: DiscoveredFile[];
	skippedIgnored: number;
	skippedBinary: number;
	skippedTooLarge: number;
	escapesDetected: number;
}

export function discoverWorkspaceFiles(options: DiscoveryOptions): WalkResult {
	const { root, maxFileBytes = 8 * 1024 * 1024 } = options;
	const signal = options.signal;
	if (signal?.aborted) throw new Error("Discovery cancelled");

	const result: WalkResult = {
		files: [],
		skippedIgnored: 0,
		skippedBinary: 0,
		skippedTooLarge: 0,
		escapesDetected: 0,
	};

	// Root ignore layer.
	const layers: IgnoreLayer[] = [{ matcher: loadGitignore(root), dir: root }];

	const projectIgnorePath = path.join(root, ".jensenindexignore");
	const projectIgnores: string[] = [];
	try {
		projectIgnores.push(...readFileSync(projectIgnorePath, "utf-8").split(/\r?\n/));
	} catch {
		/* optional */
	}
	if (options.additionalIgnores) projectIgnores.push(...options.additionalIgnores);
	if (projectIgnores.length) {
		const ig = ignore();
		ig.add(projectIgnores);
		layers[0].matcher.add(projectIgnores);
	}

	const pending: string[] = [root];
	while (pending.length > 0) {
		if (signal?.aborted) throw new Error("Discovery cancelled");
		const dir = pending.pop() as string;
		if (dir !== root) {
			// nested .gitignore
			layers.push({ matcher: loadGitignore(dir), dir });
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

		for (const entry of entries) {
			if (signal?.aborted) throw new Error("Discovery cancelled");
			const abs = path.join(dir, entry.name);
			const rel = path.relative(root, abs).replace(/\\/g, "/");

			// Respect ignore layers from root downward (each scoped to its dir).
			let ignoredByAny = false;
			if (layers[0].matcher.ignores(rel)) ignoredByAny = true;
			if (!ignoredByAny) {
				for (let li = 1; li < layers.length; li++) {
					const layer = layers[li];
					if (!abs.startsWith(layer.dir + path.sep)) continue;
					const relToLayer = path.relative(layer.dir, abs).replace(/\\/g, "/");
					if (layer.matcher.ignores(relToLayer)) {
						ignoredByAny = true;
						break;
					}
				}
			}
			if (ignoredByAny) {
				result.skippedIgnored++;
				continue;
			}

			let lst: Stats;
			try {
				lst = statSync(abs);
			} catch {
				continue;
			}

			if (entry.isSymbolicLink() || (lst && !lst.isDirectory() && isLikelyJunction(abs, root))) {
				// External symlink/junction escape detection.
				const esc = detectSymlinkEscape(root, abs);
				if (esc) {
					result.escapesDetected++;
					continue; // never traverse outside workspace
				}
			}

			if (lst.isDirectory() && !entry.isSymbolicLink()) {
				pending.push(abs);
				continue;
			}

			if (lst.size > maxFileBytes) {
				result.skippedTooLarge++;
				continue;
			}

			const classification = classifyPath(rel);
			if (classification.ignoredByVendor || classification.ignoredByCache) {
				result.skippedIgnored++;
				continue;
			}
			if (classification.isBinary) {
				result.skippedBinary++;
				continue;
			}
			// Deep binary sniff for files with text-ish extensions.
			if (classification.classification === "unknown") {
				try {
					const fd = readFileSync(abs).subarray(0, 8192);
					if (isSuperficiallyBinary(fd)) {
						result.skippedBinary++;
						continue;
					}
				} catch {
					continue;
				}
			}
			if (classification.classification === "lockfile" && !options.includeLockfilesAsMetadata) {
				result.skippedIgnored++;
				continue;
			}

			result.files.push({
				workspaceRelativePath: rel,
				absolutePath: abs,
				sizeBytes: lst.size,
				classification,
			});
			options.onProgress?.(result.files.length);
		}
		if (dir !== root) {
			layers.pop();
		}
	}

	result.files.sort((a, b) => (a.workspaceRelativePath < b.workspaceRelativePath ? -1 : 1));
	return result;
}

function isLikelyJunction(abs: string, root: string): boolean {
	if (process.platform !== "win32") return false;
	try {
		const real = realpathSync(abs);
		if (!real.startsWith(path.resolve(root) + path.sep)) return true;
	} catch {
		/* ignore */
	}
	return false;
}
