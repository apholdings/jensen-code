/**
 * Shared inference admission service (3.0.0 cross-host bridge).
 *
 * A SMALL local HTTP service on Bucephalus that exposes the central
 * `SharedInferenceScheduler` to remote Jensen runtimes. It is deliberately NOT a
 * general distributed orchestration server: it exposes only inference admission
 * (request/wait/renew/release/cancel) plus a health probe, over structured JSON.
 *
 * Authority: the service wraps a scheduler over the SAME durable ledger local
 * processes use. It never duplicates the scheduling algorithm and never issues
 * independent capacity. Remote clients authenticate with a short-lived,
 * execution-scoped bearer token.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	ADMISSION_PROTOCOL_VERSION,
	type AdmissionErrorCode,
	type AdmissionReleasePayload,
	type AdmissionRenewPayload,
	type AdmissionRequestPayload,
	type AdmissionResponse,
} from "./admission-protocol.js";
import type { SharedInferenceScheduler } from "./scheduler.js";
import type { SharedInferenceResource } from "./types.js";

const MAX_BODY_BYTES = 1_000_000;

export interface AdmissionTokenScope {
	executionId: string;
	remoteTargetId?: string;
	expiresAtMs: number;
}

export interface IssuedAdmissionToken {
	token: string;
	scope: AdmissionTokenScope;
}

export interface SharedInferenceAdmissionServiceOptions {
	scheduler: SharedInferenceScheduler;
	resources: SharedInferenceResource[];
	host?: string;
	port?: number;
	tokenTtlMs?: number;
	now?: () => number;
}

class AdmissionHttpError extends Error {
	readonly status: number;
	readonly code: AdmissionErrorCode;
	constructor(status: number, code: AdmissionErrorCode, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export class SharedInferenceAdmissionService {
	private readonly _scheduler: SharedInferenceScheduler;
	private readonly _resources: SharedInferenceResource[];
	private readonly _host: string;
	private readonly _requestedPort: number;
	private readonly _tokenTtlMs: number;
	private readonly _now: () => number;
	private readonly _tokens = new Map<string, AdmissionTokenScope>();
	private _server?: Server;
	private _port = 0;

	constructor(options: SharedInferenceAdmissionServiceOptions) {
		this._scheduler = options.scheduler;
		this._resources = options.resources;
		this._host = options.host ?? "127.0.0.1";
		this._requestedPort = options.port ?? 0;
		this._tokenTtlMs = options.tokenTtlMs ?? 10 * 60_000;
		this._now = options.now ?? (() => Date.now());
	}

	get port(): number {
		return this._port;
	}

	get url(): string {
		return `http://${this._host}:${this._port}`;
	}

	async start(): Promise<void> {
		await Promise.all(this._resources.map((resource) => this._scheduler.registerResource(resource)));
		this._server = createServer((req, res) => {
			void this._handle(req, res).catch((error) => {
				if (error instanceof AdmissionHttpError) {
					this._send(res, error.status, { kind: "error", code: error.code, message: error.message });
					return;
				}
				this._send(res, 500, {
					kind: "error",
					code: "INTERNAL_ERROR",
					message: error instanceof Error ? error.message : String(error),
				});
			});
		});
		await new Promise<void>((resolve, reject) => {
			this._server!.once("error", reject);
			this._server!.listen(this._requestedPort, this._host, () => {
				const address = this._server!.address();
				this._port = typeof address === "object" && address ? address.port : this._requestedPort;
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		const server = this._server;
		this._server = undefined;
		this._port = 0;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/** Issue a short-lived, execution-scoped token for one remote execution. */
	issueToken(scope: { executionId: string; remoteTargetId?: string; ttlMs?: number }): IssuedAdmissionToken {
		const token = `sched_${randomUUID()}`;
		const fullScope: AdmissionTokenScope = {
			executionId: scope.executionId,
			remoteTargetId: scope.remoteTargetId,
			expiresAtMs: this._now() + (scope.ttlMs ?? this._tokenTtlMs),
		};
		this._tokens.set(token, fullScope);
		return { token, scope: { ...fullScope } };
	}

	revokeToken(token: string): void {
		this._tokens.delete(token);
	}

	// =========================================================================
	// HTTP dispatch
	// =========================================================================

	private async _handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", this.url);
		if (req.method === "GET" && url.pathname === "/v1/health") {
			this._send(res, 200, { ok: true, protocolVersion: ADMISSION_PROTOCOL_VERSION });
			return;
		}

		const scope = this._authorize(req);
		if (!scope) {
			this._send(res, 401, { kind: "error", code: "UNAUTHORIZED", message: "missing or invalid admission token" });
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/request") {
			const body = await this._readBody(req);
			const doc = this._parse(body);
			this._assertExecution(this._str(doc, "executionId"), scope);
			const payload = doc as unknown as AdmissionRequestPayload;
			const logicalAgentId = this._str(doc, "logicalAgentId");
			const provider = this._str(doc, "provider");
			const model = this._str(doc, "model");
			const resource = this._scheduler.resourceFor({ provider, id: model });
			if (!resource) {
				throw new AdmissionHttpError(404, "RESOURCE_NOT_REGISTERED", `no shared resource for ${provider}/${model}`);
			}
			try {
				const outcome = await this._scheduler.enqueue({
					logicalAgentId,
					resource,
					model: { provider, id: model },
					inferenceRequestId: payload.inferenceRequestId,
					missionId: payload.missionId,
					assignmentId: payload.assignmentId,
					executionId: payload.executionId,
					priority: payload.priority,
					dependency: payload.dependency,
					estimatedInputTokens: payload.estimatedInputTokens,
					maxOutputTokens: payload.maxOutputTokens,
				});
				this._send(res, 200, { kind: "request_result", outcome });
				return;
			} catch (error) {
				throw new AdmissionHttpError(
					503,
					"SCHEDULER_UNAVAILABLE",
					error instanceof Error ? error.message : String(error),
				);
			}
		}

		if (req.method === "GET" && url.pathname === "/v1/status") {
			const inferenceRequestId = url.searchParams.get("inferenceRequestId");
			const executionId = url.searchParams.get("executionId");
			if (!inferenceRequestId || !executionId) {
				throw new AdmissionHttpError(400, "MALFORMED_REQUEST", "missing query params");
			}
			this._assertExecution(executionId, scope);
			const status = await this._scheduler.admissionStatus(inferenceRequestId);
			this._send(res, 200, { kind: "status_result", status });
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/release") {
			const body = await this._readBody(req);
			const doc = this._parse(body);
			this._assertExecution(this._str(doc, "executionId"), scope);
			const payload = doc as unknown as AdmissionReleasePayload;
			this._validateAdmitted(payload.admitted);
			const outcome = await this._scheduler.release(payload.admitted, payload.outcome);
			this._send(res, 200, { kind: "release_result", outcome });
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/renew") {
			const body = await this._readBody(req);
			const doc = this._parse(body);
			this._assertExecution(this._str(doc, "executionId"), scope);
			const payload = doc as unknown as AdmissionRenewPayload;
			this._validateAdmitted(payload.admitted);
			const outcome = await this._scheduler.renew(payload.admitted);
			this._send(res, 200, { kind: "renew_result", outcome });
			return;
		}

		if (req.method === "POST" && url.pathname === "/v1/cancel") {
			const body = await this._readBody(req);
			const doc = this._parse(body);
			this._assertExecution(this._str(doc, "executionId"), scope);
			const outcome = await this._scheduler.cancel(this._str(doc, "inferenceRequestId"));
			this._send(res, 200, { kind: "cancel_result", outcome });
			return;
		}

		throw new AdmissionHttpError(404, "MALFORMED_REQUEST", `unknown route ${req.method} ${url.pathname}`);
	}

	private _authorize(req: IncomingMessage): AdmissionTokenScope | undefined {
		const header = req.headers.authorization ?? "";
		const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
		if (!token) return undefined;
		const scope = this._tokens.get(token);
		if (!scope) return undefined;
		if (scope.expiresAtMs <= this._now()) {
			this._tokens.delete(token);
			return undefined;
		}
		return scope;
	}

	private _assertExecution(executionId: unknown, scope: AdmissionTokenScope): void {
		if (typeof executionId !== "string" || executionId !== scope.executionId) {
			throw new AdmissionHttpError(403, "UNAUTHORIZED", "executionId does not match token scope");
		}
	}

	private _str(doc: Record<string, unknown>, key: string): string {
		const value = doc[key];
		if (typeof value !== "string" || value.length === 0) {
			throw new AdmissionHttpError(400, "MALFORMED_REQUEST", `field '${key}' must be a non-empty string`);
		}
		return value;
	}

	private _validateAdmitted(value: unknown): void {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new AdmissionHttpError(400, "MALFORMED_REQUEST", "field 'admitted' must be an object");
		}
		const admitted = value as Record<string, unknown>;
		if (typeof admitted.inferenceRequestId !== "string" || typeof admitted.resourceId !== "string") {
			throw new AdmissionHttpError(
				400,
				"MALFORMED_REQUEST",
				"admitted.inferenceRequestId/resourceId must be strings",
			);
		}
		const lease = admitted.lease;
		if (typeof lease !== "object" || lease === null || Array.isArray(lease)) {
			throw new AdmissionHttpError(400, "MALFORMED_REQUEST", "admitted.lease must be an object");
		}
		const l = lease as Record<string, unknown>;
		if (typeof l.leaseId !== "string" || typeof l.ownerId !== "string") {
			throw new AdmissionHttpError(400, "MALFORMED_REQUEST", "admitted.lease.leaseId/ownerId must be strings");
		}
	}

	private async _readBody(req: IncomingMessage): Promise<unknown> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY_BYTES) throw new AdmissionHttpError(413, "MALFORMED_REQUEST", "request body too large");
			chunks.push(chunk as Buffer);
		}
		const raw = Buffer.concat(chunks).toString("utf8");
		if (!raw.trim()) throw new AdmissionHttpError(400, "MALFORMED_REQUEST", "empty request body");
		try {
			return JSON.parse(raw);
		} catch {
			throw new AdmissionHttpError(400, "MALFORMED_REQUEST", "body is not valid JSON");
		}
	}

	private _parse(body: unknown): Record<string, unknown> {
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			throw new AdmissionHttpError(400, "MALFORMED_REQUEST", "body must be an object");
		}
		const doc = body as Record<string, unknown>;
		if (doc.protocolVersion !== ADMISSION_PROTOCOL_VERSION) {
			throw new AdmissionHttpError(
				400,
				"PROTOCOL_MISMATCH",
				`protocolVersion mismatch: ${String(doc.protocolVersion)}`,
			);
		}
		return doc;
	}

	private _send(res: ServerResponse, status: number, body: unknown): void {
		if (res.headersSent) return;
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	}
}

export type { AdmissionResponse };
