import { sha256, stableStringify } from "./identity.js";
import type {
	ArtifactRuntimeAcceptance,
	EvaluationArtifact,
	EvaluationGateResult,
	ReleaseConvergenceState,
} from "./types.js";

export function createReleaseConvergenceState(
	releaseId: string,
	version: string,
	releaseCommit: string,
): ReleaseConvergenceState {
	const runtimeAcceptance: ArtifactRuntimeAcceptance = {
		source: "pending",
		packedNpm: "pending",
		registryNpm: "pending",
		builtBinary: "pending",
		downloadedBinary: "pending",
	};
	return {
		releaseId,
		version,
		releaseCommit,
		functionalEvaluation: "pending",
		packageBuild: "pending",
		npmPublication: "pending",
		sourceTag: "pending",
		binaryBuild: "pending",
		binarySmoke: "pending",
		assetUpload: "pending",
		assetVerification: "pending",
		githubRelease: "pending",
		runtimeAcceptance,
		finalVerdict: "incomplete",
	};
}

export function checkFunctionalEvaluationGate(artifacts: EvaluationArtifact[]): EvaluationGateResult {
	const checks = [
		{
			checkId: "artifacts_present",
			passed: artifacts.length > 0,
			reason:
				artifacts.length > 0 ? "evaluation artifacts are present" : "functional evaluation produced no artifacts",
		},
		{
			checkId: "deterministic_pass",
			passed: artifacts.length > 0 && artifacts.every((artifact) => artifact.verdict === "pass"),
			reason: "deterministic assertions remain authoritative",
		},
		{
			checkId: "no_flakiness",
			passed: artifacts.every((artifact) => artifact.stability?.classification !== "flaky"),
			reason: "flaky repetitions cannot pass the release gate",
		},
		{
			checkId: "no_safety_failure",
			passed: artifacts.every((artifact) =>
				artifact.assertions.every(
					(assertion) =>
						(assertion.severity !== "critical" && assertion.severity !== "high") || assertion.status === "pass",
				),
			),
			reason: "safety failures cannot be averaged away",
		},
	];
	return {
		gateId: "functional-evaluation",
		passed: checks.every((check) => check.passed),
		checks,
		artifactIds: artifacts.map((artifact) => artifact.artifactHash),
		verdict: checks.every((check) => check.passed) ? "pass" : "fail",
	};
}

export function updateReleaseConvergenceState(
	state: ReleaseConvergenceState,
	update: Partial<
		Omit<ReleaseConvergenceState, "releaseId" | "version" | "releaseCommit" | "finalVerdict" | "runtimeAcceptance">
	> & { runtimeAcceptance?: Partial<ArtifactRuntimeAcceptance> },
): ReleaseConvergenceState {
	const runtimeAcceptance = { ...state.runtimeAcceptance, ...update.runtimeAcceptance };
	const next: ReleaseConvergenceState = {
		...state,
		...update,
		releaseId: state.releaseId,
		version: state.version,
		releaseCommit: state.releaseCommit,
		runtimeAcceptance,
	};
	const required = [
		next.functionalEvaluation,
		next.packageBuild,
		next.npmPublication,
		next.sourceTag,
		next.binaryBuild,
		next.binarySmoke,
		next.assetUpload,
		next.assetVerification,
		next.githubRelease,
	];
	const runtimeRequired = [
		next.runtimeAcceptance.source,
		next.runtimeAcceptance.packedNpm,
		next.runtimeAcceptance.registryNpm,
		next.runtimeAcceptance.builtBinary,
		next.runtimeAcceptance.downloadedBinary,
	];
	if (required.some((value) => value === "failed") || runtimeRequired.some((value) => value === "fail"))
		next.finalVerdict = "blocked";
	else if (
		next.functionalEvaluation === "passed" &&
		next.packageBuild === "passed" &&
		next.npmPublication === "complete" &&
		next.sourceTag === "created" &&
		next.binaryBuild === "passed" &&
		next.binarySmoke === "passed" &&
		next.assetUpload === "complete" &&
		next.assetVerification === "passed" &&
		next.githubRelease === "published" &&
		runtimeRequired.every((value) => value === "pass")
	)
		next.finalVerdict = "pass";
	else next.finalVerdict = "incomplete";
	return next;
}

export function verifyReleaseProvenance(input: {
	releaseCommit: string;
	versionCommit: string;
	tagCommit: string;
	githubReleaseCommit: string;
	binaryManifestCommit: string;
	packageSourceCommit?: string;
	embeddedBinaryCommits?: string[];
}): { valid: boolean; mismatches: string[]; contentHash: string } {
	const values: Record<string, string> = {
		releaseCommit: input.releaseCommit,
		versionCommit: input.versionCommit,
		tagCommit: input.tagCommit,
		githubReleaseCommit: input.githubReleaseCommit,
		binaryManifestCommit: input.binaryManifestCommit,
		...(input.packageSourceCommit ? { packageSourceCommit: input.packageSourceCommit } : {}),
	};
	const mismatches = Object.entries(values)
		.filter(([, value]) => value !== input.releaseCommit)
		.map(([key]) => key);
	for (const commit of input.embeddedBinaryCommits ?? [])
		if (commit !== input.releaseCommit) mismatches.push("embeddedBinaryCommit");
	return { valid: mismatches.length === 0, mismatches, contentHash: sha256(stableStringify(values)) };
}
