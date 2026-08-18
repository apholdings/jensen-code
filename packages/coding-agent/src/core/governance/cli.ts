import { governancePolicyFromEnv } from "./evaluator.js";
import { FileGovernanceStore, GovernanceService } from "./index.js";

function json(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}
export async function handleGovernanceCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "governance") return false;
	const command = args[1] ?? "policy";
	const service = new GovernanceService({ policy: governancePolicyFromEnv(), store: new FileGovernanceStore() });
	if (command === "policy") {
		json(service.policy);
		return true;
	}
	if (command === "status") {
		const missionId = args[2];
		if (!missionId) {
			json({ error: "GOVERNANCE_STATUS_REQUIRES_MISSION_ID" });
			process.exitCode = 1;
			return true;
		}
		json(
			(await service.snapshot(missionId)) ?? {
				missionId,
				status: "UNKNOWN",
				diagnostic: "ledger_missing_or_corrupt",
			},
		);
		return true;
	}
	if (command === "help") {
		json({ commands: ["governance policy", "governance status <missionId>"] });
		return true;
	}
	json({ error: "UNKNOWN_GOVERNANCE_COMMAND", command });
	process.exitCode = 1;
	return true;
}
