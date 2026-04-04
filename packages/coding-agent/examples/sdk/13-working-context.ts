import { createAgentSession, SessionManager, type WorkingContext } from "@apholdings/jensen-code";

function printContext(label: string, context: WorkingContext): void {
	console.log(`\n${label}`);
	console.log(
		`memory: items=${context.memory.itemCount} stale=${context.memory.staleCount} persisted=${context.memory.isPersisted} scope=${context.memory.scope}`,
	);
	console.log(
		`todo: total=${context.todo.total} completed=${context.todo.completed} inProgress=${context.todo.inProgress ?? "none"} persisted=${context.todo.isPersisted} scope=${context.todo.scope}`,
	);
	console.log(
		`delegated: active=${context.delegatedWork.activeCount} completed=${context.delegatedWork.completedCount} failed=${context.delegatedWork.failedCount} persisted=${context.delegatedWork.isPersisted} scope=${context.delegatedWork.scope}`,
	);
	console.log(`delegated note: ${context.delegatedWork.note}`);
}

async function main(): Promise<void> {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendSessionTodos([
		{ content: "Wire same-process helper", activeForm: "Wiring same-process helper", status: "in_progress" },
		{ content: "Document SDK contract", activeForm: "Documenting SDK contract", status: "completed" },
	]);

	const { session } = await createAgentSession({ sessionManager });

	printContext("1. Current state after restore", session.getWorkingContext());

	session.setMemoryItem("project.goal", "expose working-context current state to SDK callers");
	session.setMemoryItem("project.honesty", "delegated work remains live runtime state only");
	printContext("2. After updating persisted memory", session.getWorkingContext());

	const serialized = JSON.stringify(session.getWorkingContext(), null, 2);
	console.log("\n3. JSON payload");
	console.log(serialized);

	console.log("\nThis same payload shape is shared with:");
	console.log("- interactive working-context UI");
	console.log("- RPC get_working_context");
	console.log("- same-process SDK AgentSession.getWorkingContext()");
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
