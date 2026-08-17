/**
 * FileOrchestrationStore roster validation regression tests.
 *
 * The store's load-time plan validation must accept operator roster names —
 * the explicit operator set loaded from `getAgentDir()/agents/*.md` — so a
 * roster-based FANOUT plan created through the automatic path stays readable
 * (status/join) through a fresh store. The canonical subagent registry stays
 * the primary authority, a malformed roster file must not break store reads,
 * and names in neither the registry nor the roster are still rejected.
 *
 * Deterministic: no planner, no inference, all state in a temp directory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import {
	createFileOrchestrationStore,
	type FileOrchestrationStore,
	OrchestratorService,
	validateOrchestrationPlan,
} from "../../src/core/orchestration/index.js";
import type { OrchestrationPlan, OrchestrationPlanDocument } from "../../src/core/orchestration/types.js";

let root: string;
let agentDir: string;
let originalAgentDirEnv: string | undefined;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "jensen-orch-store-"));
	agentDir = path.join(root, "agent");
	mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	originalAgentDirEnv = process.env.JENSEN_CODING_AGENT_DIR;
	process.env.JENSEN_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (originalAgentDirEnv === undefined) delete process.env.JENSEN_CODING_AGENT_DIR;
	else process.env.JENSEN_CODING_AGENT_DIR = originalAgentDirEnv;
	rmSync(root, { recursive: true, force: true });
});

function writeOperatorFile(fileName: string, lines: string[]): void {
	writeFileSync(path.join(agentDir, "agents", fileName), lines.join("\n"));
}

function validOperatorFile(): void {
	writeOperatorFile("custom.md", [
		"---",
		"name: custom-op",
		"description: Custom operator.",
		"model: qwen3.8-27b",
		"---",
	]);
}

function rosterPlanDocument(orchestrationId: string, agents: readonly [string, string]): OrchestrationPlanDocument {
	const plan: OrchestrationPlan = {
		schemaVersion: 1,
		orchestrationId,
		parentMissionId: "mission_parent",
		decision: "FANOUT",
		rationale: "independent recon before review",
		nodes: [
			{
				nodeId: "recon",
				role: "investigation",
				nodeKind: "CHILD",
				objective: "Trace the failing flow",
				agent: agents[0],
				executionMode: "observe",
				requirement: "REQUIRED",
				workspaceAccess: "READ_ONLY",
				acceptanceCriteria: [{ id: "root-cause", description: "Root cause identified" }],
				dependencyCriticality: 0,
				status: "PROPOSED",
			},
			{
				nodeId: "review",
				role: "review",
				nodeKind: "REVIEW",
				objective: "Review the findings",
				agent: agents[1],
				executionMode: "observe",
				requirement: "OPTIONAL",
				workspaceAccess: "READ_ONLY",
				acceptanceCriteria: [],
				dependencyCriticality: 0,
				status: "PROPOSED",
			},
		],
		edges: [{ from: "recon", to: "review", kind: "OPTIONAL" }],
		revision: 1,
		state: "DRAFT",
		maxDepth: 2,
		maxChildrenPerNode: 20,
		maxTotalLogicalAgents: 20,
		maxReplans: 2,
		replanCount: 0,
		createdAtMs: 1,
		updatedAtMs: 1,
	};
	return { schemaVersion: 1, plan, revisions: [] };
}

function freshReader(): FileOrchestrationStore {
	return createFileOrchestrationStore(path.join(root, "orchestrations"));
}

describe("FileOrchestrationStore roster validation", () => {
	it("keeps a roster FANOUT plan readable through a fresh store after create (status/join)", async () => {
		validOperatorFile();
		const document = rosterPlanDocument("orch_roster_read", ["investigator", "custom-op"]);

		// The plan is roster-only: without an explicit operator set the
		// canonical registry rejects it, so the store is the only gate left.
		const unhooked = validateOrchestrationPlan(document.plan);
		expect(unhooked.valid).toBe(false);
		expect(unhooked.issues.map((issue) => issue.code)).toContain("ORCHESTRATION_INVALID_ROLE");

		const writer = createFileOrchestrationStore(path.join(root, "orchestrations"));
		expect((await writer.create(document)).status).toBe("created");

		// A later invocation gets a fresh store: the operator set comes from
		// the agent dir roster, not from any in-memory planner hook.
		const reader = freshReader();
		const loaded = await reader.load("orch_roster_read");
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") return;
		expect(loaded.document.plan.nodes.map((node) => node.agent)).toEqual(["investigator", "custom-op"]);

		const service = new OrchestratorService({
			store: reader,
			missions: createFileDurableMissionStore(path.join(root, "missions")),
		});
		const status = await service.status("orch_roster_read");
		expect(status.orchestrationId).toBe("orch_roster_read");
		expect(status.decision).toBe("FANOUT");
		expect(status.nodesTotal).toBe(2);
		const joined = await service.join("orch_roster_read");
		expect(joined.orchestrationId).toBe("orch_roster_read");
		expect(joined.decision).toBe("FANOUT");
		expect(joined.terminal).toBe(false);
		expect(joined.pendingNodeIds).toEqual(["recon", "review"]);
	});

	it("does not break store reads when the roster contains a malformed file", async () => {
		writeOperatorFile("broken.md", ["---", "name: [broken", "description: malformed yaml", "---"]);
		validOperatorFile();
		const document = rosterPlanDocument("orch_roster_broken", ["investigator", "custom-op"]);
		const writer = createFileOrchestrationStore(path.join(root, "orchestrations"));
		expect((await writer.create(document)).status).toBe("created");
		const loaded = await freshReader().load("orch_roster_broken");
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") return;
		expect(loaded.document.plan.nodes.map((node) => node.agent)).toEqual(["investigator", "custom-op"]);
	});

	it("still rejects agents in neither the canonical registry nor the roster on load", async () => {
		validOperatorFile();
		const document = rosterPlanDocument("orch_roster_unknown", ["investigator", "not-a-real-agent"]);
		const writer = createFileOrchestrationStore(path.join(root, "orchestrations"));
		expect((await writer.create(document)).status).toBe("created");
		const loaded = await freshReader().load("orch_roster_unknown");
		expect(loaded.status).toBe("corrupt");
		if (loaded.status !== "corrupt") return;
		expect(loaded.diagnostic).toContain("not-a-real-agent");
	});
});
