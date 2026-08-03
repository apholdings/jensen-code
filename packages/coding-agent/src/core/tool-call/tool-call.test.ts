import { describe, expect, it } from "vitest";
import {
	canonicalStableStringify,
	normalizeToolCall,
	recoverTruncatedJson,
	runToolCallPipeline,
	scavengeToolCall,
	sha256Hex,
	validateAgainstSchema,
} from "./index.js";
import type { CanonicalJsonSchema } from "./types.js";

const readSchema: CanonicalJsonSchema = {
	type: "object",
	required: ["path"],
	properties: {
		path: { type: "string" },
		limit: { type: "integer" },
		whole: { type: "boolean" },
	},
};

describe("tool-call normalization", () => {
	it("canonical stable stringify is deterministic", () => {
		expect(canonicalStableStringify({ b: 1, a: [2, { y: true, x: 1 }] })).toBe(
			canonicalStableStringify({ a: [2, { x: 1, y: true }], b: 1 }),
		);
		expect(sha256Hex("x")).toHaveLength(64);
	});

	it("leaves a valid native call unchanged", () => {
		const normalized = normalizeToolCall({
			name: "read",
			rawName: "read",
			toolCallId: "c1",
			parsedArgs: { path: "src/index.ts" },
			schema: readSchema,
		});
		expect(normalized.outcome).toBe("valid_without_repair");
		expect(normalized.name).toBe("read");
		expect(normalized.args.path).toBe("src/index.ts");
	});

	it("coerces string boolean and integer deterministically", () => {
		const normalized = normalizeToolCall({
			name: "read",
			rawName: "read",
			toolCallId: "c2",
			parsedArgs: { path: "a.ts", limit: "42", whole: "true" },
			schema: readSchema,
		});
		expect(normalized.outcome).toBe("repaired_and_valid");
		expect(normalized.args.limit).toBe(42);
		expect(normalized.args.whole).toBe(true);
		expect(normalized.repairs.some((r) => r.repairKind === "coerce-string-integer")).toBe(true);
		expect(normalized.repairs.some((r) => r.repairKind === "coerce-string-boolean")).toBe(true);
	});

	it("collapses a safe singleton into an array", () => {
		const schema: CanonicalJsonSchema = {
			type: "object",
			required: ["files"],
			properties: { files: { type: "array", items: { type: "string" } } },
		};
		const normalized = normalizeToolCall({
			name: "x",
			rawName: "x",
			toolCallId: "c3",
			parsedArgs: { files: "src/a.ts" },
			schema,
		});
		expect(normalized.outcome).toBe("repaired_and_valid");
		expect(normalized.args.files).toEqual(["src/a.ts"]);
		expect(normalized.repairs.some((r) => r.repairKind === "singleton-to-array")).toBe(true);
	});

	it("resolves a known tool alias", () => {
		const normalized = normalizeToolCall({
			name: "ReadFile",
			rawName: "ReadFile",
			toolCallId: "c4",
			parsedArgs: { path: "a.ts" },
			aliasMap: { ReadFile: "read" },
			schema: readSchema,
		});
		expect(normalized.name).toBe("read");
		expect(normalized.repairs.some((r) => r.repairKind === "tool-name-alias")).toBe(true);
	});

	it("fails closed on missing required semantic field", () => {
		const normalized = normalizeToolCall({
			name: "read",
			rawName: "read",
			toolCallId: "c5",
			parsedArgs: {},
			schema: readSchema,
		});
		// path is required and absent => invalid_schema (never invented).
		expect(normalized.outcome).toBe("invalid_schema");
	});

	it("never invents a file path", () => {
		const normalized = normalizeToolCall({
			name: "read",
			rawName: "read",
			toolCallId: "c6",
			parsedArgs: { limit: "3" },
			schema: readSchema,
		});
		expect(normalized.args.path).toBeUndefined();
		expect(normalized.outcome).toBe("invalid_schema");
	});
});

describe("truncated JSON recovery", () => {
	it("closes an unterminated object", () => {
		const rec = recoverTruncatedJson(`{"path":"src/a.ts","limit":3`, {});
		expect(rec.outcome.status).toBe("recovered");
		const value = rec.value as { path: string; limit: number };
		expect(value.path).toBe("src/a.ts");
		expect(value.limit).toBe(3);
	});

	it("closes an unterminated array value string", () => {
		const rec = recoverTruncatedJson(`{"files":["a","b`, {});
		expect(rec.outcome.status).toBe("recovered");
		const value = rec.value as { files: string[] };
		expect(value.files).toEqual(["a", "b"]);
	});

	it("reports unrecoverable when structurally impossible", () => {
		const rec = recoverTruncatedJson(`{"path": 3, "limit": }`, {});
		expect(rec.outcome.status).toBe("unrecoverable");
	});

	it("detects already-valid as not truncated", () => {
		const rec = recoverTruncatedJson(`{"a":1}`, {});
		expect(rec.outcome.status).toBe("not_truncated");
	});
});

describe("schema validation", () => {
	it("enforces required and additionalProperties=false", () => {
		const schema: CanonicalJsonSchema = {
			type: "object",
			required: ["path"],
			properties: { path: { type: "string" } },
			additionalProperties: false,
		};
		expect(validateAgainstSchema({ path: "a" }, schema)).toEqual([]);
		expect(validateAgainstSchema({}, schema).length).toBeGreaterThan(0);
		expect(validateAgainstSchema({ path: "a", extra: 1 }, schema).length).toBeGreaterThan(0);
	});
});

describe("tool-call scavenging", () => {
	const schemaById: Record<string, CanonicalJsonSchema> = { read: readSchema };

	it("does NOT scavenge arbitrary prose", () => {
		const result = scavengeToolCall('please run read on src/a.ts using this json: {"path":"a"}', {
			origin: "provider_tool_channel",
			schemaById,
			ensureToolExists: () => true,
		});
		expect(result).toBeNull();
	});

	it("ignores content that is not an unambiguous envelope", () => {
		const result = scavengeToolCall(
			{ text: "here is some prose", tone: "neutral" },
			{
				origin: "provider_tool_channel",
				schemaById,
			},
		);
		expect(result).toBeNull();
	});

	it("recoverable documented compat envelope validates", () => {
		const wrapped = { tool_call: { name: "read", id: "z", arguments: { path: "src/a.ts" } } };
		const result = scavengeToolCall(wrapped, {
			origin: "documented_compat_envelope",
			schemaById,
		});
		expect(result).not.toBeNull();
		expect(result!.normalized.name).toBe("read");
		expect(result!.normalized.outcome).toBe("valid_without_repair");
	});

	it("rejects unknown tool names", () => {
		const result = scavengeToolCall(
			{ tool_call: { name: "rm_rf", id: "q", arguments: { path: "/" } } },
			{
				origin: "documented_compat_envelope",
				schemaById,
				ensureToolExists: () => false,
			},
		);
		expect(result).toBeNull();
	});
});

describe("pipeline", () => {
	const schemaById: Record<string, CanonicalJsonSchema> = { read: readSchema };
	it("normalizes through the pipeline", () => {
		const res = runToolCallPipeline(
			{ name: "read", toolCallId: "c", arguments: { path: "a.ts", limit: "2" } },
			{ schemaById },
		);
		expect(res.normalized?.outcome).toBe("repaired_and_valid");
		expect(res.normalized?.args.limit).toBe(2);
	});

	it("blocks unknown tools", () => {
		const res = runToolCallPipeline({ name: "nope", toolCallId: "c", arguments: {} }, { schemaById });
		expect(res.normalized).toBeNull();
		expect(res.blockedReason).toContain("unknown tool");
	});
});
