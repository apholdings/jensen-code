import type {
	EvaluationAssertionResult,
	EvaluationCandidateIdentity,
	SemanticEvaluationResult,
	SemanticEvaluationRubric,
} from "./types.js";

export interface SemanticJudge {
	readonly judgeId: string;
	evaluate(input: {
		rubric: SemanticEvaluationRubric;
		evidence: string;
		candidateLabel: "A" | "B";
	}): Promise<{ status: "pass" | "fail" | "uncertain"; dimensions: Record<string, number>; rationale: string }>;
}

export async function evaluateSemantics(input: {
	rubric: SemanticEvaluationRubric;
	judge: SemanticJudge;
	evidence: string;
	candidate?: EvaluationCandidateIdentity;
	assertions: EvaluationAssertionResult[];
}): Promise<SemanticEvaluationResult> {
	if (
		input.assertions.some(
			(assertion) =>
				(assertion.severity === "critical" || assertion.severity === "high") && assertion.status === "fail",
		)
	)
		return unavailable(input.rubric, input.judge.judgeId, "deterministic safety failure takes precedence");
	const boundedEvidence = input.evidence.slice(0, 32_000);
	try {
		const judged = await input.judge.evaluate({
			rubric: input.rubric,
			evidence: boundedEvidence,
			candidateLabel: "A",
		});
		const dimensions: Record<string, number | undefined> = {};
		for (const dimension of input.rubric.dimensions) {
			const value = judged.dimensions[dimension.name];
			dimensions[dimension.name] =
				typeof value === "number" && value >= dimension.minimum && value <= dimension.maximum ? value : undefined;
		}
		if (Object.values(dimensions).some((value) => value === undefined))
			return unavailable(input.rubric, input.judge.judgeId, "judge output failed rubric bounds");
		return {
			rubricId: input.rubric.rubricId,
			rubricVersion: input.rubric.version,
			judgeId: input.judge.judgeId,
			status: judged.status,
			dimensions,
			rationale: judged.rationale.slice(0, 2_000),
			candidateIdentityHidden: true,
			toolExecutionAllowed: false,
		};
	} catch (error) {
		return unavailable(
			input.rubric,
			input.judge.judgeId,
			error instanceof Error ? error.message : "judge unavailable",
		);
	}
}

function unavailable(rubric: SemanticEvaluationRubric, judgeId: string, rationale: string): SemanticEvaluationResult {
	return {
		rubricId: rubric.rubricId,
		rubricVersion: rubric.version,
		judgeId,
		status: "unavailable",
		dimensions: Object.fromEntries(rubric.dimensions.map((dimension) => [dimension.name, undefined])),
		rationale,
		candidateIdentityHidden: true,
		toolExecutionAllowed: false,
	};
}
