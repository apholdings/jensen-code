import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyArtifact } from "./artifacts.js";
import { sha256, stableStringify } from "./identity.js";
import type { EvaluationArtifact } from "./types.js";

export interface EvaluationBaseline {
	baselineId: string;
	artifactIds: string[];
	createdAt: string;
	candidate: EvaluationArtifact["candidate"];
	packId: string;
	packVersion: string;
	contentHash: string;
	status: "active" | "retired";
}

export async function createBaseline(
	root: string,
	input: Omit<EvaluationBaseline, "baselineId" | "contentHash" | "status">,
	artifacts: EvaluationArtifact[],
): Promise<EvaluationBaseline> {
	if (artifacts.length === 0 || artifacts.some((artifact) => !verifyArtifact(artifact) || artifact.verdict !== "pass"))
		throw new Error("baseline requires passing valid artifacts");
	const unsigned = { ...input, status: "active" as const };
	const baseline = {
		...unsigned,
		baselineId: `baseline-${sha256(stableStringify(unsigned)).slice(0, 16)}`,
		contentHash: sha256(stableStringify(unsigned)),
	};
	const path = join(root, `${baseline.baselineId}.json`);
	await mkdir(root, { recursive: true });
	try {
		await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = JSON.parse(await readFile(path, "utf8")) as EvaluationBaseline;
		if (existing.contentHash !== baseline.contentHash) throw new Error("baseline identity collision");
	}
	return baseline;
}

export async function listBaselines(root: string): Promise<EvaluationBaseline[]> {
	const names = await readdir(root).catch(() => [] as string[]);
	const baselines: EvaluationBaseline[] = [];
	for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
		const baseline = JSON.parse(await readFile(join(root, name), "utf8")) as EvaluationBaseline;
		if (baseline.status === "active") baselines.push(baseline);
	}
	return baselines;
}

export async function verifyBaseline(root: string, baselineId: string): Promise<boolean> {
	const baseline = JSON.parse(await readFile(join(root, `${baselineId}.json`), "utf8")) as EvaluationBaseline;
	const { baselineId: storedId, contentHash, ...unsigned } = baseline;
	return storedId === baselineId && baseline.status === "active" && contentHash === sha256(stableStringify(unsigned));
}
