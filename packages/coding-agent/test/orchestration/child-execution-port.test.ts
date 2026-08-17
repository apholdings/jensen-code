/**
 * OrchestrationChildExecutionPort — child execution authority port contract
 * and the OrchestratorService option storage/access seam.
 *
 * Deterministic: no real execution, no HTTP or provider calls. A mock port
 * records the structured identity of requests and all state lives in a temp
 * directory. The parent lifecycle executor is intentionally NOT implemented
 * here; these tests cover only the port contract and the service seam.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDurableMissionRecord,
	createMissionRequest,
	type DurableMissionStore,
} from "../../src/core/mission-domain/index.js";
import { createFileDurableMissionStore } from "../../src/core/mission-durable/index.js";
import { createFileOrchestrationStore, OrchestratorService } from "../../src/core/orchestration/index.js";
import type {
	OrchestrationChildExecutionPort,
	OrchestrationChildExecutionReceipt,
	OrchestrationChildExecutionRequest,
	OrchestrationStore,
} from "../../src/core/orchestration/types.js";

interface RecordingPort extends OrchestrationChildExecutionPort {
	requests: OrchestrationChildExecutionRequest[];
}

function recordPort(
	authority: string,
	respond?: (request: OrchestrationChildExecutionRequest) => OrchestrationChildExecutionReceipt,
): RecordingPort {
	const requests: OrchestrationChildExecutionRequest[] = [];
	return {
		authority,
		requests,
		async executeChild(request) {
			requests.push(request);
			return respond ? respond(request) : { accepted: true, authority };
		},
	};
}

describe("OrchestratorService child execution authority seam", () => {
	let base: string;
	let missions: DurableMissionStore;
	let store: OrchestrationStore;

	beforeEach(async () => {
		base = mkdtempSync(path.join(tmpdir(), "jensen-orch-port-"));
		missions = createFileDurableMissionStore(path.join(base, "missions"));
		store = createFileOrchestrationStore(path.join(base, "orchestrations"));
		await missions.create(
			createDurableMissionRecord({
				request: createMissionRequest({
					missionId: "mission_parent",
					objective: "drive the orchestration",
					agent: "worker",
					executionMode: "execute",
					acceptanceCriteria: [],
				}),
				now: 1,
			}),
		);
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("P1 stores the configured port and exposes it through the access seam", () => {
		const port = recordPort("scheduler_authority");
		const service = new OrchestratorService({ store, missions, childExecutionPort: port });
		expect(service.childExecutionPort).toBe(port);
		expect(service.childExecutionPort?.authority).toBe("scheduler_authority");
	});

	it("P2 exposes no port by default (materialized children remain unlaunched)", () => {
		const service = new OrchestratorService({ store, missions });
		expect(service.childExecutionPort).toBeUndefined();
	});

	it("P3 the port contract carries the structured identity of a materialized child", async () => {
		const port = recordPort("scheduler_authority");
		const receipt = await port.executeChild({
			orchestrationId: "orch_1",
			nodeId: "n1",
			childMissionId: "mission_orch_1_n1",
			childSessionId: "child_orch_1_n1",
			workspaceAccess: "WRITE",
		});
		expect(port.requests).toHaveLength(1);
		expect(port.requests[0]).toEqual({
			orchestrationId: "orch_1",
			nodeId: "n1",
			childMissionId: "mission_orch_1_n1",
			childSessionId: "child_orch_1_n1",
			workspaceAccess: "WRITE",
		});
		expect(receipt).toEqual({ accepted: true, authority: "scheduler_authority" });
	});

	it("P4 a port may decline with a structured reason", async () => {
		const port = recordPort("strict_authority", (request) => ({
			accepted: request.workspaceAccess !== "WRITE",
			authority: "strict_authority",
			reason: request.workspaceAccess === "WRITE" ? "workspace write not authorized" : undefined,
		}));
		const accepted = await port.executeChild({
			orchestrationId: "orch_1",
			nodeId: "n1",
			childMissionId: "mission_orch_1_n1",
			childSessionId: "child_orch_1_n1",
			workspaceAccess: "READ_ONLY",
		});
		expect(accepted).toEqual({ accepted: true, authority: "strict_authority" });
		const declined = await port.executeChild({
			orchestrationId: "orch_1",
			nodeId: "n2",
			childMissionId: "mission_orch_1_n2",
			childSessionId: "child_orch_1_n2",
			workspaceAccess: "WRITE",
		});
		expect(declined.accepted).toBe(false);
		expect(declined.authority).toBe("strict_authority");
		expect(declined.reason).toBe("workspace write not authorized");
	});

	it("P5 the request contract names the authority the configured port can be matched against", () => {
		const port = recordPort("scheduler_authority");
		const service = new OrchestratorService({ store, missions, childExecutionPort: port });
		const request = createMissionRequest({
			missionId: "mission_parent",
			objective: "drive the orchestration",
			agent: "worker",
			executionMode: "execute",
			acceptanceCriteria: [],
			orchestrationExecution: {
				orchestrationId: "orch_1",
				childExecutionAuthority: "scheduler_authority",
			},
		});
		const resolved = service.childExecutionPort;
		expect(resolved?.authority).toBe(request.orchestrationExecution?.childExecutionAuthority);
		expect(request.orchestrationExecution?.orchestrationId).toBe("orch_1");
	});
});
