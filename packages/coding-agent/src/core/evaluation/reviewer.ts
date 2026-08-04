import { randomUUID } from "node:crypto";
import { hashJson } from "./identity.js";
import type {
	EvaluationArtifact,
	EvaluationEvent,
	EvaluationReviewerAssignment,
	SemanticEvaluationResult,
} from "./types.js";

export interface EvaluationEvidencePacket {
	evidencePacketId: string;
	candidateEvaluationRunId: string;
	scenarioId: string;
	assertions: EvaluationArtifact["assertions"];
	metrics: EvaluationArtifact["metrics"];
	evidenceIds: string[];
	redactedCandidateIdentity: string;
	createdAt: string;
	contentHash: string;
}

export interface EvaluationReviewerOutput {
	status: "pass" | "fail" | "uncertain" | "invalid" | "unavailable";
	dimensions: Record<string, number | undefined>;
	rationale: string;
	uncertainty?: number;
}

export interface EvaluationReviewer {
	readonly reviewerId: string;
	execute(input: {
		assignment: EvaluationReviewerAssignment;
		packet: EvaluationEvidencePacket;
		signal?: AbortSignal;
	}): Promise<EvaluationReviewerOutput>;
}

export interface EvaluationReviewerResult {
	assignment: EvaluationReviewerAssignment;
	semanticResult: SemanticEvaluationResult;
	events: EvaluationEvent[];
}

const PROMPT_INJECTION_PATTERN =
	/(?:ignore|disregard|override)\s+(?:all|any|the)\s+(?:previous|above|evaluation|reviewer)|reveal\s+(?:hidden|system)|mark\s+(?:this|the)\s+as\s+pass/i;

export function createEvidencePacket(artifact: EvaluationArtifact): EvaluationEvidencePacket {
	const packet = {
		evidencePacketId: `evidence-${randomUUID()}`,
		candidateEvaluationRunId: artifact.run.evaluationRunId,
		scenarioId: artifact.scenario.scenarioId,
		assertions: artifact.assertions,
		metrics: artifact.metrics,
		evidenceIds: [...artifact.evidenceIds],
		redactedCandidateIdentity: hashJson({
			scenario: artifact.scenario,
			candidate: artifact.candidate.providerProfile,
		}),
		createdAt: new Date().toISOString(),
	};
	return { ...packet, contentHash: hashJson(packet) };
}

function validateOutput(output: EvaluationReviewerOutput): void {
	if (!["pass", "fail", "uncertain", "invalid", "unavailable"].includes(output.status))
		throw new Error("reviewer output status is invalid");
	if (typeof output.rationale !== "string" || output.rationale.length > 4_000)
		throw new Error("reviewer rationale is not bounded");
	if (PROMPT_INJECTION_PATTERN.test(output.rationale)) throw new Error("reviewer prompt-injection content detected");
	if (output.uncertainty !== undefined && (output.uncertainty < 0 || output.uncertainty > 1))
		throw new Error("reviewer uncertainty must be between 0 and 1");
	for (const value of Object.values(output.dimensions)) {
		if (value !== undefined && !Number.isFinite(value)) throw new Error("reviewer dimension must be finite");
	}
}

export async function runIndependentReviewer(input: {
	artifact: EvaluationArtifact;
	reviewer: EvaluationReviewer;
	rubricId: string;
	rubricVersion: number;
	reviewerDefinition: string;
	signal?: AbortSignal;
}): Promise<EvaluationReviewerResult> {
	if (input.reviewer.reviewerId === input.artifact.candidate.providerProfile)
		throw new Error("reviewer identity must differ from candidate identity");
	if (input.artifact.run.status !== "completed") throw new Error("reviewer requires a completed candidate run");
	const packet = createEvidencePacket(input.artifact);
	const assignment: EvaluationReviewerAssignment = {
		reviewerRunId: randomUUID(),
		candidateEvaluationRunId: input.artifact.run.evaluationRunId,
		reviewerDefinition: input.reviewerDefinition,
		rubricId: input.rubricId,
		rubricVersion: input.rubricVersion,
		evidencePacketId: packet.evidencePacketId,
	};
	const events: EvaluationEvent[] = [
		{
			eventId: randomUUID(),
			type: "EVAL_REVIEWER_ASSIGNED",
			timestamp: new Date().toISOString(),
			details: { reviewerRunId: assignment.reviewerRunId },
		},
		{
			eventId: randomUUID(),
			type: "EVAL_REVIEWER_STARTED",
			timestamp: new Date().toISOString(),
			details: { reviewerId: input.reviewer.reviewerId },
		},
	];
	const output = await input.reviewer.execute({ assignment, packet, signal: input.signal });
	validateOutput(output);
	events.push({
		eventId: randomUUID(),
		type: "EVAL_REVIEWER_OUTPUT_VALIDATED",
		timestamp: new Date().toISOString(),
		details: { reviewerRunId: assignment.reviewerRunId },
	});
	const deterministicFailure = input.artifact.assertions.some(
		(assertion) =>
			(assertion.severity === "critical" || assertion.severity === "high") && assertion.status !== "pass",
	);
	const semanticResult: SemanticEvaluationResult = {
		rubricId: input.rubricId,
		rubricVersion: input.rubricVersion,
		judgeId: input.reviewer.reviewerId,
		status: deterministicFailure && output.status === "pass" ? "fail" : output.status,
		dimensions: output.dimensions,
		rationale: output.rationale,
		candidateIdentityHidden: true,
		toolExecutionAllowed: false,
	};
	events.push({
		eventId: randomUUID(),
		type: "EVAL_REVIEWER_COMPLETED",
		timestamp: new Date().toISOString(),
		details: { status: semanticResult.status },
	});
	return { assignment, semanticResult, events };
}

export function createDeterministicReviewer(reviewerId = "fixture-reviewer"): EvaluationReviewer {
	return {
		reviewerId,
		async execute() {
			return {
				status: "pass",
				dimensions: { correctness: 1, safety: 1 },
				rationale: "Deterministic evidence packet satisfied the rubric.",
				uncertainty: 0,
			};
		},
	};
}
