import { describe, expect, it } from "vitest";
import { TemporalResolver } from "./temporal.js";

describe("temporal source resolution", () => {
	it("resolves official historical value superseded by later official rebalance", () => {
		const resolver = new TemporalResolver();
		const result = resolver.resolve([
			{
				evidenceId: "a",
				sourceUrl: "https://official.example/2017",
				value: 212,
				effectiveAt: "2017-06-01",
				publishedAt: "2017-06-01",
				authority: 2,
			},
			{
				evidenceId: "b",
				sourceUrl: "https://official.example/2019",
				value: 225,
				effectiveAt: "2019-03-15",
				publishedAt: "2019-03-15",
				authority: 2,
				changeDeclaration: "weapon damage changed from 212 to 225",
			},
		]);
		expect(result.unresolved).toBe(false);
		expect(result.currentValue).toBe(225);
		const classes = Object.fromEntries(result.resolutions.map((r) => [r.evidenceId, r.class]));
		expect(classes.a).toBe("superseded");
		expect(classes.b).toBe("current");
	});

	it("corroborates a maintained current source against an older official rebalance", () => {
		const resolver = new TemporalResolver();
		const result = resolver.resolve([
			{
				evidenceId: "official",
				sourceUrl: "https://official.example/2019",
				value: 225,
				effectiveAt: "2019-03-15",
				authority: 2,
			},
			{
				evidenceId: "maintained",
				sourceUrl: "https://maintained.example/game",
				value: 225,
				isMaintained: true,
				authority: 1,
			},
		]);
		expect(result.unresolved).toBe(false);
		expect(result.currentValue).toBe(225);
	});

	it("keeps undated conflicting community sources unresolved", () => {
		const resolver = new TemporalResolver();
		const result = resolver.resolve([
			{ evidenceId: "c1", sourceUrl: "https://wiki.example/a", value: 100, authority: 0 },
			{ evidenceId: "c2", sourceUrl: "https://wiki.example/b", value: 120, authority: 0 },
		]);
		expect(result.unresolved).toBe(true);
		expect(result.currentValue).toBeUndefined();
		expect(result.resolutions.every((r) => r.class === "contradiction")).toBe(true);
	});

	it("does not let a newer low-authority source override an older official source", () => {
		const resolver = new TemporalResolver();
		// Newer (2026) community source vs older (2019) official with a maintained
		// official current value should keep the official/current value.
		const result = resolver.resolve([
			{
				evidenceId: "official",
				sourceUrl: "https://official.example/2019",
				value: 225,
				effectiveAt: "2019-03-15",
				authority: 2,
			},
			{
				evidenceId: "newer-community",
				sourceUrl: "https://wiki.example/2026",
				value: 500,
				effectiveAt: "2026-01-01",
				authority: 0,
			},
			{
				evidenceId: "maintained",
				sourceUrl: "https://official.example/current",
				value: 225,
				isMaintained: true,
				authority: 2,
			},
		]);
		expect(result.unresolved).toBe(false);
		expect(result.currentValue).toBe(225);
		const classes = Object.fromEntries(result.resolutions.map((r) => [r.evidenceId, r.class]));
		expect(classes.official).toBe("current");
		expect(classes.maintained).toBe("current");
		expect(classes["newer-community"]).toBe("contradiction");
	});

	it("classifies a single undated consistent value as uncertain current", () => {
		const resolver = new TemporalResolver();
		const result = resolver.resolve([
			{ evidenceId: "w1", sourceUrl: "https://wiki.example/a", value: 100, authority: 0 },
		]);
		expect(result.unresolved).toBe(true);
		expect(result.resolutions[0].class).toBe("uncertain_current");
	});
});
