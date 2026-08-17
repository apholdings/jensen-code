import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { bindChildSession } from "../durable-child-session/child-session-restore.js";
import { defaultChildSessionDir } from "../durable-child-session/index.js";
import {
	createDurableMissionRecord,
	type DurableMissionRecord,
	type DurableMissionStore,
} from "../mission-domain/durable-store.js";
import { createMissionRequest, type MissionRequest } from "../mission-domain/mission-request.js";
import type { SchedulerControlService } from "../scheduler/scheduler-control-service.js";
import { SessionManager } from "../session-manager.js";
import type { LocalSubagentRuntime } from "../shared-inference/runtime.js";
import type { OrchestrationStore } from "./types.js";
import {
	type OrchestrationJoinResult,
	type OrchestrationNode,
	type OrchestrationNodeStatus,
	type OrchestrationPlan,
	type OrchestrationPlanDocument,
	type OrchestrationPlanProposal,
	type OrchestrationProposalInput,
	type OrchestrationReason,
	type OrchestrationStatus,
	type OrchestrationValidationResult,
	orchestrationMetadataForNode,
} from "./types.js";
import { validateOrchestrationPlan, validatePlanProposal } from "./validation.js";

export interface OrchestratorOptions {
	store: OrchestrationStore;
	missions: DurableMissionStore;
	logicalRuntime?: LocalSubagentRuntime;
	scheduler?: SchedulerControlService;
	sessionDir?: string;
	now?: () => number;
	orchestrationIdFactory?: () => string;
	maxDepth?: number;
	maxChildrenPerNode?: number;
	maxTotalLogicalAgents?: number;
	maxReplans?: number;
}

export interface CreateOrchestrationOptions {
	parentMissionId: string;
	proposal: OrchestrationPlanProposal;
	parentDepth?: number;
	rationale?: string;
}

export interface OrchestrationReconcileResult {
	status: OrchestrationStatus;
	materializedMissionIds: string[];
	unblockedNodeIds: string[];
}

function terminalForDependency(record: DurableMissionRecord | undefined): boolean {
	return record?.state === "SUCCEEDED" || record?.state === "PARTIAL";
}

