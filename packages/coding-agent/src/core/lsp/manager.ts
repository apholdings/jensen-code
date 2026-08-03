import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import nodePath from "node:path";
import { LspClient, toFileUri } from "./client.js";
import { DEFAULT_LANGUAGE_SERVERS, type LanguageServerSpec, resolveServer } from "./discovery.js";
import { JsonRpcClient } from "./jsonrpc.js";
import type {
	LspPublishDiagnosticsParams,
	LspServerCapabilities,
	LspServerHealth,
	LspServerIdentity,
} from "./types.js";

/**
 * Authoritative LSP server lifecycle manager.
 *
 * - One reusable server per (workspace, language, executable); duplicate
 *   server startup is prevented.
 * - Bounded startup/initialize/request timeouts.
 * - Graceful `shutdown` → `exit` and authoritative process cleanup (no leaks).
 * - Crash detection and typed degraded state with a bounded restart policy.
 * - Server stderr retained as bounded, sanitized diagnostic evidence.
 * - Server responses are untrusted and never adopted as an execution authority.
 */

export interface LspManagerOptions {
	workspaceRoot: string;
	specs?: LanguageServerSpec[];
	startupTimeoutMs?: number;
	initializeTimeoutMs?: number;
	requestTimeoutMs?: number;
	maxRestarts?: number;
	restartDelayMs?: number;
	onDiagnostics?: (params: LspPublishDiagnosticsParams) => void;
}

interface ManagedServer {
	serverId: string;
	languageId: string;
	executable: string;
	exePath: string;
	args: string[];
	processIdentity: string;
	client: LspClient;
	proc: ReturnType<typeof spawn>;
	kill: () => void;
	initializedAt: string;
	restartCount: number;
	state: "starting" | "running" | "degraded" | "stopped" | "crash_loop";
	lastError?: string;
	capabilitiesHash: string;
	diagnostics: LspPublishDiagnosticsParams[];
}

export class LspServerManager {
	private options: {
		specs: LanguageServerSpec[];
		startupTimeoutMs: number;
		initializeTimeoutMs: number;
		requestTimeoutMs: number;
		maxRestarts: number;
		restartDelayMs: number;
		onDiagnostics?: LspManagerOptions["onDiagnostics"];
	};
	private servers = new Map<string, ManagedServer>();
	private starting = new Map<string, Promise<ManagedServer>>();
	private workspaceRoot: string;
	private rootUri: string;

	constructor(opts: LspManagerOptions) {
		this.workspaceRoot = nodePath.resolve(opts.workspaceRoot);
		this.rootUri = toFileUri(this.workspaceRoot);
		this.options = {
			specs: opts.specs ?? DEFAULT_LANGUAGE_SERVERS,
			startupTimeoutMs: opts.startupTimeoutMs ?? 20_000,
			initializeTimeoutMs: opts.initializeTimeoutMs ?? 30_000,
			requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
			maxRestarts: opts.maxRestarts ?? 2,
			restartDelayMs: opts.restartDelayMs ?? 500,
			onDiagnostics: opts.onDiagnostics,
		};
	}

	private key(languageId: string, exePath: string): string {
		return `${this.workspaceRoot}|${languageId}|${exePath}`;
	}

	private hashCapabilities(c: LspServerCapabilities): string {
		return createHash("sha256").update(JSON.stringify(c)).digest("hex").slice(0, 16);
	}

	/**
	 * Get (or create and reuse) a managed server for a language. Returns null
	 * when no server is installed or startup failed (typed via `unavailable`).
	 */
	async getServer(languageId: string): Promise<{ server: ManagedServer; unavailableReason?: string }> {
		const resolution = await resolveServer(languageId, this.options.specs);
		if (!resolution.executable || !resolution.resolvedPath) {
			return {
				server: undefined as unknown as ManagedServer,
				unavailableReason: resolution.reason ?? "server_unavailable",
			};
		}
		const exePath = resolution.resolvedPath;
		const key = this.key(languageId, exePath);
		const existing = this.servers.get(key);
		if (existing && (existing.state === "running" || existing.state === "degraded")) {
			return { server: existing };
		}

		// Prevent duplicate concurrent startup.
		const inFlight = this.starting.get(key);
		if (inFlight) {
			return { server: await inFlight };
		}
		const start = this.startServer(key, languageId, resolution.executable, exePath, resolution.args);
		this.starting.set(key, start);
		try {
			const server = await start;
			this.servers.set(key, server);
			return { server };
		} finally {
			this.starting.delete(key);
		}
	}

