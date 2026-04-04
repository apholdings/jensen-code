import {
	createAgentSession,
	SessionManager,
	type StructuredMemoryCompareData,
	type StructuredMemoryHistoryData,
} from "@apholdings/jensen-code";

function printHistory(history: StructuredMemoryHistoryData): void {
	console.log(`History model: ${history.historyModel} (${history.branchScope} branch only)`);
	for (const snapshot of history.snapshots) {
		console.log(
			`- ${snapshot.shortId}${snapshot.isCurrent ? " [current]" : ""}: ${snapshot.itemCount} items @ ${snapshot.recordedAt}`,
		);
	}
}

function printCompareResult(label: string, result: StructuredMemoryCompareData): void {
	console.log(`\n${label}`);
	console.log(`status=${result.status} historyModel=${result.historyModel} branchScope=${result.branchScope}`);

	switch (result.status) {
		case "empty_history": {
			console.log("No persisted session_memory snapshots exist on the current branch.");
			return;
		}

		case "initial_snapshot": {
			console.log(
				`Initial snapshot: ${result.target.shortId} (${result.target.itemCount} items). Snapshot-based compare, not an event log.`,
			);
			return;
		}

		case "selector_resolution_failed": {
			for (const issue of result.issues) {
				const candidates = issue.candidates
					.map((candidate) => `[${candidate.shortId}] ${candidate.entryId}`)
					.join(", ");
				console.log(
					`${issue.label} selector failed: ${issue.error} input=${JSON.stringify(issue.input)} matched=${JSON.stringify(issue.matchedInput)}${candidates ? ` candidates=${candidates}` : ""}`,
				);
			}
			return;
		}

		case "ok": {
			console.log(
				`${result.compareMode} compare: ${result.baseline.shortId} -> ${result.target.shortId} sameSnapshot=${result.sameSnapshot}`,
			);
			console.log(
				`diff added=${result.diff.added.length} removed=${result.diff.removed.length} changed=${result.diff.changed.length}`,
			);
			if (result.selectors) {
				console.log(
					`resolved selectors: baseline=${result.selectors.baseline.resolvedId} target=${result.selectors.target.resolvedId}`,
				);
			}
		}
	}
}

async function main(): Promise<void> {
	const { session } = await createAgentSession({
		sessionManager: SessionManager.inMemory(),
	});

	printCompareResult("1. Empty history", session.compareMemorySnapshots());

	session.setMemoryItem("project.goal", "document same-process memory automation");
	printCompareResult("2. Initial snapshot", session.compareMemorySnapshots());

	session.setMemoryItem("project.goal", "ship canonical SDK memory example");
	session.setMemoryItem("project.scope", "current-branch only snapshots");

	const history = session.getStructuredMemoryHistory();
	console.log("\n3. Structured history");
	printHistory(history);

	printCompareResult("4. Adjacent compare", session.compareMemorySnapshots());

	const baselineSelector = `[${history.snapshots[0]!.shortId}]`;
	const targetSelector = history.snapshots[history.snapshots.length - 1]!.entryId;
	printCompareResult(
		"5. Explicit compare",
		session.compareMemorySnapshots({
			baseline: baselineSelector,
			target: targetSelector,
		}),
	);

	printCompareResult(
		"6. Selector resolution failure",
		session.compareMemorySnapshots({
			baseline: "missing-selector",
			target: targetSelector,
		}),
	);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