function childMissionId(orchestrationId: string, nodeId: string): string {
	return `mission_orch_${orchestrationId}_${nodeId}`.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function childSessionId(orchestrationId: string, nodeId: string): string {
	return `child_orch_${orchestrationId}_${nodeId}`.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function nodeDependencies(plan: OrchestrationPlan, nodeId: string): string[] {
	return plan.edges
		.filter((edge) => edge.to === nodeId && edge.kind === "REQUIRED")
		.map((edge) => edge.from)
		.sort();
}

function isRemote(node: OrchestrationNode): boolean {
	return node.requirements?.executionMode === "remote" || node.requirements?.preferences?.executionMode === "remote";
}

function nodeStatusForRecord(
	node: OrchestrationNode,
	record: DurableMissionRecord | undefined,
): OrchestrationNodeStatus {
	if (!record) return node.status;
	if (record.state === "SUCCEEDED" || record.state === "PARTIAL") return "COMPLETED";
	if (record.state === "FAILED" || record.state === "CRASHED" || record.state === "TIMED_OUT") return "FAILED";
	if (record.state === "CANCELLED") return "CANCELLED";
	if (record.state === "BLOCKED") return "BLOCKED";
	if (record.state === "CREATED") return "MATERIALIZED";
	return "RUNNING";
}

function isActiveNodeStatus(status: OrchestrationNodeStatus): boolean {
	return status === "MATERIALIZED" || status === "RUNNING" || status === "READY";
}

export class OrchestratorService {
	private readonly _store: OrchestrationStore;
	private readonly _missions: DurableMissionStore;
	private readonly _runtime?: LocalSubagentRuntime;
	private readonly _scheduler?: SchedulerControlService;
	private readonly _sessionDir?: string;
	private readonly _now: () => number;
	private readonly _idFactory: () => string;
	private readonly _limits: Pick<
		OrchestrationPlan,
		"maxDepth" | "maxChildrenPerNode" | "maxTotalLogicalAgents" | "maxReplans"
	>;

	constructor(options: OrchestratorOptions) {
		this._store = options.store;
		this._missions = options.missions;
		this._runtime = options.logicalRuntime;
		this._scheduler = options.scheduler;
		this._sessionDir = options.sessionDir;
		this._now = options.now ?? (() => Date.now());
		this._idFactory =
			options.orchestrationIdFactory ??
			(() => `orch_${createHash("sha256").update(`${Date.now()}_${randomUUID()}`).digest("hex").slice(0, 24)}`);
		this._limits = {
			maxDepth: options.maxDepth ?? 2,
			maxChildrenPerNode: options.maxChildrenPerNode ?? 20,
			maxTotalLogicalAgents: options.maxTotalLogicalAgents ?? 20,
			maxReplans: options.maxReplans ?? 2,
		};
	}

	async preview(
		input: CreateOrchestrationOptions,
	): Promise<{ plan?: OrchestrationPlan; validation: OrchestrationValidationResult; issues: unknown[] }> {
		const plan = this.buildPlan(input);
		const validation = validateOrchestrationPlan(plan, { parentDepth: input.parentDepth });
		return { plan: validation.valid ? plan : undefined, validation, issues: validation.issues };
	}

	async create(input: CreateOrchestrationOptions): Promise<OrchestrationPlan> {
		const parent = await this.loadMission(input.parentMissionId);
		const plan = this.buildPlan({ ...input, parentDepth: input.parentDepth ?? parent.depth });
		const validation = validateOrchestrationPlan(plan, { parentDepth: parent.depth });
		if (!validation.valid)
			throw new Error(`ORCHESTRATION_PLAN_INVALID: ${validation.issues.map((item) => item.message).join("; ")}`);
		const criticality = validation.dependencyCriticality;
		for (const node of plan.nodes) node.dependencyCriticality = criticality.get(node.nodeId) ?? 0;
		const document: OrchestrationPlanDocument = { schemaVersion: 1, plan, revisions: [] };
		const created = await this._store.create(document);
		if (created.status === "conflict") throw new Error(`ORCHESTRATION_PLAN_INVALID: ${created.error}`);
		return created.status === "idempotent" ? created.document.plan : plan;
	}

	async createFromPlanner(
		input: OrchestrationProposalInput,
		planner: { propose(input: OrchestrationProposalInput): Promise<unknown> },
	): Promise<OrchestrationPlan> {
		let feedback = "";
		for (let attempt = 0; attempt <= this._limits.maxReplans; attempt++) {
			const proposed = await planner.propose({
				...input,
				constraints: [...input.constraints, feedback].filter(Boolean),
			});
			const parsed = validatePlanProposal(proposed);
			if (parsed.valid) {
				try {
					return await this.create({ parentMissionId: input.parentMissionId, proposal: parsed.proposal });
				} catch (error) {
					feedback = error instanceof Error ? error.message : String(error);
					continue;
				}
			}
			feedback = parsed.issues.map((item) => `${item.code}:${item.message}`).join("; ");
		}
		throw new Error("ORCHESTRATION_REPLAN_EXHAUSTED: no valid plan after bounded retries");
	}

	private buildPlan(input: CreateOrchestrationOptions): OrchestrationPlan {
		const now = this._now();
		const orchestrationId = this._idFactory();
		return {
			schemaVersion: 1,
			orchestrationId,
			parentMissionId: input.parentMissionId,
			decision: input.proposal.decision,
			rationale: input.rationale ?? input.proposal.rationale,
			nodes: input.proposal.nodes.map((node) => ({
				...node,
				acceptanceCriteria: [...node.acceptanceCriteria],
				status: input.proposal.decision === "DIRECT" ? "PROPOSED" : node.status,
			})),
			edges: input.proposal.edges.map((edge) => ({ ...edge })),
			revision: 1,
			state: "DRAFT",
			...this._limits,
			replanCount: 0,
			createdAtMs: now,
			updatedAtMs: now,
		};
	}

	async materializeReady(orchestrationId: string): Promise<OrchestrationReconcileResult> {
		const exclusive = this._store.withExclusive;
		if (exclusive)
			return exclusive.call(this._store, orchestrationId, async (document, save) =>
				this.materializeReadyDocument(document, save),
			) as Promise<OrchestrationReconcileResult>;
		const document = await this.loadDocument(orchestrationId);
		return this.materializeReadyDocument(document, async (next) => this.saveDocument(next, document.plan.revision));
	}

	private async materializeReadyDocument(
		document: OrchestrationPlanDocument,
		save: (document: OrchestrationPlanDocument) => Promise<void>,
	): Promise<OrchestrationReconcileResult> {
		const plan = document.plan;
		const records = new Map<string, DurableMissionRecord | undefined>();
		for (const node of plan.nodes)
			if (node.childMissionId) records.set(node.nodeId, await this.loadOptionalMission(node.childMissionId));
		const materialized: string[] = [];
		const unblocked: string[] = [];
		const nextNodes = plan.nodes.map((node) => {
			const deps = nodeDependencies(plan, node.nodeId);
			const blocked = deps.some(
				(dependency) =>
					!terminalForDependency(records.get(dependency)) &&
					plan.nodes.find((candidate) => candidate.nodeId === dependency)?.status !== "COMPLETED",
			);
			if (node.status === "PROPOSED" || node.status === "BLOCKED" || node.status === "READY") {
				if (blocked) return { ...node, status: "BLOCKED" as const };
				if (node.status === "BLOCKED") unblocked.push(node.nodeId);
				return { ...node, status: "READY" as const };
			}
			return { ...node, status: nodeStatusForRecord(node, records.get(node.nodeId)) };
		});
		for (const node of nextNodes.filter((candidate) => candidate.status === "READY")) {
			if (node.childMissionId) continue;
			const materializingIndex = nextNodes.findIndex((candidate) => candidate.nodeId === node.nodeId);
			nextNodes[materializingIndex] = { ...node, status: "MATERIALIZING" };
			let created: MissionRequest & { childSessionId: string };
			try {
				created = await this.materializeNode(plan, node);
			} catch (error) {
				const failedIndex = nextNodes.findIndex((candidate) => candidate.nodeId === node.nodeId);
				nextNodes[failedIndex] = {
					...node,
					status: "UNSCHEDULABLE",
					lastError: error instanceof Error ? error.message : String(error),
				};
				continue;
			}
			materialized.push(created.missionId);
			const index = nextNodes.findIndex((candidate) => candidate.nodeId === node.nodeId);
			nextNodes[index] = {
				...node,
				status: "MATERIALIZED",
				childMissionId: created.missionId,
				childSessionId: created.childSessionId,
			};
		}
		const state = this.planState(plan.decision, nextNodes);
		const updated: OrchestrationPlan = {
			...plan,
			revision: plan.revision + 1,
			nodes: nextNodes,
			state,
			updatedAtMs: this._now(),
		};
		await save({ ...document, plan: updated });
		return {
			status: await this.statusFromDocument({ ...document, plan: updated }),
			materializedMissionIds: materialized,
			unblockedNodeIds: unblocked,
		};
	}

	private async materializeNode(
		plan: OrchestrationPlan,
		node: OrchestrationNode,
	): Promise<MissionRequest & { childSessionId: string }> {
		const parent = await this.loadMission(plan.parentMissionId);
		const missionId = childMissionId(plan.orchestrationId, node.nodeId);
		const sessionId = childSessionId(plan.orchestrationId, node.nodeId);
		const sessionDir = this._sessionDir ?? defaultChildSessionDir();
		const request = createMissionRequest({
			missionId,
			parent: { missionId: parent.missionId, depth: parent.depth },
			objective: node.objective,
			agent: node.agent,
			executionMode: node.executionMode,
			acceptanceCriteria: node.acceptanceCriteria,
			workspaceScope: parent.request.workspaceScope,
			budget: parent.request.budget,
			capabilities: node.capabilities,
			modelPolicy: parent.request.modelPolicy,
			childSessionId: sessionId,
			constraints: node.constraints ?? parent.request.constraints,
			context: { parentMissionId: parent.missionId, nodeId: node.nodeId, role: node.role },
			orchestration: orchestrationMetadataForNode(plan, node),
			now: this._now(),
		});
		mkdirSync(sessionDir, { recursive: true });
		const manager = SessionManager.createWithId(
			parent.request.workspaceScope?.cwd ?? process.cwd(),
			sessionDir,
			sessionId,
		);
		bindChildSession(manager, missionId, parent.missionId);
		const existing = await this._missions.load(missionId);
		if (existing.status === "missing")
			await this._missions.create(createDurableMissionRecord({ request, now: this._now() }));
		else if (existing.status === "corrupt") throw new Error(`ORCHESTRATION_CHILD_CORRUPT: ${missionId}`);
		if (this._runtime)
			await this._runtime.register({
				logicalAgentId: sessionId,
				parentAgentId: parent.request.childSessionId,
				missionId,
				sessionId,
				sessionDir,
				modelPolicy: request.modelPolicy,
				activity: nodeDependencies(plan, node.nodeId).length > 0 ? "BLOCKED_DEPENDENCY" : "RUNNABLE",
				priority: node.priority ?? 0,
			});
		if (this._scheduler) {
			const schedulingPriority = node.priority ?? 0;
			await this._scheduler.enqueueIntent(missionId, {
				requirements: node.requirements,
				priority: schedulingPriority,
			});
		}
		return { ...request, childSessionId: sessionId };
	}

	private planState(
		decision: OrchestrationPlan["decision"],
		nodes: readonly OrchestrationNode[],
	): OrchestrationPlan["state"] {
		if (decision === "DIRECT" && nodes.length === 0) return "COMPLETED";
		if (nodes.some((node) => node.status === "FAILED" && node.requirement !== "OPTIONAL")) return "FAILED";
		if (
			nodes.length > 0 &&
			nodes.every(
				(node) =>
					node.status === "COMPLETED" ||
					(node.status === "FAILED" && node.requirement === "OPTIONAL") ||
					node.status === "CANCELLED",
			)
		)
			return "COMPLETED";
		return nodes.some((node) => isActiveNodeStatus(node.status)) ? "ACTIVE" : "WAITING";
	}

	async reconcile(orchestrationId: string): Promise<OrchestrationReconcileResult> {
		return this.materializeReady(orchestrationId);
	}

	async status(orchestrationId: string): Promise<OrchestrationStatus> {
		return this.statusFromDocument(await this.loadDocument(orchestrationId));
	}

	private async statusFromDocument(document: OrchestrationPlanDocument): Promise<OrchestrationStatus> {
		const plan = document.plan;
		const records = new Map<string, DurableMissionRecord | undefined>();
		for (const node of plan.nodes)
			if (node.childMissionId) records.set(node.nodeId, await this.loadOptionalMission(node.childMissionId));
		const graph = plan.nodes.map((node) => ({
			nodeId: node.nodeId,
			status: nodeStatusForRecord(node, records.get(node.nodeId)),
			role: node.role,
			objective: node.objective,
			reason: node.independenceReason,
			childMissionId: node.childMissionId,
			dependencies: nodeDependencies(plan, node.nodeId),
			waitingFor: nodeDependencies(plan, node.nodeId).filter((id) => !terminalForDependency(records.get(id))),
			workspaceAccess: node.workspaceAccess,
		}));
		const counts = {
			childrenMaterialized: 0,
			childrenActive: 0,
			childrenBlocked: 0,
			childrenCompleted: 0,
			childrenFailed: 0,
			childrenCancelled: 0,
			localChildren: 0,
			remoteChildren: 0,
			runnableAgents: 0,
			waitingInferenceAgents: 0,
			toolingAgents: 0,
			parkedAgents: 0,
		};
		for (const node of graph) {
			if (node.childMissionId) counts.childrenMaterialized++;
			if (node.status === "BLOCKED") counts.childrenBlocked++;
			if (node.status === "COMPLETED") counts.childrenCompleted++;
			if (node.status === "FAILED") counts.childrenFailed++;
			if (node.status === "CANCELLED") counts.childrenCancelled++;
			if (isActiveNodeStatus(node.status)) counts.childrenActive++;
			if (node.childMissionId) {
				if (isRemote(plan.nodes.find((candidate) => candidate.nodeId === node.nodeId)!)) counts.remoteChildren++;
				else counts.localChildren++;
			}
		}
		if (this._runtime) Object.assign(counts, await this._runtime.activityCounts());
		const fanoutReasonCounts: Partial<Record<OrchestrationReason, number>> = {};
		for (const node of plan.nodes)
			if (node.independenceReason)
				fanoutReasonCounts[node.independenceReason] = (fanoutReasonCounts[node.independenceReason] ?? 0) + 1;
		return {
			orchestrationId: plan.orchestrationId,
			parentMissionId: plan.parentMissionId,
			decision: plan.decision,
			state: plan.state,
			planRevision: plan.revision,
			replanCount: plan.replanCount,
			nodesTotal: plan.nodes.length,
			...counts,
			fanoutReasonCounts,
			graph,
		};
	}

	async join(orchestrationId: string): Promise<OrchestrationJoinResult> {
		const document = await this.loadDocument(orchestrationId);
		const plan = document.plan;
		const results: OrchestrationJoinResult["results"] = [];
		const requiredFailures: string[] = [];
		const optionalFailures: string[] = [];
		const pendingNodeIds: string[] = [];
		const completedNodeIds: string[] = [];
		for (const node of plan.nodes) {
			if (!node.childMissionId) {
				if (node.status !== "COMPLETED") pendingNodeIds.push(node.nodeId);
				continue;
			}
			const record = await this.loadOptionalMission(node.childMissionId);
			if (!record?.result) {
				pendingNodeIds.push(node.nodeId);
				continue;
			}
			if (record.result.state === "SUCCEEDED" || record.result.state === "PARTIAL")
				completedNodeIds.push(node.nodeId);
			else if (node.requirement === "OPTIONAL") optionalFailures.push(node.nodeId);
			else requiredFailures.push(node.nodeId);
			results.push({
				nodeId: node.nodeId,
				missionId: node.childMissionId,
				state: record.result.state,
				success: record.result.success,
				summary: record.result.verification.summary,
			});
		}
		const terminal = pendingNodeIds.length === 0 && requiredFailures.length === 0;
		return {
			orchestrationId,
			parentMissionId: plan.parentMissionId,
			state: requiredFailures.length > 0 ? "FAILED" : terminal ? "COMPLETED" : "WAITING",
			decision: plan.decision,
			terminal,
			requiredFailures,
			optionalFailures,
			completedNodeIds,
			pendingNodeIds,
			results,
		};
	}

	async cancel(orchestrationId: string): Promise<OrchestrationStatus> {
		const document = await this.loadDocument(orchestrationId);
		const plan = document.plan;
		const next: OrchestrationPlan = {
			...plan,
			revision: plan.revision + 1,
			state: "CANCELLED",
			nodes: plan.nodes.map((node) =>
				node.status === "PROPOSED" || node.status === "BLOCKED" || node.status === "READY"
					? { ...node, status: "CANCELLED" as const }
					: node,
			),
			updatedAtMs: this._now(),
		};
		await this.saveDocument({ ...document, plan: next }, plan.revision);
		return this.statusFromDocument({ ...document, plan: next });
	}

	private async saveDocument(document: OrchestrationPlanDocument, expectedRevision: number): Promise<void> {
		const saved = await this._store.save(document, { expectedRevision });
		if (saved.status !== "saved") throw new Error("ORCHESTRATION_STALE_REVISION");
	}
	private async loadDocument(id: string): Promise<OrchestrationPlanDocument> {
		const loaded = await this._store.load(id);
		if (loaded.status !== "ok") throw new Error(`ORCHESTRATION_NOT_FOUND: ${id}`);
		return loaded.document;
	}
	private async loadMission(id: string): Promise<DurableMissionRecord> {
		const loaded = await this._missions.load(id);
		if (loaded.status !== "ok") throw new Error(`PARENT_MISSION_NOT_FOUND: ${id}`);
		return loaded.record;
	}
	private async loadOptionalMission(id: string): Promise<DurableMissionRecord | undefined> {
		const loaded = await this._missions.load(id);
		return loaded.status === "ok" ? loaded.record : undefined;
	}
}
