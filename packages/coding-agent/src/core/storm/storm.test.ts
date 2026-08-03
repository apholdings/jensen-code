import type { AgentToolResult } from "@apholdings/jensen-agent-core";
import { describe, expect, it } from "vitest";
import { StormBreaker, TOOL_CALL_STORM_BLOCKED, TOOL_STRATEGY_PIVOT_REQUIRED } from "./index.js";

const result = (text: string): AgentToolResult<any> => ({
	content: [{ type: "text", text }],
	details: {},
});

describe("storm breaker", () => {
	it("classifies a first call as fresh", () => {
		const breaker = new StormBreaker();
		const d = breaker.classify({ toolName: "read", canonicalArgsHash: "h", progressSignals: [], readOnly: true });
		expect(d.stage).toBe("fresh");
		expect(d.execute).toBe(true);
	});

	it("annotates repeated identical read calls with no state change", () => {
		const breaker = new StormBreaker();
		breaker.classify({ toolName: "read", canonicalArgsHash: "h", progressSignals: [], readOnly: true });
		const d = breaker.classify({ toolName: "read", canonicalArgsHash: "h", progressSignals: [], readOnly: true });
		expect(d.stage).toBe("duplicate_annotate");
	});

	it("escalates to reflect then block then pivot", () => {
		const breaker = new StormBreaker();
		let last: ReturnType<StormBreaker["classify"]> | null = null;
		for (let i = 0; i < 7; i++) {
			last = breaker.classify({ toolName: "read", canonicalArgsHash: "h", progressSignals: [], readOnly: true });
		}
		expect(last!.stage).toBe("strategy_pivot_required");
		expect(last!.execute).toBe(false);

		const breaker2 = new StormBreaker();
		let blocked: ReturnType<StormBreaker["classify"]> | null = null;
		for (let i = 0; i < 4; i++) {
			blocked = breaker2.classify({ toolName: "read", canonicalArgsHash: "h", progressSignals: [], readOnly: true });
		}
		expect(blocked!.stage).toBe("storm_blocked");
		const b = blocked!;
		if (b.stage === "storm_blocked") {
			expect(b.errorCode).toBe(TOOL_CALL_STORM_BLOCKED);
			expect(b.execute).toBe(false);
		}
	});

	it("resets duplicate detection when authoritative state changes", () => {
		const breaker = new StormBreaker();
		breaker.classify({ toolName: "read", canonicalArgsHash: "h", progressSignals: [], readOnly: true });
		breaker.classify({ toolName: "read", canonicalArgsHash: "h", progressSignals: [], readOnly: true });
		// New file content hash => authoritative progress.
		const d = breaker.classify({
			toolName: "read",
			canonicalArgsHash: "h",
			progressSignals: [{ kind: "file_content_hash", path: "a.ts", hash: "abc" }],
			readOnly: true,
		});
		expect(d.stage).toBe("fresh");
	});

	it("reuses a prior authoritative result only for read-only calls", () => {
		const breaker = new StormBreaker();
		const prior = result("file contents");
		const opts = {
			readOnly: true,
			progressSignals: [] as unknown[] as never,
			currentValidityFingerprint: "v1",
			priorResult: { result: prior, validityFingerprint: "v1", at: 0 },
		};
		breaker.recordResult({ toolName: "read", canonicalArgsHash: "h", result: prior, validityFingerprint: "v1" });
		// First classify after recording the result is the 1st duplicate → annotate with cached result.
		const d = breaker.classify({ toolName: "read", canonicalArgsHash: "h", ...opts } as never);
		expect(d.stage).toBe("duplicate_annotate");
		if (d.stage === "duplicate_annotate") {
			expect(d.cachedResult?.content[0]).toEqual({ type: "text", text: "file contents" });
		}
	});

	it("never treats mutating calls as reusable duplicates", () => {
		const breaker = new StormBreaker();
		// A mutating call repeated is still blocked, never silently replayed.
		breaker.classify({ toolName: "write", canonicalArgsHash: "h", progressSignals: [], readOnly: false });
		const d = breaker.classify({ toolName: "write", canonicalArgsHash: "h", progressSignals: [], readOnly: false });
		expect(d.stage).toBe("duplicate_annotate");
		if (d.stage === "duplicate_annotate") {
			expect(d.cachedResult).toBeUndefined();
		}
	});

	it("blocks a storm loop and reports typed pivot", () => {
		const breaker = new StormBreaker();
		let pivoted = false;
		for (let i = 0; i < 7; i++) {
			const d = breaker.classify({ toolName: "grep", canonicalArgsHash: "q", progressSignals: [], readOnly: true });
			if (d.stage === "strategy_pivot_required") {
				expect(d.errorCode).toBe(TOOL_STRATEGY_PIVOT_REQUIRED);
				pivoted = true;
			}
		}
		expect(pivoted).toBe(true);
	});
});
