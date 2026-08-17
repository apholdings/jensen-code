import { getCanonicalSubagentRegistry } from "../subagent-registry.js";
import type {
	OrchestrationEdge,
	OrchestrationNode,
	OrchestrationPlan,
	OrchestrationPlanProposal,
	OrchestrationValidationIssue,
	OrchestrationValidationResult,
} from "./types.js";

const NODE_KINDS = new Set(["DIRECT", "CHILD", "SYNTHESIS", "REVIEW", "VERIFICATION"]);
const REQUIREMENTS = new Set(["REQUIRED", "OPTIONAL", "VERIFICATION_GATING"]);
const ACCESS = new Set(["READ_ONLY", "WRITE"]);

function issue(
	issues: OrchestrationValidationIssue[],
	code: OrchestrationValidationIssue["code"],
	path: string,
	message: string,
): void {
	issues.push({ code, path, message });
}

function hasPath(edges: readonly OrchestrationEdge[], from: string, to: string): boolean {
	const next = new Map<string, string[]>();
	for (const edge of edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
	const seen = new Set<string>();
	const stack = [from];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current === to) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		stack.push(...(next.get(current) ?? []));
	}
	return false;
}

function dependencyCriticality(
	nodes: readonly OrchestrationNode[],
	edges: readonly OrchestrationEdge[],
): Map<string, number> {
	const counts = new Map<string, number>(nodes.map((node) => [node.nodeId, 0]));
	for (const edge of edges) {
		if (edge.kind === "REQUIRED") counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
	}
	return counts;
}

function validateDag(
	nodes: readonly OrchestrationNode[],
	edges: readonly OrchestrationEdge[],
	issues: OrchestrationValidationIssue[],
): void {
	const ids = new Set(nodes.map((node) => node.nodeId));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const adjacency = new Map<string, string[]>();
	for (const edge of edges) {
		if (!ids.has(edge.from))
			issue(
				issues,
				"ORCHESTRATION_MISSING_DEPENDENCY",
				`edges.${edge.from}`,
				`Unknown dependency source ${edge.from}`,
			);
		if (!ids.has(edge.to))
			issue(issues, "ORCHESTRATION_MISSING_DEPENDENCY", `edges.${edge.to}`, `Unknown dependency target ${edge.to}`);
		if (edge.from === edge.to)
			issue(issues, "ORCHESTRATION_CYCLE", `edges.${edge.from}`, "A node cannot depend on itself");
		adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
	}
	const walk = (nodeId: string, path: string[]): void => {
		if (visiting.has(nodeId)) {
			issue(issues, "ORCHESTRATION_CYCLE", `nodes.${nodeId}`, `Dependency cycle: ${[...path, nodeId].join(" -> ")}`);
			return;
		}
		if (visited.has(nodeId)) return;
		visiting.add(nodeId);
		for (const next of adjacency.get(nodeId) ?? []) walk(next, [...path, nodeId]);
		visiting.delete(nodeId);
		visited.add(nodeId);
	};
	for (const node of nodes) walk(node.nodeId, []);
}

function validateDuplicateWork(nodes: readonly OrchestrationNode[], issues: OrchestrationValidationIssue[]): void {
	const seen = new Map<string, OrchestrationNode>();
	for (const node of nodes) {
		const key = JSON.stringify({
			role: node.role,
			objective: node.objective.trim(),
			workspaceKey: node.workspaceKey ?? "",
			requirements: node.requirements ?? {},
		});
		const previous = seen.get(key);
		if (
			previous &&
			node.independenceReason !== "independent_review" &&
			node.independenceReason !== "uncertainty_reduction"
		) {
			issue(
				issues,
				"ORCHESTRATION_DUPLICATE_WORK",
				`nodes.${node.nodeId}`,
				`Duplicates node ${previous.nodeId} without an explicit independence rationale`,
			);
		}
		seen.set(key, node);
	}
}

function validateWriterSafety(
	plan: Pick<OrchestrationPlanProposal, "nodes" | "edges">,
	issues: OrchestrationValidationIssue[],
): void {
	for (let i = 0; i < plan.nodes.length; i++) {
		for (let j = i + 1; j < plan.nodes.length; j++) {
			const left = plan.nodes[i];
			const right = plan.nodes[j];
			if (
				left.workspaceAccess !== "WRITE" ||
				right.workspaceAccess !== "WRITE" ||
				!left.workspaceKey ||
				left.workspaceKey !== right.workspaceKey
			)
				continue;
			if (!hasPath(plan.edges, left.nodeId, right.nodeId) && !hasPath(plan.edges, right.nodeId, left.nodeId)) {
				issue(
					issues,
					"ORCHESTRATION_UNSAFE_WRITERS",
					`nodes.${right.nodeId}`,
					`Concurrent writers share workspace ${left.workspaceKey} without a dependency ordering`,
				);
			}
		}
	}
}