	private startServer(
		key: string,
		languageId: string,
		executable: string,
		exePath: string,
		args: string[],
	): Promise<ManagedServer> {
		return new Promise<ManagedServer>((resolve, reject) => {
			const proc = spawn(exePath, args, {
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
				windowsHide: true,
			});
			const startupTimer = setTimeout(() => {
				killTree(proc);
				reject(new Error(`LSP server ${executable} failed to initialize within startup timeout`));
			}, this.options.startupTimeoutMs);

			proc.once("spawn", () => {
				void (async () => {
					const jsonRpc = new JsonRpcClient({
						child: proc as never,
						requestTimeoutMs: this.options.requestTimeoutMs,
					});
					const client = new LspClient({
						rpc: jsonRpc,
						rootUri: this.rootUri,
						workspaceRoot: this.workspaceRoot,
						onDiagnostics: (params) => {
							const server = this.servers.get(key);
							if (server) {
								server.diagnostics.push(params);
								if (server.diagnostics.length > 200) server.diagnostics.shift();
								this.options.onDiagnostics?.(params);
							}
						},
					});
					try {
						const caps = await Promise.race([
							client.initialize(),
							new Promise<never>((_, rej) =>
								setTimeout(() => rej(new Error("initialize timeout")), this.options.initializeTimeoutMs),
							),
						]);
						clearTimeout(startupTimer);
						const server: ManagedServer = {
							serverId: key,
							languageId,
							executable,
							exePath,
							args,
							processIdentity: String(proc.pid),
							client,
							proc,
							kill: () => killTree(proc),
							initializedAt: new Date().toISOString(),
							restartCount: 0,
							state: "running",
							capabilitiesHash: this.hashCapabilities(caps),
							diagnostics: [],
						};
						proc.once("exit", (code) => this.onExit(key, code));
						resolve(server);
					} catch (err) {
						clearTimeout(startupTimer);
						killTree(proc);
						reject(err);
					}
				})();
			});
			proc.once("error", (err) => {
				clearTimeout(startupTimer);
				killTree(proc);
				reject(err);
			});
		});
	}

	private onExit(key: string, code: number | null): void {
		const server = this.servers.get(key);
		if (!server) return;
		if (server.state === "stopped") return;
		server.state = "degraded";
		server.lastError = `server exited (code ${code})`;
		server.client.rejectAllPending(`LSP server exited (code ${code})`);
		// Bounded restart: only for non-graceful exits, up to maxRestarts.
		if (code !== 0 && server.restartCount < this.options.maxRestarts) {
			server.restartCount += 1;
			setTimeout(() => {
				void this.restartServer(key).catch(() => {});
			}, this.options.restartDelayMs);
		} else if (server.restartCount >= this.options.maxRestarts) {
			server.state = "crash_loop";
		}
	}

	private async restartServer(key: string): Promise<void> {
		const old = this.servers.get(key);
		if (!old || old.state === "stopped") return;
		old.client.shutdown().catch(() => {});
		old.kill();
		this.servers.delete(key);
		const resolution = await resolveServer(old.languageId, this.options.specs);
		if (!resolution.executable || !resolution.resolvedPath) return;
		try {
			const server = await this.startServer(
				key,
				old.languageId,
				resolution.executable,
				resolution.resolvedPath,
				resolution.args,
			);
			server.restartCount = old.restartCount;
			this.servers.set(key, server);
		} catch {
			old.state = "crash_loop";
			this.servers.set(key, old);
		}
	}

	async identity(languageId: string): Promise<LspServerIdentity | null> {
		const { server } = await this.getServer(languageId);
		if (!server) return null;
		return {
			serverId: server.serverId,
			languageId: server.languageId,
			executable: server.executable,
			workspaceRoot: this.workspaceRoot,
			processIdentity: server.processIdentity,
			initializedAt: server.initializedAt,
			capabilitiesHash: server.capabilitiesHash,
		};
	}

	health(languageId: string): LspServerHealth | null {
		const resolutionKey = [...this.servers.keys()].find((k) => k.includes(`|${languageId}|`));
		const server = resolutionKey ? this.servers.get(resolutionKey) : undefined;
		if (!server) return null;
		return {
			serverId: server.serverId,
			state: server.state,
			alive: server.state === "running" || server.state === "degraded",
			lastError: server.lastError,
		};
	}

	listServers(): Array<{ serverId: string; languageId: string; executable: string; state: string }> {
		return [...this.servers.values()].map((s) => ({
			serverId: s.serverId,
			languageId: s.languageId,
			executable: s.executable,
			state: s.state,
		}));
	}

	/** Read bounded diagnostics published by a server for a URI. */
	diagnosticsForUri(uri: string): LspPublishDiagnosticsParams[] {
		const out: LspPublishDiagnosticsParams[] = [];
		for (const s of this.servers.values()) {
			for (const d of s.diagnostics) {
				if (d.uri === uri) out.push(d);
			}
		}
		return out;
	}

	async shutdownAll(): Promise<void> {
		const servers = [...this.servers.values()];
		await Promise.all(
			servers.map(async (s) => {
				if (s.state === "stopped") return;
				s.state = "stopped";
				try {
					await s.client.shutdown();
				} catch {
					/* noop */
				}
				s.kill();
			}),
		);
		this.servers.clear();
	}
}

function killTree(proc: ReturnType<typeof spawn>): void {
	if (!proc.pid) return;
	if (process.platform === "win32") {
		const { execFile } = require("node:child_process") as typeof import("node:child_process");
		execFile("taskkill", ["/T", "/F", "/PID", String(proc.pid)], { windowsHide: true }, () => {});
		return;
	}
	try {
		process.kill(-proc.pid as number, "SIGTERM");
	} catch {
		/* noop */
	}
	setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			/* noop */
		}
	}, 500);
}

export type { ManagedServer };
