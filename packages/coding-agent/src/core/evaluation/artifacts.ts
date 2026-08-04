import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256, stableStringify } from "./identity.js";
import { EVALUATION_SCHEMA_VERSION, EVALUATOR_VERSION, type EvaluationArtifact } from "./types.js";

function artifactPayload(artifact: Omit<EvaluationArtifact, "artifactHash">): string {
	return stableStringify(artifact);
}

export function createArtifact(
	input: Omit<EvaluationArtifact, "schemaVersion" | "evaluatorVersion" | "artifactHash">,
): EvaluationArtifact {
	const unsigned = { ...input, schemaVersion: EVALUATION_SCHEMA_VERSION, evaluatorVersion: EVALUATOR_VERSION };
	return { ...unsigned, artifactHash: sha256(artifactPayload(unsigned)) };
}

export function verifyArtifact(artifact: EvaluationArtifact): boolean {
	const { artifactHash, ...unsigned } = artifact;
	return artifact.schemaVersion === EVALUATION_SCHEMA_VERSION && artifactHash === sha256(artifactPayload(unsigned));
}

export async function writeArtifact(root: string, artifact: EvaluationArtifact): Promise<string> {
	if (!verifyArtifact(artifact)) throw new Error("cannot write invalid evaluation artifact");
	const path = join(root, `${artifact.artifactHash}.json`);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" }).catch(async (error: unknown) => {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = JSON.parse(await readFile(path, "utf8")) as EvaluationArtifact;
		if (!verifyArtifact(existing)) throw new Error("existing artifact is corrupt");
	});
	return artifact.artifactHash;
}

export async function readArtifact(root: string, artifactId: string): Promise<EvaluationArtifact> {
	const artifact = JSON.parse(await readFile(join(root, `${artifactId}.json`), "utf8")) as EvaluationArtifact;
	if (!verifyArtifact(artifact)) throw new Error(`invalid evaluation artifact: ${artifactId}`);
	return artifact;
}
