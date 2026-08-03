import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import type { WorkspaceBoundary } from "../safety/boundary.js";
import { type LspClient, toFileUri } from "./client.js";
import { detectLanguage } from "./discovery.js";
import { LspServerManager } from "./manager.js";

/**
 * Shared runtime context for the LSP tools. Owns the server manager and
 * enforces workspace-boundary enforcement on every path input. Lives for the
 * duration of an agent session; `dispose()` shuts down all servers (no leaks).
 */

export interface LspRuntimeOptions {
	workspaceRoot: string;
	boundary: WorkspaceBoundary;
	startupTimeoutMs?: number;
	initializeTimeoutMs?: number;
	requestTimeoutMs?: number;
}

export class LspRuntime {
	readonly workspaceRoot: string;
	readonly boundary: WorkspaceBoundary;
	readonly manager: LspServerManager;

	constructor(opts: LspRuntimeOptions) {
		this.workspaceRoot = nodePath.resolve(opts.workspaceRoot);
		this.boundary = opts.boundary;
		this.manager = new LspServerManager({
			workspaceRoot: this.workspaceRoot,
			startupTimeoutMs: opts.startupTimeoutMs,
			initializeTimeoutMs: opts.initializeTimeoutMs,
			requestTimeoutMs: opts.requestTimeoutMs,
		});
	}

	/** Resolve a workspace-relative path through the boundary. Throws on escape. */
	async resolveFilePath(
		file: string,
		langIdOverride?: string | null,
	): Promise<{
		absPath: string;
		relPath: string;
		languageId: string;
		uri: string;
	}> {
		const abs = await this.boundary.resolveWithin(file);
		const rel = nodePath.relative(this.workspaceRoot, abs).replace(/\\/g, "/");
		let languageId = langIdOverride ?? null;
		if (!languageId) {
			languageId = detectLanguage(abs).languageId ?? "plaintext";
		}
		return { absPath: abs, relPath: rel, languageId, uri: toFileUri(abs) };
	}

	/**
	 * Get a managed server for a language and sync the given document. Returns
	 * `{ client, server }` or `{ unavailableReason }`.
	 */
	async serverForFile(
		file: string,
		languageIdOverride?: string | null,
	): Promise<{
		client?: LspClient;
		serverId?: string;
		absPath?: string;
		uri?: string;
		languageId?: string;
		unavailableReason?: string;
	}> {
		const resolved = await this.resolveFilePath(file, languageIdOverride);
		const { server, unavailableReason } = await this.manager.getServer(resolved.languageId);
		if (unavailableReason || !server) {
			return { unavailableReason: unavailableReason ?? "server_unavailable", languageId: resolved.languageId };
		}
		// Sync current document content.
		const content = await readFile(resolved.absPath, "utf-8").catch(() => null);
		if (content !== null) {
			await server.client.openDocument(resolved.uri, content);
		}
		return {
			client: server.client,
			serverId: server.serverId,
			absPath: resolved.absPath,
			uri: resolved.uri,
			languageId: resolved.languageId,
		};
	}

	async shutdown(): Promise<void> {
		await this.manager.shutdownAll();
	}
}
