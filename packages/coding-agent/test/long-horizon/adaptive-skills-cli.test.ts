/**
 * Typed skills and CLI surface tests.
 *
 * Verifies that the built-in skills validate against the typed manifest schema
 * and that the adaptive CLI surfaces emit deterministic, machine-readable state
 * without exposing secrets.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendEntry, createBudgetLedger } from "../../src/core/long-horizon/adaptive/budget-ledger.js";
import { BUILTIN_SKILLS } from "../../src/core/long-horizon/adaptive/builtin-skills.js";
import {
	defaultRunStateDir,
	ensureRunStateDir,
	handleAdaptiveCommand,
	runStatePath,
} from "../../src/core/long-horizon/adaptive/cli.js";
import { computeEffectiveSkillPolicy, validateSkillManifest } from "../../src/core/long-horizon/adaptive/skills.js";

describe("built-in skills", () => {
	it("every built-in skill passes the manifest schema", () => {
		for (const skill of BUILTIN_SKILLS) {
			const validation = validateSkillManifest(skill);
			expect(validation.valid, `${skill.name}: ${validation.errors.join(",")}`).toBe(true);
		}
	});

	it("built-in skills are observe-only and cannot authorize publication", () => {
		for (const skill of BUILTIN_SKILLS) {
			expect(skill.executionMode).toBe("observe");
			const policy = computeEffectiveSkillPolicy(skill, new Set(skill.allowedTools), true, true);
			expect(policy.canPublish).toBe(false);
			expect(policy.canMutate).toBe(false);
		}
		expect(BUILTIN_SKILLS.map((s) => s.name)).toContain("repository-audit");
		expect(BUILTIN_SKILLS.map((s) => s.name)).toContain("release-readiness-review");
	});
});

describe("adaptive CLI surfaces", () => {
	it("exposes skills list and inspect deterministically", async () => {
		const captured: string[] = [];
		const origLog = console.log;
		const origErr = console.error;
		console.log = (m?: unknown) => captured.push(String(m));
		console.error = () => {};
		try {
			const handled = await handleAdaptiveCommand(["skills", "list"]);
			expect(handled).toBe(true);
			expect(captured.length).toBe(1);
			const parsed = JSON.parse(captured[0]) as Array<{ name: string }>;
			expect(parsed.some((s) => s.name === "repository-audit")).toBe(true);
		} finally {
			console.log = origLog;
			console.error = origErr;
		}
	});

	it("reads a durable ledger and emits budget/stats without secrets", async () => {
		const stateDir = path.join(os.tmpdir(), `jensen-adaptive-cli-${process.pid}`);
		ensureRunStateDir(stateDir);
		const ledger = createBudgetLedger("run-cli");
		const withEntry = appendEntry(ledger, {
			entryId: "e1",
			runId: "run-cli",
			role: "executor",
			resource: "maxToolCalls",
			amount: 3,
			estimatedOrActual: "actual",
			sourceEventId: "evt-1",
			recordedAt: "2026-01-01T00:00:00.000Z",
		}).ledger;
		const ledgerPath = runStatePath("run-cli", "ledger", stateDir);
		mkdirSync(path.dirname(ledgerPath), { recursive: true });
		writeFileSync(ledgerPath, JSON.stringify({ entries: withEntry.entries }), "utf8");

		const origDir = process.env.JENSEN_RUN_STATE_DIR;
		process.env.JENSEN_RUN_STATE_DIR = stateDir;
		const captured: string[] = [];
		const origLog = console.log;
		console.log = (m?: unknown) => captured.push(String(m));
		try {
			const handled = await handleAdaptiveCommand(["run", "stats", "run-cli"]);
			expect(handled).toBe(true);
			const parsed = JSON.parse(captured[0]) as { runId: string; costByRole: Record<string, number> };
			expect(parsed.runId).toBe("run-cli");
			// No secret values are ever emitted (key names like tokensByRole are fine).
			expect(JSON.stringify(parsed)).not.toMatch(/sk-[a-z0-9]{6,}|"apiKey"\s*:|"password"\s*:|Bearer\s+[a-z0-9]/iu);
		} finally {
			console.log = origLog;
			if (origDir === undefined) delete process.env.JENSEN_RUN_STATE_DIR;
			else process.env.JENSEN_RUN_STATE_DIR = origDir;
			expect(defaultRunStateDir().length).toBeGreaterThan(0);
		}
	});
});