export function validateOrchestrationPlan(
	plan: OrchestrationPlan,
	options: { parentDepth?: number } = {},
): OrchestrationValidationResult {
	const issues: OrchestrationValidationIssue[] = [];
	if (!plan.orchestrationId || !plan.parentMissionId)
		issue(issues, "ORCHESTRATION_PLAN_INVALID", "plan", "orchestrationId and parentMissionId are required");
	if (
		plan.revision < 1 ||
		plan.maxDepth < 0 ||
		plan.maxChildrenPerNode < 1 ||
		plan.maxTotalLogicalAgents < 1 ||
		plan.maxReplans < 0
	)
		issue(issues, "ORCHESTRATION_PLAN_INVALID", "plan.limits", "Plan limits are invalid");
	if (options.parentDepth !== undefined && options.parentDepth + 1 > plan.maxDepth)
		issue(issues, "ORCHESTRATION_DEPTH_EXCEEDED", "plan.maxDepth", "Plan exceeds the configured recursion depth");
	if (plan.decision === "DIRECT" && plan.nodes.length > 0)
		issue(issues, "ORCHESTRATION_PLAN_INVALID", "plan.nodes", "DIRECT plans must not contain child nodes");
	if (plan.decision === "FANOUT" && plan.nodes.length === 0)
		issue(issues, "ORCHESTRATION_PLAN_INVALID", "plan.nodes", "FANOUT plans require at least one child node");
	if (plan.nodes.length > plan.maxChildrenPerNode || plan.nodes.length > plan.maxTotalLogicalAgents)
		issue(issues, "ORCHESTRATION_CHILD_LIMIT", "plan.nodes", "Plan exceeds logical-agent safety limits");
	const ids = new Set<string>();
	for (const [index, node] of plan.nodes.entries()) {
		if (!node.nodeId || ids.has(node.nodeId))
			issue(issues, "ORCHESTRATION_DUPLICATE_NODE", `nodes.${index}.nodeId`, `Duplicate node id ${node.nodeId}`);
		ids.add(node.nodeId);
		if (!NODE_KINDS.has(node.nodeKind))
			issue(issues, "ORCHESTRATION_INVALID_ROLE", `nodes.${node.nodeId}.nodeKind`, "Unknown node kind");
		if (!REQUIREMENTS.has(node.requirement))
			issue(
				issues,
				"ORCHESTRATION_INVALID_REQUIREMENT",
				`nodes.${node.nodeId}.requirement`,
				"Unknown node requirement",
			);
		if (!ACCESS.has(node.workspaceAccess))
			issue(
				issues,
				"ORCHESTRATION_PLAN_INVALID",
				`nodes.${node.nodeId}.workspaceAccess`,
				"Unknown workspace access",
			);
		if (!node.objective.trim() || !node.role.trim() || !node.agent.trim())
			issue(issues, "ORCHESTRATION_PLAN_INVALID", `nodes.${node.nodeId}`, "role, agent, and objective are required");
		const resolvedAgent = getCanonicalSubagentRegistry().resolve(node.agent);
		if ("code" in resolvedAgent)
			issue(issues, "ORCHESTRATION_INVALID_ROLE", `nodes.${node.nodeId}.agent`, `Unknown agent ${node.agent}`);
	}
	validateDag(plan.nodes, plan.edges, issues);
	validateDuplicateWork(plan.nodes, issues);
	validateWriterSafety(plan, issues);
	return { valid: issues.length === 0, issues, dependencyCriticality: dependencyCriticality(plan.nodes, plan.edges) };
}

export function validatePlanProposal(
	value: unknown,
): { valid: true; proposal: OrchestrationPlanProposal } | { valid: false; issues: OrchestrationValidationIssue[] } {
	const issues: OrchestrationValidationIssue[] = [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		issue(issues, "ORCHESTRATION_PLAN_INVALID", "proposal", "Proposal must be an object");
		return { valid: false, issues };
	}
	const raw = value as Record<string, unknown>;
	if (raw.decision !== "DIRECT" && raw.decision !== "FANOUT")
		issue(issues, "ORCHESTRATION_PLAN_INVALID", "proposal.decision", "decision must be DIRECT or FANOUT");
	if (typeof raw.rationale !== "string")
		issue(issues, "ORCHESTRATION_PLAN_INVALID", "proposal.rationale", "rationale is required");
	if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
		issue(issues, "ORCHESTRATION_PLAN_INVALID", "proposal", "nodes and edges must be arrays");
		return { valid: false, issues };
	}
	for (const [index, value] of raw.nodes.entries()) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			issue(issues, "ORCHESTRATION_PLAN_INVALID", `proposal.nodes.${index}`, "node must be an object");
			continue;
		}
		const node = value as Record<string, unknown>;
		for (const field of [
			"nodeId",
			"role",
			"nodeKind",
			"objective",
			"agent",
			"executionMode",
			"requirement",
			"workspaceAccess",
			"status",
		] as const) {
			if (typeof node[field] !== "string" || node[field].trim().length === 0)
				issue(issues, "ORCHESTRATION_PLAN_INVALID", `proposal.nodes.${index}.${field}`, `${field} is required`);
		}
		if (!Array.isArray(node.acceptanceCriteria))
			issue(
				issues,
				"ORCHESTRATION_PLAN_INVALID",
				`proposal.nodes.${index}.acceptanceCriteria`,
				"acceptanceCriteria must be an array",
			);
		if (node.independenceReason !== undefined && typeof node.independenceReason !== "string")
			issue(
				issues,
				"ORCHESTRATION_PLAN_INVALID",
				`proposal.nodes.${index}.independenceReason`,
				"independenceReason must be a string",
			);
	}
	for (const [index, value] of raw.edges.entries()) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			issue(issues, "ORCHESTRATION_PLAN_INVALID", `proposal.edges.${index}`, "edge must be an object");
			continue;
		}
		const edge = value as Record<string, unknown>;
		if (
			typeof edge.from !== "string" ||
			typeof edge.to !== "string" ||
			(edge.kind !== "REQUIRED" && edge.kind !== "OPTIONAL")
		)
			issue(
				issues,
				"ORCHESTRATION_PLAN_INVALID",
				`proposal.edges.${index}`,
				"edge requires from, to, and valid kind",
			);
	}
	const proposal = {
		decision: raw.decision,
		rationale: raw.rationale,
		nodes: raw.nodes,
		edges: raw.edges,
	} as OrchestrationPlanProposal;
	return issues.length === 0 ? { valid: true, proposal } : { valid: false, issues };
}
