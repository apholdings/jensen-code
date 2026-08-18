import { FileGovernanceStore, GovernanceService } from "../../src/core/governance/index.js";

const root = process.argv[2];
if (!root) throw new Error("root required");
const service = new GovernanceService({
	store: new FileGovernanceStore({ root }),
	policy: {
		schemaVersion: 1,
		cloudAllowed: true,
		modelMode: "local_default",
		localModel: { provider: "local", model: "qwen" },
		operator: { maxTurns: 1 },
	},
});
await service.ensureMission("race-mission");
const result = await service.consume("race-mission", {
	eventId: `attempt-${process.pid}`,
	scope: "child",
	resource: "turns",
	amount: 1,
	atMs: Date.now(),
});
console.log(JSON.stringify({ allowed: result.allowed, reason: result.reason }));
