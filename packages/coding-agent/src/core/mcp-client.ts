import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { type ClientRequest, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createInterface, type Interface } from "node:readline";
import { URL } from "node:url";
import {
	classifyMcpToolEffects,
	createMcpCapabilitySnapshot,
	createMcpIdentity,
	detectCapabilityDrift,
	type McpCapabilitySnapshot,
	type McpServerConfig,
	type McpServerIdentity,
	type McpToolEffects,
	type McpToolSchema,
	mcpSha256,
	validateMcpConfig,
	validateMcpToolSchemas,
} from "./mcp.js";

export interface McpJsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}
export interface McpJsonRpcResponse {
	jsonrpc: "2.0";
	id?: string | number | null;
	result?: unknown;
	error?: McpJsonRpcError;
}
export interface McpCallResult {
	result: unknown;
	requestId: string;
	effect: McpToolEffects;
}
export type McpConnectionState = "starting" | "ready" | "degraded" | "reconnecting" | "failed" | "stopped";
export interface McpClientOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	onEvent?: (event: McpHealthEvent) => void;
}
export interface McpHealthEvent {
	state: McpConnectionState;
	reason: string;
	at: string;
	attempt: number;
}

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT = 30_000;

export class McpTransportError extends Error {
	readonly code:
		| "configuration"
		| "timeout"
		| "cancelled"
		| "authentication"
		| "schema"
		| "network"
		| "protocol"
		| "process";
	readonly retryable: boolean;
	constructor(code: McpTransportError["code"], message: string, retryable = false) {
		super(message);
		this.name = "McpTransportError";
		this.code = code;
		this.retryable = retryable;
	}
}

function bounded(value: string): string {
	return value.length > MAX_MESSAGE_BYTES ? value.slice(0, MAX_MESSAGE_BYTES) : value;
}
function timeoutOf(config: McpServerConfig): number {
	return config.requestTimeoutMs ?? DEFAULT_TIMEOUT;
}
function jsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

interface PendingRequest {
	resolve: (response: McpJsonRpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

class StdioTransport {
	private child?: ChildProcessWithoutNullStreams;
	private lines?: Interface;
	private readonly pending = new Map<string, PendingRequest>();
	private stderr = "";
	private nextId = 1;
	private processStart?: number;
	private closed = false;
	constructor(
		private readonly config: McpServerConfig,
		private readonly options: McpClientOptions,
	) {}
	async connect(): Promise<McpServerIdentity> {
		const issues = validateMcpConfig(this.config);
		if (issues.length > 0) throw new McpTransportError("configuration", issues.map((issue) => issue.code).join(", "));
		const env: NodeJS.ProcessEnv = {};
		for (const key of Object.keys(this.config.envRefs ?? {})) {
			if (this.config.envRefs?.[key] && this.options.env?.[this.config.envRefs[key]])
				env[key] = this.options.env[this.config.envRefs[key]];
		}
		const command = this.config.command!;
		this.child = spawn(command, this.config.args ?? [], {
			cwd: this.options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		this.processStart = Date.now();
		this.lines = createInterface({ input: this.child.stdout });
		this.lines.on("line", (line) => this.onLine(line));
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
		});
		this.child.once("exit", (code, signal) => {
			if (!this.closed)
				this.rejectPending(new McpTransportError("process", `MCP process exited (${code ?? signal ?? "unknown"})`));
		});
		const initialize = await this.request(
			"initialize",
			{ protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "jensen", version: "1.6.1" } },
			this.config.startupTimeoutMs ?? DEFAULT_TIMEOUT,
		);
		const protocolVersion =
			isRecord(initialize.result) && typeof initialize.result.protocolVersion === "string"
				? initialize.result.protocolVersion
				: undefined;
		return {
			...createMcpIdentity(this.config),
			processIdentity: `${this.child.pid}:${this.processStart}:${mcpSha256(command)}`,
			connectedAt: new Date().toISOString(),
			protocolVersion,
		};
	}
	private onLine(line: string): void {
		if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
			this.rejectPending(new McpTransportError("protocol", "MCP message exceeds size limit"));
			return;
		}
		try {
			const value = JSON.parse(line) as McpJsonRpcResponse;
			if (value && value.id !== undefined) {
				const pending = this.pending.get(String(value.id));
				if (pending) {
					clearTimeout(pending.timer);
					this.pending.delete(String(value.id));
					pending.resolve(value);
				}
			}
		} catch {
			this.rejectPending(new McpTransportError("protocol", "Invalid MCP JSON-RPC response"));
		}
	}
	request(
		method: string,
		params: unknown,
		timeoutMs = timeoutOf(this.config),
		signal?: AbortSignal,
	): Promise<McpJsonRpcResponse> {
		if (!this.child?.stdin || this.closed)
			return Promise.reject(new McpTransportError("process", "MCP stdio transport is not connected"));
		const id = String(this.nextId++);
		const payload = { jsonrpc: "2.0", id, method, params };
		return new Promise((resolve, reject) => {
			const finishReject = (error: Error) => {
				this.pending.delete(id);
				reject(error);
			};
			const timer = setTimeout(
				() => finishReject(new McpTransportError("timeout", `MCP request timed out: ${method}`, true)),
				timeoutMs,
			);
			this.pending.set(id, { resolve, reject: finishReject, timer });
			const abort = () => {
				clearTimeout(timer);
				finishReject(new McpTransportError("cancelled", `MCP request cancelled: ${method}`));
			};
			if (signal) {
				if (signal.aborted) {
					abort();
					return;
				}
				signal.addEventListener("abort", abort, { once: true });
			}
			this.child!.stdin.write(jsonLine(payload), (error) => {
				if (error) {
					clearTimeout(timer);
					finishReject(new McpTransportError("process", error.message, true));
				}
			});
		});
	}
	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
	async close(): Promise<void> {
		this.closed = true;
		this.rejectPending(new McpTransportError("cancelled", "MCP transport closed"));
		this.lines?.close();
		const child = this.child;
		if (!child || child.exitCode !== null) return;
		if (process.platform === "win32")
			spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		else if (child.pid) {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				try {
					child.kill("SIGTERM");
				} catch {}
			}
		}
		await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
		if (child.exitCode === null) {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {}
		}
	}
}

