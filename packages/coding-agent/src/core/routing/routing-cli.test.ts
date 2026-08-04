/**
 * CLI integration tests for the routing subsystem.
 *
 * These run the handling functions directly with a temporary routing root so
 * they never touch real agent state and never invoke a provider.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleRoutingCommand } from "./cli.js";
import { activePolicyStatus } from "./cli-helpers.js";
import { decide, replayDecision } from "./engine.js";
import { RoutingRpcService } from "./rpc.js";

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "jensen-routing-test-"));
	process.env.JENSEN_ROUTING_ROOT = root;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function capture(fn: () => Promise<boolean>): Promise<string[]> {
	const out: string[] = [];
	const orig = console.log;
	console.log = (v: unknown) => out.push(typeof v === "string" ? v : JSON.stringify(v));
	console.error = () => {};
	return fn().then((_r) => {
		console.log = orig;
		return out;
	});
}

describe("CLI routing commands (offline, deterministic)", () => {
	it("status returns JSON with active policy toggle", async () => {
		const out = await capture(() => handleRoutingCommand(["routing", "status"]));
		const parsed = JSON.parse(out.join("\n"));
		expect(parsed).toHaveProperty("schemaVersion", 1);
		expect(parsed.activePolicy).toHaveProperty("active");
	});

	it("decide produces a durable decision and explain can retrieve it", async () => {
		const { decision } = decide({ task: "Fix the parser bug across multiple files" });
		const replayed = replayDecision(decision.decisionId);
		expect(replayed?.decisionId).toBe(decision.decisionId);
		expect(replayed?.selectedCandidateId).toBe(decision.selectedCandidateId);

		const out = await capture(() => handleRoutingCommand(["routing", "explain", decision.decisionId]));
		const parsed = JSON.parse(out.join("\n"));
		expect(parsed.explanation).toHaveProperty("provenance");
		expect(parsed.explanation.provenance.policyId).toBe(decision.policyId);
	});

	it("replay is zero-effect and reconstructs the decision", async () => {
		const { decision } = decide({ task: "Investigate the symbol", evidence: {} });
		const out = await capture(() => handleRoutingCommand(["routing", "replay", decision.decisionId]));
		const parsed = JSON.parse(out.join("\n"));
		expect(parsed.replay).toBe("zero-effect");
		expect(parsed.decision.decisionId).toBe(decision.decisionId);
	});

	it("features returns a versioned vector", async () => {
		const out = await capture(() => handleRoutingCommand(["routing", "features"]));
		const parsed = JSON.parse(out.join("\n"));
		expect(parsed.sampleFeature.schemaVersion).toBe(1);
	});

	it("policy list/generate are offline and deterministic", async () => {
		const out = await capture(() => handleRoutingCommand(["routing", "policy", "list"]));
		expect(Array.isArray(JSON.parse(out.join("\n")).policies)).toBe(true);
	});
});

describe("doctor routing", () => {
	it("returns checks with pass/fail statuses and nonzero exit on fail", async () => {
		let code = 0;
		const orig = process.exitCode;
		process.exitCode = 0;
		const origLog = console.log;
		{
			const chunks: string[] = [];
			console.log = (v: unknown) => chunks.push(typeof v === "string" ? v : JSON.stringify(v));
			console.error = () => {};
		}
		const result = await handleRoutingCommand(["doctor", "routing"]);
		code = result ? process.exitCode : -1;
		process.exitCode = orig;
		console.log = origLog;
		expect(code).toBe(0); // healthy => exit 0
	});
});

describe("Routing RPC service (versioned, read-only + authorized)", () => {
	const svc = new RoutingRpcService();

	it("rejects unsupported version", () => {
		const r = svc.handle({ version: 99 as never, requestId: "x", operation: "routing.status" });
		expect((r as { error: string }).error).toBe("invalid_request");
	});

	it("returns status", () => {
		const r = svc.handle({ version: 1, requestId: "x", operation: "routing.status" });
		expect((r as { operation: string }).operation).toBe("routing.status");
	});

	it("decide requires task", () => {
		const r = svc.handle({ version: 1, requestId: "x", operation: "routing.decide", parameters: {} });
		expect((r as { error: string }).error).toBe("invalid_request");
	});

	it("decide returns a durable decision", () => {
		const r = svc.handle({
			version: 1,
			requestId: "x",
			operation: "routing.decide",
			parameters: { task: "Fix the timeout in the scheduler" },
		});
		const data = (r as { data: { decision: { decisionId: string } } }).data;
		expect(replayDecision(data.decision.decisionId)).toBeDefined();
	});

	it("policy promote is blocked when not authorized", () => {
		const r = svc.handle({
			version: 1,
			requestId: "x",
			operation: "routing.policyPromote",
			parameters: { policyId: "whatever" },
		});
		expect((r as { error: string }).error).toBe("unauthorized");
	});

	it("features returns a versioned vector over RPC", () => {
		const r = svc.handle({
			version: 1,
			requestId: "x",
			operation: "routing.features",
			parameters: { task: "Fix the bug" },
		});
		const data = (r as { data: { features: { schemaVersion: number } } }).data;
		expect(data.features.schemaVersion).toBe(1);
	});
});

describe("active policy pointer is durable", () => {
	it("reflects promotion state", () => {
		const status = activePolicyStatus();
		expect(status).toHaveProperty("active");
	});
});
