/**
 * Executor Registry — deterministic control-plane tests (2.10.0).
 *
 * Tests A..V prove the stable executor identity model, runtime incarnation
 * fencing, liveness, capability/resource advertisement, and corruption
 * isolation using a deterministic clock and in-process store. Multiprocess
 * races and stale fencing across real OS processes are covered separately.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createExecutorRecord,
	type ExecutorCapabilities,
	ExecutorControlService,
	type ExecutorResourceSnapshot,
	FileExecutorRegistry,
	isSafeExecutorId,
} from "../../src/core/executor-registry/index.js";

function makeRoot(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

interface Harness {
	root: string;
	store: FileExecutorRegistry;
	service: ExecutorControlService;
	advance(ms: number): void;
	now(): number;
}

function makeHarness(expiryMs = 30_000): Harness {
	const root = makeRoot("executor-registry-");
	const store = new FileExecutorRegistry({ root });
	let nowValue = 1_000_000;
	const service = new ExecutorControlService({
		store,
		now: () => nowValue,
		expiryMs,
	});
	return {
		root,
		store,
		service,
		now: () => nowValue,
		advance(ms: number) {
			nowValue += ms;
		},
	};
}

function snapshot(observedAtMs: number, cpu = 8): ExecutorResourceSnapshot {
	return {
		observedAtMs,
		cpuLogicalCount: cpu,
		memoryTotalBytes: 32_000_000_000,
		memoryFreeBytes: 16_000_000_000,
		gpu: { status: "unavailable", devices: [] },
	};
}

const CAPS: ExecutorCapabilities = {
	platform: { os: "linux", arch: "x64" },
	execution: ["shell", "git", "filesystem"],
	providers: ["llamacpp-local"],
	models: ["qwen-local"],
	tools: ["read", "bash", "edit", "write"],
	specialized: ["python"],
	extra: ["local-ai"],
};

let h: Harness;

beforeEach(() => {
	h = makeHarness();
});

afterEach(() => {
	rmSync(h.root, { recursive: true, force: true });
});

describe("TEST A — REGISTER_EXECUTOR", () => {
	it("stable definition persists independently of runtime state", async () => {
		const outcome = await h.service.registerExecutor({
			executorId: "qa-local",
			displayName: "QA Local",
			labels: ["linux", "local-ai"],
			configuredCapabilities: CAPS,
		});
		expect(outcome.status).toBe("created");

		const loaded = await h.store.load("qa-local");
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			expect(loaded.record.executorId).toBe("qa-local");
			expect(loaded.record.displayName).toBe("QA Local");
			expect(loaded.record.labels).toEqual(["linux", "local-ai"]);
			expect(loaded.record.retired).toBe(false);
			expect(loaded.record.runtimeEpoch).toBe(0);
			expect(loaded.record.runtime).toBeUndefined();
		}
	});
});

describe("TEST B — REGISTER_IDEMPOTENCE", () => {
	it("compatible registration is deterministic; incompatible is a conflict", async () => {
		const first = await h.service.registerExecutor({
			executorId: "qa-idem",
			labels: ["linux"],
			configuredCapabilities: CAPS,
		});
		expect(first.status).toBe("created");

		const second = await h.service.registerExecutor({
			executorId: "qa-idem",
			labels: ["linux"],
			configuredCapabilities: CAPS,
		});
		expect(second.status).toBe("idempotent");
		expect(second.record.revision).toBe(first.record.revision);

		await expect(h.service.registerExecutor({ executorId: "qa-idem", labels: ["windows"] })).rejects.toMatchObject({
			code: "EXECUTOR_ALREADY_EXISTS",
		});
	});
});

describe("TEST C — UNSAFE_ID", () => {
	it("path traversal and unsafe ids are rejected before any IO", async () => {
		await expect(h.service.registerExecutor({ executorId: "../evil" })).rejects.toMatchObject({
			code: "INVALID_EXECUTOR_ID",
		});
		await expect(h.service.registerExecutor({ executorId: "a/b" })).rejects.toMatchObject({
			code: "INVALID_EXECUTOR_ID",
		});
		await expect(h.service.activateExecutor("../evil")).rejects.toMatchObject({ code: "INVALID_EXECUTOR_ID" });
		expect(isSafeExecutorId("../evil")).toBe(false);
		expect(isSafeExecutorId("qa-ok.1_2")).toBe(true);
	});
});

describe("TEST D — ACTIVATE", () => {
	it("activation allocates runtimeInstanceId and runtimeEpoch 1", async () => {
		await h.service.registerExecutor({ executorId: "qa-act" });
		const outcome = await h.service.activateExecutor("qa-act", { platform: "linux", arch: "x64" });
		expect(outcome.runtimeEpoch).toBe(1);
		expect(outcome.runtimeInstanceId).toMatch(/^runtime_/);
		expect(outcome.proof).toEqual({
			executorId: "qa-act",
			runtimeInstanceId: outcome.runtimeInstanceId,
			runtimeEpoch: 1,
		});

		const detail = await h.service.getExecutor("qa-act");
		expect(detail.status).toBe("ONLINE");
		expect(detail.runtime?.runtimeInstanceId).toBe(outcome.runtimeInstanceId);
	});
});

describe("TEST E — EPOCH_MONOTONIC", () => {
	it("replacement activations strictly increase runtimeEpoch", async () => {
		await h.service.registerExecutor({ executorId: "qa-epoch" });
		const a = await h.service.activateExecutor("qa-epoch");
		expect(a.runtimeEpoch).toBe(1);

		h.advance(30_001); // expire
		const b = await h.service.activateExecutor("qa-epoch");
		expect(b.runtimeEpoch).toBe(2);
		expect(b.runtimeInstanceId).not.toBe(a.runtimeInstanceId);

		h.advance(30_001);
		const c = await h.service.activateExecutor("qa-epoch");
		expect(c.runtimeEpoch).toBe(3);
	});
});

describe("TEST F — ACTIVE_CONFLICT", () => {
	it("a healthy active runtime prevents a second activation", async () => {
		await h.service.registerExecutor({ executorId: "qa-conflict" });
		await h.service.activateExecutor("qa-conflict");
		await expect(h.service.activateExecutor("qa-conflict")).rejects.toMatchObject({
			code: "EXECUTOR_ALREADY_ACTIVE",
		});
	});
});

describe("TEST H — HEARTBEAT", () => {
	it("a valid runtime extends liveness", async () => {
		await h.service.registerExecutor({ executorId: "qa-hb" });
		const act = await h.service.activateExecutor("qa-hb");
		const before = act.expiresAtMs;

		h.advance(10_000);
		const beat = await h.service.heartbeatExecutor(act.proof);
		expect(beat.expiresAtMs).toBeGreaterThan(before);
		expect(beat.runtimeEpoch).toBe(act.runtimeEpoch);
	});
});

describe("TEST I — HEARTBEAT_DOES_NOT_BUMP_EPOCH", () => {
	it("many heartbeats preserve runtimeEpoch and runtimeInstanceId", async () => {
		await h.service.registerExecutor({ executorId: "qa-hb-epoch" });
		const act = await h.service.activateExecutor("qa-hb-epoch");
		for (let i = 0; i < 5; i++) {
			h.advance(1_000);
			await h.service.heartbeatExecutor(act.proof);
		}
		const detail = await h.service.getExecutor("qa-hb-epoch");
		expect(detail.runtimeEpoch).toBe(1);
		expect(detail.runtime?.runtimeInstanceId).toBe(act.runtimeInstanceId);
	});
});

describe("TEST J — STALE_HEARTBEAT", () => {
	it("an old runtime instance is fenced after takeover", async () => {
		await h.service.registerExecutor({ executorId: "qa-stale-hb" });
		const old = await h.service.activateExecutor("qa-stale-hb");
		h.advance(30_001);
		const next = await h.service.activateExecutor("qa-stale-hb");
		expect(next.runtimeEpoch).toBe(2);

		await expect(h.service.heartbeatExecutor(old.proof)).rejects.toMatchObject({
			code: "STALE_EXECUTOR_INSTANCE",
		});
	});
});

describe("TEST K — STALE_CAPABILITY_UPDATE", () => {
	it("an old runtime cannot overwrite newer capabilities", async () => {
		await h.service.registerExecutor({ executorId: "qa-stale-caps" });
		const old = await h.service.activateExecutor("qa-stale-caps");
		h.advance(30_001);
		await h.service.activateExecutor("qa-stale-caps", {
			advertisedCapabilities: { models: ["new-model"] },
		});

		await expect(h.service.updateRuntimeCapabilities(old.proof, { models: ["evil-model"] })).rejects.toMatchObject({
			code: "STALE_EXECUTOR_INSTANCE",
		});

		const detail = await h.service.getExecutor("qa-stale-caps");
		expect(detail.runtime?.advertisedCapabilities.models).toEqual(["new-model"]);
	});
});

describe("TEST L — STALE_DEACTIVATE", () => {
	it("an old runtime cannot deactivate the newer runtime", async () => {
		await h.service.registerExecutor({ executorId: "qa-stale-deact" });
		const old = await h.service.activateExecutor("qa-stale-deact");
		h.advance(30_001);
		const next = await h.service.activateExecutor("qa-stale-deact");

		await expect(h.service.deactivateExecutor(old.proof)).rejects.toMatchObject({
			code: "STALE_EXECUTOR_INSTANCE",
		});
		const detail = await h.service.getExecutor("qa-stale-deact");
		expect(detail.runtime?.runtimeInstanceId).toBe(next.runtimeInstanceId);
	});
});

describe("TEST M — CLEAN_DEACTIVATE", () => {
	it("the current runtime can shut down cleanly and epoch is preserved", async () => {
		await h.service.registerExecutor({ executorId: "qa-deact" });
		const act = await h.service.activateExecutor("qa-deact");
		const outcome = await h.service.deactivateExecutor(act.proof);
		expect(outcome.runtimeEpoch).toBe(1);

		const detail = await h.service.getExecutor("qa-deact");
		expect(detail.runtime).toBeUndefined();
		expect(detail.runtimeEpoch).toBe(1);
		expect(detail.status).toBe("OFFLINE");
	});
});

describe("TEST N — EXPIRED_RUNTIME", () => {
	it("an expired runtime is STALE and cannot heartbeat without re-activation", async () => {
		await h.service.registerExecutor({ executorId: "qa-expired" });
		const act = await h.service.activateExecutor("qa-expired");
		h.advance(30_001);

		const detail = await h.service.getExecutor("qa-expired");
		expect(detail.status).toBe("STALE");
		expect(detail.liveness.heartbeatValid).toBe(false);

		await expect(h.service.heartbeatExecutor(act.proof)).rejects.toMatchObject({
			code: "EXECUTOR_RUNTIME_EXPIRED",
		});
	});
});

describe("TEST O — REACTIVATE_AFTER_EXPIRY", () => {
	it("a new runtime after expiry gets a new instance and higher epoch", async () => {
		await h.service.registerExecutor({ executorId: "qa-reactivate" });
		const old = await h.service.activateExecutor("qa-reactivate");
		h.advance(30_001);
		const next = await h.service.activateExecutor("qa-reactivate");
		expect(next.runtimeInstanceId).not.toBe(old.runtimeInstanceId);
		expect(next.runtimeEpoch).toBe(2);
		expect(next.runtimeEpoch).toBeGreaterThan(old.runtimeEpoch);
	});
});

describe("TEST P — RETIRED_CANNOT_ACTIVATE", () => {
	it("retired executor rejects activation", async () => {
		await h.service.registerExecutor({ executorId: "qa-retired" });
		await h.service.retireExecutor("qa-retired");
		await expect(h.service.activateExecutor("qa-retired")).rejects.toMatchObject({ code: "EXECUTOR_RETIRED" });
	});
});

describe("TEST Q — LIST_EXECUTORS", () => {
	it("represents healthy/stale/offline/retired states", async () => {
		// Activate the soon-to-be-stale executor first, then advance the shared
		// clock so only it lapses; the online executor is activated afterwards.
		await h.service.registerExecutor({ executorId: "qa-stale" });
		await h.service.activateExecutor("qa-stale");
		h.advance(30_001);

		await h.service.registerExecutor({ executorId: "qa-online" });
		await h.service.activateExecutor("qa-online");

		await h.service.registerExecutor({ executorId: "qa-offline" });

		await h.service.registerExecutor({ executorId: "qa-retired" });
		await h.service.retireExecutor("qa-retired");

		const list = await h.service.listExecutors();
		const byId = new Map(list.entries.map((e) => [e.executorId, e.status]));
		expect(byId.get("qa-online")).toBe("ONLINE");
		expect(byId.get("qa-stale")).toBe("STALE");
		expect(byId.get("qa-offline")).toBe("REGISTERED");
		expect(byId.get("qa-retired")).toBe("RETIRED");
	});
});

describe("TEST R — FILTERS", () => {
	it("filters by status/platform/label/capability/provider/model", async () => {
		await h.service.registerExecutor({
			executorId: "qa-filter-a",
			labels: ["linux", "gpu"],
			configuredCapabilities: { providers: ["p-a"], models: ["m-a"], extra: ["gpu-compute"] },
		});
		await h.service.activateExecutor("qa-filter-a", { platform: "linux", arch: "x64" });

		await h.service.registerExecutor({
			executorId: "qa-filter-b",
			labels: ["windows"],
			configuredCapabilities: { providers: ["p-b"], models: ["m-b"] },
		});
		await h.service.activateExecutor("qa-filter-b", { platform: "win32", arch: "x64" });

		expect((await h.service.listExecutors({ filter: { status: "ONLINE" } })).entries).toHaveLength(2);
		expect(
			(await h.service.listExecutors({ filter: { platform: "linux" } })).entries.map((e) => e.executorId),
		).toEqual(["qa-filter-a"]);
		expect((await h.service.listExecutors({ filter: { label: "gpu" } })).entries.map((e) => e.executorId)).toEqual([
			"qa-filter-a",
		]);
		expect(
			(await h.service.listExecutors({ filter: { capability: "gpu-compute" } })).entries.map((e) => e.executorId),
		).toEqual(["qa-filter-a"]);
		expect((await h.service.listExecutors({ filter: { provider: "p-b" } })).entries.map((e) => e.executorId)).toEqual(
			["qa-filter-b"],
		);
		expect((await h.service.listExecutors({ filter: { model: "m-a" } })).entries.map((e) => e.executorId)).toEqual([
			"qa-filter-a",
		]);
	});
});

describe("TEST S — RESOURCE_SNAPSHOT", () => {
	it("stores dynamic snapshot with observation timestamp", async () => {
		await h.service.registerExecutor({ executorId: "qa-res" });
		const obs = snapshot(h.now());
		await h.service.activateExecutor("qa-res", { resources: obs });

		const detail = await h.service.getExecutor("qa-res");
		expect(detail.runtime?.resources?.observedAtMs).toBe(h.now());
		expect(detail.runtime?.resources?.cpuLogicalCount).toBe(8);
	});
});

describe("TEST T — RESOURCE_NOT_RESERVATION", () => {
	it("snapshots are observations, not durable allocations", async () => {
		await h.service.registerExecutor({ executorId: "qa-norez" });
		await h.service.activateExecutor("qa-norez", { resources: snapshot(h.now(), 4) });
		h.advance(30_001);
		const next = await h.service.activateExecutor("qa-norez", { resources: snapshot(h.now(), 8) });

		const detail = await h.service.getExecutor("qa-norez");
		expect(detail.runtime?.resources?.cpuLogicalCount).toBe(8);
		expect(detail.runtime?.resources?.observedAtMs).toBe(next.record.runtime?.resources?.observedAtMs);
		// No allocation counters exist anywhere in the durable record.
		expect(JSON.stringify(detail)).not.toContain("allocated");
	});
});

describe("TEST U — PROVIDER_METADATA", () => {
	it("exposes provider/model ids without secrets", async () => {
		await h.service.registerExecutor({
			executorId: "qa-provider",
			configuredCapabilities: { providers: ["llamacpp-local"], models: ["qwen-local"] },
		});
		const detail = await h.service.getExecutor("qa-provider");
		const serialized = JSON.stringify(detail);
		expect(serialized).toContain("llamacpp-local");
		expect(serialized).toContain("qwen-local");
		expect(serialized.toLowerCase()).not.toContain("apikey");
		expect(serialized.toLowerCase()).not.toContain("secret");
		expect(serialized.toLowerCase()).not.toContain("token");
	});
});

describe("TEST V — CORRUPT_RECORD_ISOLATION", () => {
	it("one corrupt executor does not fabricate state or break healthy listing", async () => {
		await h.service.registerExecutor({ executorId: "qa-healthy" });
		writeFileSync(path.join(h.root, "qa-corrupt.executor.json"), "{ not json");

		const list = await h.service.listExecutors();
		expect(list.entries.map((e) => e.executorId)).toEqual(["qa-healthy"]);
		expect(list.corrupt).toHaveLength(1);
		expect(list.corrupt[0].executorId).toBe("qa-corrupt");

		await expect(h.service.getExecutor("qa-corrupt")).rejects.toMatchObject({ code: "EXECUTOR_CORRUPT" });
	});
});

describe("TEST X — PROCESS_RESTART", () => {
	it("stable executorId persists across store re-instantiation; runtime incarnation changes", async () => {
		await h.service.registerExecutor({ executorId: "qa-restart" });
		const a = await h.service.activateExecutor("qa-restart");
		expect(a.runtimeEpoch).toBe(1);

		// Simulate restart: new store + service over the same root with an
		// advanced clock (old heartbeat now expired).
		h.advance(30_001);
		const store2 = new FileExecutorRegistry({ root: h.root });
		const service2 = new ExecutorControlService({ store: store2, now: () => h.now(), expiryMs: 30_000 });
		const detail = await service2.getExecutor("qa-restart");
		expect(detail.executorId).toBe("qa-restart");
		expect(detail.runtimeEpoch).toBe(1);
		expect(detail.status).toBe("STALE");

		const b = await service2.activateExecutor("qa-restart");
		expect(b.runtimeInstanceId).not.toBe(a.runtimeInstanceId);
		expect(b.runtimeEpoch).toBe(2);
	});
});

describe("createExecutorRecord helper", () => {
	it("normalizes labels and rejects unsafe ids", () => {
		expect(createExecutorRecord({ executorId: "qa", labels: ["b", "a", "a"] }).labels).toEqual(["a", "b"]);
		expect(() => createExecutorRecord({ executorId: "a/b" })).toThrow();
	});
});
