import { randomUUID } from "node:crypto";
import { WorkspaceSafety } from "./safety/manager.js";
import type { WorkspaceEdit } from "./safety/transaction.js";
import {
	createSubagentContextPacket,
	type ResolvedSubagentInvocation,
	resolveSubagentInvocation,
	validateParentSubagentOutput,
} from "./subagent-runtime.js";

export type CavecrewTerminalState =
	| "completed"
	| "investigation_failed"
	| "plan_invalid"
	| "builder_scope_exceeded"
	| "builder_failed_and_rolled_back"
	| "review_changes_required"
	| "cancelled"
	| "blocked";

export interface CavecrewInvestigationResult {
	objective: string;
	summary: string;
	flow: string[];
	rootCauses: string[];
	relevantFiles: string[];
	unknowns: string[];
	recommendedNextAgent: string;
}

export interface CavecrewPlan {
	scope: string[];
	nonGoals: string[];
	implementationSteps: string[];
	invariants: string[];
	focusedTests: string[];
	acceptanceCriteria: string[];
	rollbackExpectations: string[];
}

export interface CavecrewBuilderResult {
	objective: string;
	status: "implemented" | "failed";
	filesChanged: string[];
	validations: string[];
	rollbackState: "confirmed" | "rolled_back" | "conflict";
	remainingRisks: string[];
	transactionId?: string;
	leaseId?: string;
	checkpointId?: string;
}

export interface CavecrewReviewResult {
	verdict: "pass" | "changes_required";
	findings: string[];
	missingTests: string[];
	acceptanceGaps: string[];
}

export interface CavecrewProviderFixtures {
	investigator: (assignment: string, invocation: ResolvedSubagentInvocation) => Promise<unknown>;
	planner: (
		investigations: readonly CavecrewInvestigationResult[],
		invocation: ResolvedSubagentInvocation,
	) => Promise<unknown>;
	builder: (
		plan: CavecrewPlan,
		invocation: ResolvedSubagentInvocation,
	) => Promise<{ edits: WorkspaceEdit[]; output: unknown }>;
	reviewer: (
		input: { plan: CavecrewPlan; builder: CavecrewBuilderResult },
		invocation: ResolvedSubagentInvocation,
	) => Promise<unknown>;
}

export interface CavecrewRequest {
	objective: string;
	assignments: string[];
	parentRunId?: string;
	cwd: string;
	storageDir: string;
	signal?: AbortSignal;
	fixtures: CavecrewProviderFixtures;
}

export interface CavecrewResult {
	parentRunId: string;
	childRunIds: string[];
	state: CavecrewTerminalState;
	investigations: CavecrewInvestigationResult[];
	plan?: CavecrewPlan;
	builder?: CavecrewBuilderResult;
	review?: CavecrewReviewResult;
}

function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("CAVECREW_CANCELLED");
}

function parseOutput<T>(value: unknown): T {
	if (typeof value === "string") return JSON.parse(value) as T;
	return value as T;
}

