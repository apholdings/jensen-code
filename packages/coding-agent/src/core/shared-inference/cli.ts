/**
 * Shared inference + logical agent CLI (3.0.0 foundation).
 *
 * Operator diagnostics:
 *   jensen inference status
 *   jensen inference queue
 *   jensen inference resources
 *   jensen agents list
 *
 * JSON output is canonical. Never prints API keys or prompt content.
 */

import chalk from "chalk";
import { sharedInferenceResources } from "./config.js";
import { createFileInferenceQueueStore } from "./file-inference-queue-store.js";
import { createFileLogicalAgentStore } from "./file-logical-agent-store.js";
import { LocalSubagentRuntime } from "./runtime.js";
import { SharedInferenceScheduler } from "./scheduler.js";

function printJson(payload: unknown): void {
	console.log(JSON.stringify(payload, null, 2));
}

function buildScheduler(): SharedInferenceScheduler {
	const scheduler = new SharedInferenceScheduler({ store: createFileInferenceQueueStore() });
	void Promise.all(sharedInferenceResources().map((r) => scheduler.registerResource(r))).catch(() => {});
	return scheduler;
}

async function handleInferenceCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "inference") return false;
	const sub = args[1] ?? "status";
	const json = args.includes("--json");

	const scheduler = buildScheduler();
	const runtime = new LocalSubagentRuntime({ store: createFileLogicalAgentStore() });
	const status = await scheduler.status();
	status.agents = await runtime.activityCounts();

	if (sub === "status") {
		if (json) {
			printJson(status);
		} else {
			for (const resource of status.resources) {
				console.log(chalk.bold(`Resource: ${resource.resourceId}`));
				console.log(`  Slots: ${resource.busySlots} / ${resource.capacity} busy`);
				console.log(`  Queue: ${resource.queueDepth}`);
			}
			console.log(
				`Agents: runningInference ${status.agents.runningInference}, waitingInference ${status.agents.waitingInference}, tooling ${status.agents.tooling}, parked ${status.agents.parked}, runnable ${status.agents.runnable}, total ${status.agents.total}`,
			);
		}
		process.exit(0);
	}

	if (sub === "queue") {
		const queue = status.queue.filter((r) => r.state === "QUEUED");
		if (json) {
			printJson(queue);
		} else {
			for (const request of queue) {
				console.log(
					`  ${request.inferenceRequestId} agent=${request.logicalAgentId} pos=${request.position} priority=${request.effectivePriority}`,
				);
			}
		}
		process.exit(0);
	}

	if (sub === "resources") {
		const resources = scheduler.listResources();
		if (json) {
			printJson(resources);
		} else {
			for (const resource of resources) {
				console.log(
					`  ${resource.resourceId}: ${resource.backend}/${resource.model} @ ${resource.location} slots=${resource.capacity}`,
				);
			}
		}
		process.exit(0);
	}

	console.error(chalk.red(`Unknown inference subcommand "${sub}". Supported: status, queue, resources.`));
	process.exit(1);
}

async function handleAgentsCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "agents") return false;
	const sub = args[1] ?? "list";
	const json = args.includes("--json");

	const runtime = new LocalSubagentRuntime({ store: createFileLogicalAgentStore() });
	if (sub === "list") {
		const records = await runtime.list();
		if (json) {
			printJson(records);
		} else {
			for (const record of records) {
				console.log(
					`  ${record.logicalAgentId} ${record.activity}${record.waitingReason ? ` (${record.waitingReason})` : ""} mission=${record.missionId ?? "-"}`,
				);
			}
		}
		process.exit(0);
	}

	console.error(chalk.red(`Unknown agents subcommand "${sub}". Supported: list.`));
	process.exit(1);
}

export { handleAgentsCommand, handleInferenceCommand };
