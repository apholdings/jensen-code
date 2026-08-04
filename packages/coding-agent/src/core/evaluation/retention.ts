import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { listArtifacts } from "./artifacts.js";
import { listBaselines } from "./baselines.js";
import { hashJson } from "./identity.js";
import type { EvaluationPruneManifest, EvaluationRetentionPolicy } from "./types.js";

export const DEFAULT_EVALUATION_RETENTION_POLICY: EvaluationRetentionPolicy = {
	policyVersion: 1,
	rules: [
		{ class: "release_baseline", preserveWhenReferenced: true, preserveForRelease: true },
		{ class: "release_gate_evidence", preserveWhenReferenced: true, preserveForRelease: true },
		{ class: "active_comparison", preserveWhenReferenced: true, preserveForRelease: true },
		{ class: "failure_cluster_evidence", preserveWhenReferenced: true, preserveForRelease: false },
		{ class: "human_annotation", preserveWhenReferenced: true, preserveForRelease: false },
		{
			class: "ordinary_completed_run",
			maximumRetentionDays: 30,
			preserveWhenReferenced: true,
			preserveForRelease: false,
		},
		{ class: "failed_run", maximumRetentionDays: 30, preserveWhenReferenced: true, preserveForRelease: false },
		{ class: "cancelled_run", maximumRetentionDays: 7, preserveWhenReferenced: true, preserveForRelease: false },
		{ class: "temporary_sandbox", maximumRetentionDays: 1, preserveWhenReferenced: false, preserveForRelease: false },
		{
			class: "live_provider_trace",
			maximumRetentionDays: 7,
			preserveWhenReferenced: true,
			preserveForRelease: false,
		},
		{ class: "raw_log", maximumRetentionDays: 7, preserveWhenReferenced: false, preserveForRelease: false },
	],
};

export interface RetentionDecision {
	artifactId: string;
	retentionClass: string;
	protected: boolean;
	reasonCode: string;
	estimatedBytes: number;
}

function ruleFor(policy: EvaluationRetentionPolicy, retentionClass: string) {
	return policy.rules.find((rule) => rule.class === retentionClass);
}

export async function classifyEvaluationStore(
	root: string,
	policy = DEFAULT_EVALUATION_RETENTION_POLICY,
): Promise<RetentionDecision[]> {
	const storeRoot = resolve(root);
	const artifacts = await listArtifacts(storeRoot).catch(() => []);
	const baselines = await listBaselines(join(storeRoot, "baselines"));
	const protectedArtifactIds = new Set(baselines.flatMap((baseline) => baseline.artifactIds));
	const decisions: RetentionDecision[] = [];
	for (const artifact of artifacts) {
		const retentionClass = protectedArtifactIds.has(artifact.artifactHash)
			? "release_baseline"
			: artifact.run.status === "failed"
				? "failed_run"
				: artifact.run.status === "cancelled"
					? "cancelled_run"
					: artifact.run.mode === "live"
						? "live_provider_trace"
						: "ordinary_completed_run";
		const rule = ruleFor(policy, retentionClass);
		const bytes = Buffer.byteLength(JSON.stringify(artifact));
		const ageDays = Math.max(0, (Date.now() - Date.parse(artifact.provenance.createdAt)) / 86_400_000);
		const withinRetentionWindow = rule?.maximumRetentionDays !== undefined && ageDays <= rule.maximumRetentionDays;
		decisions.push({
			artifactId: artifact.artifactHash,
			retentionClass,
			protected:
				rule?.preserveForRelease === true ||
				protectedArtifactIds.has(artifact.artifactHash) ||
				withinRetentionWindow,
			reasonCode: protectedArtifactIds.has(artifact.artifactHash)
				? "REFERENCED_BY_ACTIVE_BASELINE"
				: withinRetentionWindow
					? "RETENTION_WINDOW_ACTIVE"
					: "ARTIFACT_CLASS_POLICY",
			estimatedBytes: bytes,
		});
	}
	const temporaryRoot = join(storeRoot, "temporary");
	const entries = await readdir(temporaryRoot, { withFileTypes: true }).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const path = join(temporaryRoot, entry.name);
		const bytes = entry.isFile() ? (await stat(path)).size : 0;
		decisions.push({
			artifactId: `temporary/${entry.name}`,
			retentionClass: "temporary_sandbox",
			protected: false,
			reasonCode: "TEMPORARY_EXPIRED_OR_RECOVERABLE",
			estimatedBytes: bytes,
		});
	}
	return decisions.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

export async function createPruneManifest(
	root: string,
	policy = DEFAULT_EVALUATION_RETENTION_POLICY,
): Promise<EvaluationPruneManifest> {
	const decisions = await classifyEvaluationStore(root, policy);
	const unsigned = {
		policyVersion: policy.policyVersion,
		entries: decisions
			.filter((decision) => !decision.protected)
			.map((decision) => ({
				artifactId: decision.artifactId,
				retentionClass: decision.retentionClass,
				reasonCode: decision.reasonCode,
				estimatedBytes: decision.estimatedBytes,
			})),
		protectedEntries: decisions
			.filter((decision) => decision.protected)
			.map((decision) => ({
				artifactId: decision.artifactId,
				reasonCode: decision.reasonCode,
			})),
	};
	return {
		manifestId: `prune-${hashJson(unsigned).slice(0, 24)}-${randomUUID().slice(0, 8)}`,
		createdAt: new Date().toISOString(),
		...unsigned,
	};
}

export function verifyRetentionPolicy(policy: EvaluationRetentionPolicy): void {
	if (!Number.isInteger(policy.policyVersion) || policy.policyVersion < 1)
		throw new Error("retention policy version is invalid");
	for (const rule of policy.rules) {
		if (!rule.class.trim()) throw new Error("retention class is required");
		if (rule.minimumRetentionDays !== undefined && rule.minimumRetentionDays < 0)
			throw new Error("minimum retention cannot be negative");
		if (rule.maximumRetentionDays !== undefined && rule.maximumRetentionDays < 0)
			throw new Error("maximum retention cannot be negative");
		if (
			rule.minimumRetentionDays !== undefined &&
			rule.maximumRetentionDays !== undefined &&
			rule.minimumRetentionDays > rule.maximumRetentionDays
		)
			throw new Error(`retention bounds are invalid for ${rule.class}`);
	}
}

export async function readRetentionPolicy(path: string): Promise<EvaluationRetentionPolicy> {
	const policy = JSON.parse(await readFile(path, "utf8")) as EvaluationRetentionPolicy;
	verifyRetentionPolicy(policy);
	return policy;
}
