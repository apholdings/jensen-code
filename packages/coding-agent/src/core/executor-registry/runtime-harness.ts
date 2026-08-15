/**
 * Executor Runtime Registration (2.10.0).
 *
 * Minimal production-worthy helper that proves the runtime lifecycle
 * (activate / heartbeat / deactivate) without implementing the full worker
 * daemon. It collects only lightweight, safe local metadata and resource
 * observations; it never polls missions and never reserves resources.
 */

import * as os from "node:os";
import { VERSION } from "../../config.js";
import type { ExecutorControlService } from "./executor-control-service.js";
import type {
	ActivateExecutorInput,
	ExecutorActivationOutcome,
	ExecutorCapabilities,
	ExecutorDeactivateOutcome,
	ExecutorHeartbeatOutcome,
	ExecutorRecord,
	ExecutorResourceSnapshot,
	ExecutorRuntimeProof,
} from "./executor-registry-types.js";

/** Diagnostics-only local runtime metadata. Identity is `runtimeInstanceId`. */
export interface LocalRuntimeMetadata {
	hostname: string;
	pid: number;
	platform: string;
	arch: string;
	processStartedAtMs: number;
	jensenVersion: string;
}

export function collectLocalRuntimeMetadata(): LocalRuntimeMetadata {
	return {
		hostname: os.hostname(),
		pid: process.pid,
		platform: process.platform,
		arch: process.arch,
		processStartedAtMs: Date.now() - Math.floor(process.uptime() * 1000),
		jensenVersion: VERSION,
	};
}

/** Lightweight, non-authoritative resource observation at time T. */
export function collectResourceSnapshot(now: number = Date.now()): ExecutorResourceSnapshot {
	return {
		observedAtMs: now,
		cpuLogicalCount: os.cpus().length,
		memoryTotalBytes: os.totalmem(),
		memoryFreeBytes: os.freemem(),
		gpu: { status: "unavailable", devices: [] },
	};
}

export interface ExecutorRuntimeRegistrationOptions {
	/** Expiry window for each heartbeat (default from service). */
	expiryMs?: number;
}

export class ExecutorRuntimeRegistration {
	private readonly _service: ExecutorControlService;
	private readonly _executorId: string;
	private readonly _expiryMs?: number;
	private _proof?: ExecutorRuntimeProof;

	constructor(service: ExecutorControlService, executorId: string, options: ExecutorRuntimeRegistrationOptions = {}) {
		this._service = service;
		this._executorId = executorId;
		this._expiryMs = options.expiryMs;
	}

	get proof(): ExecutorRuntimeProof | undefined {
		return this._proof;
	}

	get runtimeInstanceId(): string | undefined {
		return this._proof?.runtimeInstanceId;
	}

	get runtimeEpoch(): number | undefined {
		return this._proof?.runtimeEpoch;
	}

	async activate(
		input: Partial<Omit<ActivateExecutorInput, "expiryMs">> & { advertisedCapabilities?: ExecutorCapabilities } = {},
	): Promise<ExecutorActivationOutcome> {
		const metadata = collectLocalRuntimeMetadata();
		const outcome = await this._service.activateExecutor(this._executorId, {
			...metadata,
			resources: input.resources ?? collectResourceSnapshot(),
			expiryMs: this._expiryMs,
			...input,
		});
		this._proof = outcome.proof;
		return outcome;
	}

	async heartbeat(
		input: { resources?: ExecutorResourceSnapshot; advertisedCapabilities?: ExecutorCapabilities } = {},
	): Promise<ExecutorHeartbeatOutcome> {
		return this._service.heartbeatExecutor(this._requireProof(), {
			resources: input.resources ?? collectResourceSnapshot(),
			advertisedCapabilities: input.advertisedCapabilities,
			expiryMs: this._expiryMs,
		});
	}

	async updateCapabilities(capabilities: ExecutorCapabilities): Promise<ExecutorRecord> {
		return this._service.updateRuntimeCapabilities(this._requireProof(), capabilities);
	}

	async deactivate(): Promise<ExecutorDeactivateOutcome> {
		return this._service.deactivateExecutor(this._requireProof());
	}

	private _requireProof(): ExecutorRuntimeProof {
		if (!this._proof) {
			throw new Error(`Executor runtime ${this._executorId} has not been activated`);
		}
		return this._proof;
	}
}
