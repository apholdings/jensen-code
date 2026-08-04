import { randomUUID } from "node:crypto";
import { createArtifact, verifyArtifact } from "./artifacts.js";
import { EVALUATOR_VERSION, type EvaluationArtifact } from "./types.js";

function cloneWithoutHash(artifact: EvaluationArtifact): Omit<EvaluationArtifact, "artifactHash"> {
	const { artifactHash: _artifactHash, ...unsigned } = artifact;
	return unsigned;
}

function createReplay(artifact: EvaluationArtifact, evaluatorVersion: string): EvaluationArtifact {
	if (!verifyArtifact(artifact)) throw new Error("cannot replay an invalid evaluation artifact");
	if (artifact.run.status !== "completed") throw new Error("cannot replay an incomplete evaluation");
	if (artifact.evidenceIds.length === 0) throw new Error("cannot replay evaluation without immutable evidence");
	const now = new Date().toISOString();
	return createArtifact({
		...cloneWithoutHash(artifact),
		run: {
			...artifact.run,
			evaluationRunId: randomUUID(),
			startedAt: now,
			completedAt: now,
			status: "completed",
		},
		provenance: {
			createdAt: now,
			sourceRunIds: [artifact.run.evaluationRunId],
			evaluatorVersion,
		},
	});
}

export function replayArtifact(artifact: EvaluationArtifact): EvaluationArtifact {
	return createReplay(artifact, `${EVALUATOR_VERSION}:replay`);
}

export function rescoreArtifact(
	artifact: EvaluationArtifact,
	evaluatorVersion = `${EVALUATOR_VERSION}:rescore`,
): EvaluationArtifact {
	return createReplay(artifact, evaluatorVersion);
}