class HttpTransport {
	private endpoint?: URL;
	private closed = false;
	constructor(
		private readonly config: McpServerConfig,
		private readonly options: McpClientOptions,
	) {}
	async connect(): Promise<McpServerIdentity> {
		const issues = validateMcpConfig(this.config);
		if (issues.length > 0) throw new McpTransportError("configuration", issues.map((issue) => issue.code).join(", "));
		const url = new URL(this.config.url!);
		if (url.protocol === "http:" && process.env.JENSEN_ALLOW_INSECURE_MCP !== "1")
			throw new McpTransportError("configuration", "HTTPS is required");
		const response = await this.send("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "jensen", version: "1.6.1" },
		});
		const protocolVersion =
			isRecord(response.result) && typeof response.result.protocolVersion === "string"
				? response.result.protocolVersion
				: undefined;
		return { ...createMcpIdentity(this.config), connectedAt: new Date().toISOString(), protocolVersion };
	}
	private async send(method: string, params: unknown, signal?: AbortSignal): Promise<McpJsonRpcResponse> {
		if (this.closed) throw new McpTransportError("cancelled", "MCP HTTP transport is closed");
		const url = new URL(this.endpoint ?? this.config.url!);
		const body = jsonLine({ jsonrpc: "2.0", id: randomUUID(), method, params });
		const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
		return new Promise((resolve, reject) => {
			let settled = false;
			const req: ClientRequest = requestFn(
				url,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
						...this.authHeaders(),
					},
					timeout: timeoutOf(this.config),
				},
				(res) => {
					if (res.statusCode === 401 || res.statusCode === 403) {
						reject(new McpTransportError("authentication", `MCP authentication failed (${res.statusCode})`));
						return;
					}
					if ((res.statusCode ?? 500) >= 400) {
						reject(new McpTransportError("network", `MCP HTTP error (${res.statusCode})`, true));
						return;
					}
					let data = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						data += chunk;
						if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES)
							req.destroy(new McpTransportError("protocol", "MCP response exceeds size limit"));
					});
					res.on("end", () => {
						if (settled) return;
						settled = true;
						try {
							const parsed = JSON.parse(data.trim()) as McpJsonRpcResponse;
							if (parsed.error) reject(new McpTransportError("protocol", parsed.error.message));
							else resolve(parsed);
						} catch {
							reject(new McpTransportError("protocol", "MCP response is not JSON"));
						}
					});
				},
			);
			req.on("timeout", () =>
				req.destroy(new McpTransportError("timeout", `MCP request timed out: ${method}`, true)),
			);
			req.on("error", (error) => {
				if (!settled) {
					settled = true;
					reject(
						error instanceof McpTransportError ? error : new McpTransportError("network", error.message, true),
					);
				}
			});
			if (signal) {
				if (signal.aborted) req.destroy(new McpTransportError("cancelled", "MCP request cancelled"));
				else
					signal.addEventListener(
						"abort",
						() => req.destroy(new McpTransportError("cancelled", "MCP request cancelled")),
						{ once: true },
					);
			}
			req.end(body);
		});
	}
	private authHeaders(): Record<string, string> {
		const headers: Record<string, string> = {};
		for (const [name, ref] of Object.entries(this.config.headerRefs ?? {})) {
			const value = this.options.env?.[ref];
			if (value) headers[name] = value;
		}
		return headers;
	}
	request(method: string, params: unknown, signal?: AbortSignal): Promise<McpJsonRpcResponse> {
		return this.send(method, params, signal);
	}
	close(): void {
		this.closed = true;
	}
}

