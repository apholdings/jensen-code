import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface PruneReport {
	mode: "preview" | "execute";
	root: string;
	deleted: string[];
	retained: string[];
	mutationCount: number;
}

export async function pruneEvaluationStore(root: string, execute: boolean): Promise<PruneReport> {
	const storeRoot = resolve(root);
	const temporaryRoot = join(storeRoot, "temporary");
	const entries = await readdir(temporaryRoot, { withFileTypes: true }).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	const deleted = entries.map((entry) => join(temporaryRoot, entry.name)).sort();
	if (execute) for (const path of deleted) await rm(path, { recursive: true, force: true });
	return {
		mode: execute ? "execute" : "preview",
		root: storeRoot,
		deleted,
		retained: [],
		mutationCount: execute ? deleted.length : 0,
	};
}
