import { sha256, stableStringify } from "./identity.js";
import type { EvaluationArtifact } from "./types.js";

export interface FailureCluster {
	clusterId: string;
	key: {
		errorCode: string;
		assertionIds: string[];
		eventFingerprints: string[];
		tools: string[];
		phases: string[];
		provider: string;
		platform: string;
		recoveryState: string;
		component: string;
	};
	runIds: string[];
	recurrenceCount: number;
	firstOccurrence: string;
	lastOccurrence: string;
	artifactIds: string[];
}

export function clusterFailure(artifact: EvaluationArtifact): FailureCluster | undefined {
	const failed = artifact.assertions.filter((assertion) => assertion.status !== "pass");
	if (failed.length === 0 && artifact.verdict === "pass") return undefined;
	const key = {
		errorCode:
			failed
				.map((assertion) => assertion.reasonCode)
				.sort()
				.join("|") || artifact.verdict,
		assertionIds: failed.map((assertion) => assertion.assertionId).sort(),
		eventFingerprints: [],
		tools: [],
		phases: [],
		provider: artifact.candidate.provider,
		platform: artifact.run.environmentIdentity.os,
		recoveryState: artifact.run.status,
		component: artifact.scenario.scenarioId,
	};
	const clusterId = `failure-${sha256(stableStringify(key)).slice(0, 16)}`;
	const timestamp = artifact.run.completedAt ?? artifact.run.startedAt;
	return {
		clusterId,
		key,
		runIds: [artifact.run.evaluationRunId],
		recurrenceCount: 1,
		firstOccurrence: timestamp,
		lastOccurrence: timestamp,
		artifactIds: [artifact.artifactHash],
	};
}

export function mergeFailureClusters(clusters: FailureCluster[]): FailureCluster[] {
	const merged = new Map<string, FailureCluster>();
	for (const cluster of clusters) {
		const existing = merged.get(cluster.clusterId);
		if (!existing) {
			merged.set(cluster.clusterId, {
				...cluster,
				runIds: [...cluster.runIds],
				artifactIds: [...cluster.artifactIds],
			});
			continue;
		}
		existing.runIds = [...new Set([...existing.runIds, ...cluster.runIds])].sort();
		existing.artifactIds = [...new Set([...existing.artifactIds, ...cluster.artifactIds])].sort();
		existing.recurrenceCount = existing.runIds.length;
		existing.firstOccurrence =
			existing.firstOccurrence < cluster.firstOccurrence ? existing.firstOccurrence : cluster.firstOccurrence;
		existing.lastOccurrence =
			existing.lastOccurrence > cluster.lastOccurrence ? existing.lastOccurrence : cluster.lastOccurrence;
	}
	return [...merged.values()].sort((left, right) => left.clusterId.localeCompare(right.clusterId));
}
