import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { LspNotificationMessage, LspRequestMessage, LspResponseMessage } from "./types.js";

/**
 * Minimal JSON-RPC 2.0 transport over a stdio child process, with
 * Content-Length framing and request cancellation. Server output is treated as
 * untrusted data and is never interpreted as instructions.
 *
 * Message-limit guard: a pathological server must not be allowed to buffer
 * unbounded frames in memory.
 */

const MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB per message
const MAX_PENDING_REQUESTS = 128;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface JsonRpcOptions {
	child: ChildProcessWithoutNullStreams;
	onNotification?: (notification: LspNotificationMessage) => void;
	requestTimeoutMs?: number;
}

export class JsonRpcClient {
	private nextId = 1;
	private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; method: string }>();
	private buffer: Buffer = Buffer.alloc(0);
	private child: ChildProcessWithoutNullStreams;
	private onNotification?: (n: LspNotificationMessage) => void;
	private requestTimeoutMs: number;
	private disposed = false;

	constructor(opts: JsonRpcOptions) {
		this.child = opts.child;
		this.onNotification = opts.onNotification;
		this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.child.stdout.on("data", (d: Buffer) => this.onData(d));
		this.child.stderr.on("data", (d: Buffer) => this.captureStderr(d));
	}

	private stderrTail: Buffer = Buffer.alloc(0);

	/** Set/replace the notification handler (e.g. LSP diagnostics routing). */
	setNotificationHandler(handler: ((n: LspNotificationMessage) => void) | undefined): void {
		this.onNotification = handler;
	}

	private captureStderr(d: Buffer): void {
		this.stderrTail = Buffer.concat([this.stderrTail, d]).subarray(-16384);
	}

	getDiagnosticStderr(): string {
		return this.stderrTail.toString("utf-8");
	}

	/** Send a request. Returns a promise resolved/rejected by the response. */
	request<TResult>(method: string, params: unknown, timeoutMs?: number): Promise<TResult> {
		if (this.disposed) return Promise.reject(new Error("jsonrpc transport disposed"));
		if (this.pending.size >= MAX_PENDING_REQUESTS) {
			return Promise.reject(new Error(`too many pending LSP requests (${this.pending.size})`));
		}
		const id = this.nextId++;
		const msg: LspRequestMessage = { jsonrpc: "2.0", id, method, params };
		const timeout = timeoutMs ?? this.requestTimeoutMs;
		return new Promise<TResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP request ${method} (#${id}) timed out after ${timeout}ms`));
			}, timeout);
			this.pending.set(id, {
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r as TResult);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
				method,
			});
			this.send(msg);
		});
	}

	/** Send a notification (no response expected). */
	notify(method: string, params: unknown): void {
		if (this.disposed) return;
		const msg: LspNotificationMessage = { jsonrpc: "2.0", method, params };
		this.send(msg);
	}

	/** Send a server-cancellation $/cancelRequest notification. */
	cancelRequest(id: number): void {
		this.notify("$/cancelRequest", { id });
	}

	/** Reject all pending requests (used on shutdown/crash). */
	rejectAllPending(reason: string): void {
		for (const [, p] of this.pending) p.reject(new Error(reason));
		this.pending.clear();
	}

	private send(msg: unknown): void {
		const body = Buffer.from(JSON.stringify(msg), "utf-8");
		const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
		this.child.stdin.write(Buffer.concat([header, body]));
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (this.buffer.length > MAX_FRAME_BYTES * 2) {
			// Bounded buffer: reject pending and reset to avoid OOM.
			this.rejectAllPending("LSP server flooded transport with oversized frames");
			this.buffer = Buffer.alloc(0);
			return;
		}
		while (true) {
			const { message, consumed } = this.tryParse();
			if (message === null) break;
			this.buffer = this.buffer.subarray(consumed);
			this.dispatch(message);
		}
	}

	private tryParse(): { message: unknown | null; consumed: number } {
		const headerEnd = this.buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return { message: null, consumed: 0 };
		const headerText = this.buffer.subarray(0, headerEnd).toString("ascii");
		const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
		if (!lengthMatch) return { message: null, consumed: 0 };
		const length = Number(lengthMatch[1]);
		const total = headerEnd + 4 + length;
		if (this.buffer.length < total) return { message: null, consumed: 0 };
		const body = this.buffer.subarray(headerEnd + 4, total);
		try {
			return { message: JSON.parse(body.toString("utf-8")), consumed: total };
		} catch {
			return { message: null, consumed: total };
		}
	}

	private dispatch(message: unknown): void {
		const msg = message as Partial<LspRequestMessage & LspResponseMessage & LspNotificationMessage>;
		if (typeof msg.id === "number") {
			// Response
			const pending = this.pending.get(msg.id);
			if (pending) {
				this.pending.delete(msg.id);
				if (msg.error) {
					const err = new Error(`LSP error ${msg.error.code}: ${msg.error.message}`);
					(err as { code?: number }).code = msg.error.code;
					pending.reject(err);
				} else {
					pending.resolve(msg.result);
				}
			}
			return;
		}
		if (msg.id === null) {
			// Server-to-client request (e.g. workspace/applyEdit). Not supported
			// for mutation; respond nothing.
			return;
		}
		// Notification (method present, no id).
		if (typeof msg.method === "string") {
			this.onNotification?.(msg as LspNotificationMessage);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.rejectAllPending("jsonrpc transport disposed");
	}
}
