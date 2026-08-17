import chalk from "chalk";
import { getAgentDir } from "../../config.js";
import { defaultChildSessionDir } from "../durable-child-session/index.js";
import { createFileDurableMissionStore } from "../mission-durable/index.js";
import { OrchestratorService } from "./orchestrator.js";
import { createFileOrchestrationStore } from "./store.js";
import type { OrchestrationNode, OrchestrationPlanner, OrchestrationPlanProposal } from "./types.js";

const COMMANDS = new Set(["preview", "start", "status", "graph", "join", "cancel"]);
function flag(args: string[], name: string): boolean {
	return args.includes(name);
}
function value(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}
function json(valueToPrint: unknown): void {
	process.stdout.write(`${JSON.stringify(valueToPrint, null, 2)}\n`);
}
function error(errorValue: unknown): void {
	const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
	process.stderr.write(`${chalk.red(message)}\n`);
	process.exitCode = 1;
}
function buildService(options: OrchestratorCommandOptions = {}): OrchestratorService {
	const missions = createFileDurableMissionStore();
	return new OrchestratorService({
		store: createFileOrchestrationStore(),
		missions,
		sessionDir: defaultChildSessionDir(getAgentDir()),
		planner: options.planner,
	});
}
function parseProposal(raw: string | undefined): OrchestrationPlanProposal {
	if (!raw)
		return {
			decision: "DIRECT",
			rationale: "No proposal supplied; direct execution is the safe default.",
			nodes: [],
			edges: [],
		};
	const parsed = JSON.parse(raw) as OrchestrationPlanProposal;
	return {
		...parsed,
		nodes: parsed.nodes as OrchestrationNode[],
		edges: parsed.edges,
		rationale: parsed.rationale,
		decision: parsed.decision,
	};
}
export function printOrchestrationUsage(): string {
	return [
		"  orchestrator preview <PARENT_MISSION_ID> [--proposal JSON] [--json]",
		"  orchestrator start <PARENT_MISSION_ID> [--proposal JSON] [--authority NAME] [--json]",
		"  orchestrator status <ORCHESTRATION_ID> [--json]",
		"  orchestrator graph <ORCHESTRATION_ID> [--json]",
		"  orchestrator join <ORCHESTRATION_ID> [--json]",
		"  orchestrator cancel <ORCHESTRATION_ID> [--json]",
		"  (without --proposal the automatic Qwen planner proposes the plan;",
		"   --proposal JSON is the explicit operator debug override)",
	].join("\n");
}
export interface OrchestratorCommandOptions {
	/** Planner for the automatic path. Default: `createQwenPlanner()`. */
	planner?: OrchestrationPlanner;
}
export async function handleOrchestratorCommand(
	args: string[],
	options: OrchestratorCommandOptions = {},
): Promise<boolean> {
	if (args[0] !== "orchestrator") return false;
	if (!args[1] || !COMMANDS.has(args[1])) {
		process.stderr.write(`${printOrchestrationUsage()}\n`);
		process.exitCode = 1;
		return true;
	}
	const service = buildService(options);
	const command = args[1];
	const machine = flag(args, "--json");
	try {
		if (command === "preview" || command === "start") {
			const parentMissionId = args[2];
			if (!parentMissionId) throw new Error("orchestrator command requires <PARENT_MISSION_ID>");
			const proposalRaw = value(args, "--proposal");
			if (proposalRaw === undefined) {
				// Automatic path: the Qwen planner proposes the plan from the
				// parent mission's objective and constraints.
				if (command === "preview") {
					const preview = await service.previewAutomatic(parentMissionId);
					if (machine) json(preview);
					else
						process.stdout.write(
							`${preview.validation.valid ? "valid" : "invalid"} ${preview.plan?.decision ?? "-"}\n`,
						);
					return true;
				}
				const authority = value(args, "--authority");
				const result = await service.startAutomatic(parentMissionId, {
					...(authority === undefined ? {} : { childExecutionAuthority: authority }),
				});
				if (machine) json(result);
				else
					process.stdout.write(
						`started ${result.plan.orchestrationId} materialized=${result.materializedMissionIds.length}\n`,
					);
				return true;
			}
			const proposal = parseProposal(proposalRaw);
			if (command === "preview") {
				const preview = await service.preview({ parentMissionId, proposal });
				if (machine) json(preview);
				else
					process.stdout.write(
						`${preview.validation.valid ? "valid" : "invalid"} ${preview.plan?.decision ?? "-"}\n`,
					);
				return true;
			}
			const created = await service.create({ parentMissionId, proposal });
			const result = await service.materializeReady(created.orchestrationId);
			if (machine) json(result);
			else
				process.stdout.write(
					`started ${created.orchestrationId} materialized=${result.materializedMissionIds.length}\n`,
				);
			return true;
		}
		const orchestrationId = args[2];
		if (!orchestrationId) throw new Error(`${command} requires <ORCHESTRATION_ID>`);
		if (command === "status") {
			const result = await service.status(orchestrationId);
			if (machine) json(result);
			else
				process.stdout.write(
					`${result.orchestrationId} [${result.state}] nodes=${result.nodesTotal} materialized=${result.childrenMaterialized} blocked=${result.childrenBlocked}\n`,
				);
			return true;
		}
		if (command === "graph") {
			const result = (await service.status(orchestrationId)).graph;
			if (machine) json(result);
			else
				for (const node of result)
					process.stdout.write(
						`${node.nodeId} [${node.status}] role=${node.role}${node.reason ? ` reason=${node.reason}` : ""}${node.waitingFor.length ? ` waits=${node.waitingFor.join(",")}` : ""}\n`,
					);
			return true;
		}
		if (command === "join") {
			const result = await service.join(orchestrationId);
			if (machine) json(result);
			else
				process.stdout.write(
					`${result.orchestrationId} [${result.state}] terminal=${result.terminal} completed=${result.completedNodeIds.length}\n`,
				);
			return true;
		}
		const result = await service.cancel(orchestrationId);
		if (machine) json(result);
		else process.stdout.write(`${result.orchestrationId} [${result.state}] cancelled\n`);
		return true;
	} catch (caught) {
		error(caught);
		return true;
	}
}
