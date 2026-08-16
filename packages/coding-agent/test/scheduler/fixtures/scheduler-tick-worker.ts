/**
 * Scheduler Foundation — cross-process worker fixture (2.12.0).
 *
 * Runs a single scheduler operation against a shared on-disk root and prints one
 * JSON result line. Used by scheduler-multiprocess.test.ts to prove that
 * concurrent scheduler ticks yield exactly one durable assignment and that
 * concurrent enqueue of the same mission is idempotent.
 */

import { AssignmentControlService, FileAssignmentStore } from "../../../src/core/assignment/index.js";
import { ExecutorControlService, FileExecutorRegistry } from "../../../src/core/executor-registry/index.js";
import { FileDurableMissionStore } from "../../../src/core/mission-durable/index.js";
import { FileSchedulerStore, SchedulerControlService } from "../../../src/core/scheduler/index.js";

function arg(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	return idx === -1 ? undefined : args[idx + 1];
}

function build(root: string) {
	const missions = new FileDurableMissionStore({ root: `${root}/missions` });
	const executors = new ExecutorControlService({
		store: new FileExecutorRegistry({ root: `${root}/executors` }),
		expiryMs: 30_000,
	});
	const assignments = new AssignmentControlService({
		store: new FileAssignmentStore({ root: `${root}/assignments` }),
		missions,
		executors,
	});
	const scheduler = new SchedulerControlService({
		store: new FileSchedulerStore({ root: `${root}/intents` }),
		missions,
		executors,
		assignments,
	});
	return { scheduler };
}

function codeOf(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		return String((error as { code?: unknown }).code);
	}
	return undefined;
}

async function main(): Promise<void> {
	const root = arg(process.argv.slice(2), "--root");
	const op = arg(process.argv.slice(2), "--op");
	if (!root || !op) {
		process.exit(2);
	}

	const { scheduler } = build(root);

	if (op === "tick") {
		try {
			const result = await scheduler.runTick();
			const decision = result.decisions[0];
			process.stdout.write(
				`${JSON.stringify({
					t: "tick_ok",
					assignmentsCreated: result.assignmentsCreated,
					intentsAssigned: result.intentsAssigned,
					decision: decision?.decision,
					executorId: decision?.executorId,
					assignmentId: decision?.assignmentId,
				})}\n`,
			);
		} catch (error) {
			process.stdout.write(
				`${JSON.stringify({ t: "tick_error", code: codeOf(error), message: error instanceof Error ? error.message : String(error) })}\n`,
			);
		}
		return;
	}

	if (op === "enqueue") {
		const missionId = arg(process.argv.slice(2), "--missionId");
		if (!missionId) {
			process.exit(2);
		}
		try {
			const outcome = await scheduler.enqueueIntent(missionId);
			process.stdout.write(
				`${JSON.stringify({ t: "enqueue_ok", status: outcome.status, intentId: outcome.intentId })}\n`,
			);
		} catch (error) {
			process.stdout.write(
				`${JSON.stringify({ t: "enqueue_error", code: codeOf(error), message: error instanceof Error ? error.message : String(error) })}\n`,
			);
		}
		return;
	}

	process.exit(2);
}

void main();