export async function runCavecrew(request: CavecrewRequest): Promise<CavecrewResult> {
	const parentRunId = request.parentRunId ?? randomUUID();
	const childRunIds = request.assignments.map(() => randomUUID());
	const result: CavecrewResult = { parentRunId, childRunIds, state: "blocked", investigations: [] };
	let phase: "investigation" | "planning" | "builder" | "review" = "investigation";
	try {
		assertNotAborted(request.signal);
		const investigatorResults = await Promise.all(
			request.assignments.map(async (assignment, index) => {
				const invocation = resolveSubagentInvocation({
					requestedAgent: "cavecrew-investigator",
					parentRunId,
					childRunId: childRunIds[index],
				});
				createSubagentContextPacket({ invocation, objective: assignment });
				const output = parseOutput<CavecrewInvestigationResult>(
					await request.fixtures.investigator(assignment, invocation),
				);
				return validateParentSubagentOutput({ invocation, rawOutput: output })
					.value as unknown as CavecrewInvestigationResult;
			}),
		);
		result.investigations = investigatorResults;
		assertNotAborted(request.signal);

		phase = "planning";
		const plannerInvocation = resolveSubagentInvocation({
			requestedAgent: "planner",
			parentRunId,
			childRunId: randomUUID(),
		});
		const plan = parseOutput<CavecrewPlan>(await request.fixtures.planner(investigatorResults, plannerInvocation));
		if (!Array.isArray(plan.scope) || plan.scope.length > 2) {
			result.state = "plan_invalid";
			return result;
		}
		result.plan = plan;

		phase = "builder";
		const builderInvocation = resolveSubagentInvocation({
			requestedAgent: "cavecrew-builder",
			parentRunId,
			childRunId: randomUUID(),
		});
		const fixture = await request.fixtures.builder(plan, builderInvocation);
		if (fixture.edits.length > (builderInvocation.effectiveBudget.maxAffectedFiles ?? 2)) {
			result.state = "builder_scope_exceeded";
			return result;
		}
		if (fixture.edits.some((edit) => edit.kind !== "create_file" && edit.kind !== "replace_file")) {
			result.state = "builder_failed_and_rolled_back";
			return result;
		}
		const safety = await WorkspaceSafety.create(request.cwd, { storageDir: request.storageDir }, "execute");
		const effects = {
			readsWorkspace: true,
			writesWorkspace: true,
			createsFiles: true,
			deletesFiles: false,
			executesProcesses: false,
			startsPersistentProcesses: false,
			accessesNetwork: false,
			mutatesGit: false,
			mutatesExternalState: false,
			handlesSecrets: false,
			potentiallyDestructive: false,
			requiresExclusiveWorkspaceLease: true,
			parallelSafe: false,
			scopes: [{ kind: "workspace" as const }],
		};
		const policyInput = {
			toolName: "cavecrew-builder",
			effects,
			resolvedPaths: fixture.edits.map((edit) => edit.path),
		};
		const evaluatedPolicy = safety.evaluate(policyInput);
		const policy =
			evaluatedPolicy.decision.outcome === "require_approval"
				? safety.policy.approve(
						{ ...policyInput, workspaceId: safety.workspaceId, executionMode: "execute" },
						"mutation",
					).decision
				: evaluatedPolicy.decision;
		const mutation = await safety.performMutation({
			runId: builderInvocation.childRunId,
			edits: fixture.edits,
			policy,
			validation: {
				id: "cavecrew-focused",
				label: "cavecrew-focused",
				run: async () => ({ exitCode: 0, outputArtifact: "fixture-pass" }),
			},
			effects,
		});
		const builderOutput = parseOutput<CavecrewBuilderResult>(fixture.output);
		result.builder = {
			...builderOutput,
			transactionId: mutation.transactionId,
			rollbackState: mutation.stage === "confirmed" ? "confirmed" : "rolled_back",
		};
		if (mutation.stage !== "confirmed") {
			result.state = "builder_failed_and_rolled_back";
			return result;
		}

		phase = "review";
		const reviewerInvocation = resolveSubagentInvocation({
			requestedAgent: "cavecrew-reviewer",
			parentRunId,
			childRunId: randomUUID(),
		});
		const review = parseOutput<CavecrewReviewResult>(
			await request.fixtures.reviewer({ plan, builder: result.builder }, reviewerInvocation),
		);
		result.review = validateParentSubagentOutput({ invocation: reviewerInvocation, rawOutput: review })
			.value as unknown as CavecrewReviewResult;
		result.state = result.review.verdict === "pass" ? "completed" : "review_changes_required";
		return result;
	} catch (error) {
		if (error instanceof Error && error.message === "CAVECREW_CANCELLED") {
			result.state = "cancelled";
		} else if (phase === "builder") {
			result.state = "builder_failed_and_rolled_back";
		} else if (phase === "review") {
			result.state = "review_changes_required";
		} else if (phase === "planning") {
			result.state = "plan_invalid";
		} else {
			result.state = "investigation_failed";
		}
		return result;
	}
}