export class McpClient {
	private identity?: McpServerIdentity;
	private snapshot?: McpCapabilitySnapshot;
	private state: McpConnectionState = "starting";
	private readonly stdio?: StdioTransport;
	private readonly http?: HttpTransport;
	constructor(
		private readonly config: McpServerConfig,
		private readonly options: McpClientOptions = {},
	) {
		if (config.transport === "stdio") this.stdio = new StdioTransport(config, options);
		else this.http = new HttpTransport(config, options);
	}
	get health(): McpConnectionState {
		return this.state;
	}
	get capabilitySnapshot(): McpCapabilitySnapshot | undefined {
		return this.snapshot;
	}
	async connect(): Promise<McpCapabilitySnapshot> {
		this.state = "starting";
		this.emit("starting", "connect", 0);
		this.identity = this.stdio ? await this.stdio.connect() : await this.http!.connect();
		const response = await this.requestRaw("tools/list", {});
		const value = isRecord(response.result) ? response.result : {};
		const toolResult = validateMcpToolSchemas(Array.isArray(value.tools) ? (value.tools as McpToolSchema[]) : []);
		if (!toolResult.valid) {
			this.state = "failed";
			throw new McpTransportError("schema", toolResult.rejected.map((issue) => issue.code).join(", "));
		}
		this.snapshot = createMcpCapabilitySnapshot({
			serverId: this.config.serverId,
			protocolVersion: this.identity.protocolVersion,
			tools: toolResult.tools,
			resources: [],
			resourceTemplates: [],
			prompts: [],
			capabilities: {},
		});
		this.state = "ready";
		this.emit("ready", "initialized", 0);
		return this.snapshot;
	}
	async callTool(name: string, argumentsValue: unknown, signal?: AbortSignal): Promise<McpCallResult> {
		if (!this.snapshot) throw new McpTransportError("configuration", "MCP capability snapshot is unavailable");
		const tool = this.snapshot.tools.find((candidate) => candidate.name === name);
		if (!tool) throw new McpTransportError("schema", `MCP tool is not in current capability snapshot: ${name}`);
		const effect = classifyMcpToolEffects(tool);
		const response = await this.requestRaw("tools/call", { name, arguments: argumentsValue }, signal);
		if (!response.result || !isRecord(response.result))
			throw new McpTransportError("schema", "MCP tool result is not an object");
		return { result: response.result, requestId: String(response.id ?? ""), effect };
	}
	listResources(signal?: AbortSignal): Promise<McpJsonRpcResponse> {
		return this.requestRaw("resources/list", {}, signal);
	}
	readResource(uri: string, signal?: AbortSignal): Promise<McpJsonRpcResponse> {
		return this.requestRaw("resources/read", { uri }, signal);
	}
	listPrompts(signal?: AbortSignal): Promise<McpJsonRpcResponse> {
		return this.requestRaw("prompts/list", {}, signal);
	}
	inspectPrompt(
		name: string,
		argumentsValue?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<McpJsonRpcResponse> {
		return this.requestRaw("prompts/get", { name, arguments: argumentsValue }, signal);
	}
	async refreshCapabilities(): Promise<string[]> {
		const previous = this.snapshot;
		const next = await this.connect();
		return previous ? detectCapabilityDrift(previous, next) : [];
	}
	async close(): Promise<void> {
		this.state = "stopped";
		if (this.stdio) await this.stdio.close();
		else this.http?.close();
		this.emit("stopped", "closed", 0);
	}
	private requestRaw(method: string, params: unknown, signal?: AbortSignal): Promise<McpJsonRpcResponse> {
		return this.stdio
			? this.stdio.request(method, params, timeoutOf(this.config), signal)
			: this.http!.request(method, params, signal);
	}
	private emit(state: McpConnectionState, reason: string, attempt: number): void {
		this.options.onEvent?.({ state, reason, attempt, at: new Date().toISOString() });
	}
}

export function createMcpClient(config: McpServerConfig, options?: McpClientOptions): McpClient {
	return new McpClient(config, options);
}
export function redactMcpError(error: unknown): string {
	return bounded(error instanceof Error ? error.message : String(error)).replace(
		/Bearer\s+\S+/gi,
		"Bearer [REDACTED]",
	);
}
