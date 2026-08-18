import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { bindChildSession } from "../durable-child-session/child-session-restore.js";
import { defaultChildSessionDir } from "../durable-child-session/index.js";
import type { GovernanceService } from "../governance/service.js";
import {
	createDurableMissionRecord,
	type DurableMissionRecord,
	type DurableMissionStore,
} from "../mission-domain/durable-store.js";
import { createMissionRequest, type MissionRequest } from "../mission-domain/mission-request.js";
import { isTerminalMissionState } from "../mission-domain/mission-state.js";
import { SessionManager } from "../session-manager.js";
import type { LocalSubagentRuntime } from "../shared-inference/runtime.js";
import {
	createParentOrchestrationExecution,
	DEFAULT_ORCHESTRATION_CHILD_AUTHORITY,
	type ParentOrchestrationExecution,
	type ParentOrchestrationExecutionOptions,
} from "./parent-execution.js";
import { createQwenPlanner } from "./qwen-planner.js";
import type { OrchestrationStore } from "./types.js";
import {
	type OrchestrationChildExecutionPort,
	type OrchestrationJoinResult,
	type OrchestrationNode,
	type OrchestrationNodeStatus,
	type OrchestrationPlan,
	type OrchestrationPlanDocument,
	type OrchestrationPlanner,
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
	sessionDir?: string;
	now?: () => number;
	orchestrationIdFactory?: () => string;
	maxDepth?: number;
	maxChildrenPerNode?: number;
	maxTotalLogicalAgents?: number;
	maxReplans?: number;
	/**
	 * Explicit operator agent names accepted by plan validation on top of the
	 * canonical subagent registry. Takes precedence over any roster a planner
	 * exposes through `allowedAgents()`.
	 */
	operatorAgents?: readonly string[];
	/**
	 * Planner for the automatic start/preview path. Default:
	 * `createQwenPlanner()` (the local Qwen planner). Inject a mocked planner
	 * or a planner with a deterministic stream seam in tests.
	 */
	planner?: OrchestrationPlanner;
	/**
	 * Child execution authority port. It is exposed through the
	 * `childExecutionPort` seam and reused by automatic execution when no
	 * explicit execution port is supplied.
	 */
	childExecutionPort?: OrchestrationChildExecutionPort;
	governance?: GovernanceService;
}

export interface CreateOrchestrationOptions {
	parentMissionId: string;
	proposal: OrchestrationPlanProposal;
	parentDepth?: number;
	rationale?: string;
	/** Per-call operator agent set; overrides the service-level option. */
	operatorAgents?: readonly string[];
}

export interface OrchestrationPreview {
	plan?: OrchestrationPlan;
	validation: OrchestrationValidationResult;
	issues: unknown[];
}

export interface OrchestrationReconcileResult {
	status: OrchestrationStatus;
	materializedMissionIds: string[];
	unblockedNodeIds: string[];
}

/** Result of an automatic start: the created plan plus the materialization. */
export interface AutomaticStartResult extends OrchestrationReconcileResult {
	plan: OrchestrationPlan;
}

/**
 * Options for `startAutomatic`. `childExecutionAuthority` names the child
 * execution authority that will drive the created plan: when present, the
 * parent mission's durable request is updated (atomically) to carry the
 * `orchestrationExecution` contract BEFORE the result is returned. When
 * absent the status quo holds: children are materialized but no parent
 * execution contract is persisted.
 */
export interface StartAutomaticOptions {
	/**
	 * Named child execution authority persisted on the parent's durable
	 * request as `orchestrationExecution.childExecutionAuthority`. Verified,
	 * never defaulted: an empty/whitespace name is rejected.
	 */
	childExecutionAuthority?: string;
}

export interface AutomaticExecuteOptions extends StartAutomaticOptions {
	/** Existing parent execution stack. When omitted, `executionOptions` builds one. */
	execution?: ParentOrchestrationExecution;
	/** Production factory inputs used when `execution` is omitted. */
	executionOptions?: Omit<ParentOrchestrationExecutionOptions, "orchestrator" | "store" | "missions">;
	/** Coordinator resume options, including an optional cancellation signal. */
	resumeOptions?: { signal?: AbortSignal };
}

/** Recognize planners that expose their allowed agent set (roster hook). */
function plannerAllowedAgents(planner: OrchestrationPlanner): readonly string[] | undefined {
	return planner.allowedAgents ? planner.allowedAgents() : undefined;
}

/** Planner input derived from the parent mission's durable work contract. */
function proposalInputFor(parent: DurableMissionRecord, maxTotalLogicalAgents: number): OrchestrationProposalInput {
	return {
		parentMissionId: parent.missionId,
		objective: parent.request.objective,
		constraints: parent.request.constraints ?? [],
		maxTotalLogicalAgents,
	};
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
	private readonly _sessionDir?: string;
	private readonly _now: () => number;
	private readonly _idFactory: () => string;
	private readonly _operatorAgents?: readonly string[];
	private readonly _planner?: OrchestrationPlanner;
	private readonly _childExecutionPort?: OrchestrationChildExecutionPort;
	private readonly _governance?: GovernanceService;
	private readonly _limits: Pick<
		OrchestrationPlan,
		"maxDepth" | "maxChildrenPerNode" | "maxTotalLogicalAgents" | "maxReplans"
	>;

	constructor(options: OrchestratorOptions) {
		this._store = options.store;
		this._missions = options.missions;
		this._runtime = options.logicalRuntime;
		this._sessionDir = options.sessionDir;
		this._now = options.now ?? (() => Date.now());
		this._idFactory =
			options.orchestrationIdFactory ??
			(() => `orch_${createHash("sha256").update(`${Date.now()}_${randomUUID()}`).digest("hex").slice(0, 24)}`);
		this._operatorAgents = options.operatorAgents;
		this._planner = options.planner;
		this._childExecutionPort = options.childExecutionPort;
		this._governance = options.governance;
		this._limits = {
			maxDepth: options.maxDepth ?? 2,
			maxChildrenPerNode: options.maxChildrenPerNode ?? 20,
			maxTotalLogicalAgents: options.maxTotalLogicalAgents ?? 20,
			maxReplans: options.maxReplans ?? 2,
		};
	}

	/**
	 * Access seam for the child execution authority port.
	 *
	 * Returns the port configured for this orchestrator, when present. The
	 * parent lifecycle executor — never materialization — owns child launch.
	 */
	get childExecutionPort(): OrchestrationChildExecutionPort | undefined {
		return this._childExecutionPort;
	}

	/**
	 * Resolve the effective operator agent set for plan validation: an
	 * explicit per-call override, then the service-level option, then the
	 * roster exposed by the planner (when any). The canonical subagent
	 * registry remains the primary authority in all cases.
	 */
	private effectiveOperatorAgents(
		overrideAgents: readonly string[] | undefined,
		planner: OrchestrationPlanner | undefined,
	): readonly string[] | undefined {
		if (overrideAgents) return overrideAgents;
		if (this._operatorAgents) return this._operatorAgents;
		return planner ? plannerAllowedAgents(planner) : undefined;
	}

	async preview(input: CreateOrchestrationOptions): Promise<OrchestrationPreview> {
		const plan = this.buildPlan(input);
		const validation = validateOrchestrationPlan(plan, {
			parentDepth: input.parentDepth,
			operatorAgents: this.effectiveOperatorAgents(input.operatorAgents, undefined),
		});
		return { plan: validation.valid ? plan : undefined, validation, issues: validation.issues };
	}

	async create(input: CreateOrchestrationOptions): Promise<OrchestrationPlan> {
		const parent = await this.loadMission(input.parentMissionId);
		const plan = this.buildPlan({ ...input, parentDepth: input.parentDepth ?? parent.depth });
		const validation = validateOrchestrationPlan(plan, {
			parentDepth: parent.depth,
			operatorAgents: this.effectiveOperatorAgents(input.operatorAgents, undefined),
		});
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
		planner: OrchestrationPlanner,
	): Promise<OrchestrationPlan> {
		const operatorAgents = this.effectiveOperatorAgents(undefined, planner);
		let feedback = "";
		for (let attempt = 0; attempt <= this._limits.maxReplans; attempt++) {
			if (attempt > 0 && this._governance)
				await this._governance.recordRetry(
					input.parentMissionId,
					`orchestration:${input.parentMissionId}:planner-repair:${attempt}`,
					"planner",
					this._now(),
					{ parentMissionId: input.parentMissionId, phase: "planner_repair", attempt },
				);
			const proposed = await planner.propose({
				...input,
				constraints: [...input.constraints, feedback].filter(Boolean),
			});
			const parsed = validatePlanProposal(proposed);
			if (parsed.valid) {
				try {
					return await this.create({
						parentMissionId: input.parentMissionId,
						proposal: parsed.proposal,
						operatorAgents,
					});
				} catch (error) {
					feedback = error instanceof Error ? error.message : String(error);
					if (this._governance)
						await this._governance.recordRetry(
							input.parentMissionId,
							`orchestration:${input.parentMissionId}:orchestration-replan:${attempt}`,
							"replan",
							this._now(),
							{ parentMissionId: input.parentMissionId, phase: "orchestration_replan", attempt },
						);
					continue;
				}
			}
			feedback = parsed.issues.map((item) => `${item.code}:${item.message}`).join("; ");
		}
		throw new Error("ORCHESTRATION_REPLAN_EXHAUSTED: no valid plan after bounded retries");
	}

	/**
	 * Automatic orchestration start. Loads the parent mission's objective and
	 * constraints, asks the planner (default: `createQwenPlanner()`) to
	 * propose a plan with bounded replans, creates it, and materializes the
	 * ready child nodes. Children are never launched here; execution remains
	 * owned by Mission/Scheduler. The explicit proposal API (`preview` /
	 * `create`) remains the operator's debug override.
	 *
	 * When `options.childExecutionAuthority` is provided, the parent mission's
	 * durable request is atomically updated (DurableMissionStore `mutate`) to
	 * carry the `orchestrationExecution` contract naming this plan and that
	 * authority, BEFORE the result is returned. The returned plan is reloaded
	 * after materialization so it reflects persisted node state.
	 */
	async startAutomatic(parentMissionId: string, options: StartAutomaticOptions = {}): Promise<AutomaticStartResult> {
		const parent = await this.loadMission(parentMissionId);
		if (isTerminalMissionState(parent.state))
			throw new Error(`PARENT_MISSION_TERMINAL: ${parentMissionId} is terminal and cannot own an orchestration`);

		const existingExecution = parent.request.orchestrationExecution;
		if (existingExecution) {
			if (
				options.childExecutionAuthority !== undefined &&
				options.childExecutionAuthority.trim() !== existingExecution.childExecutionAuthority
			)
				throw new Error(
					`AUTHORITY_MISMATCH: parent contract names '${existingExecution.childExecutionAuthority}', ` +
						`requested '${options.childExecutionAuthority}'`,
				);
			const loaded = await this._store.load(existingExecution.orchestrationId);
			if (loaded.status === "missing")
				throw new Error(`ORCHESTRATION_NOT_FOUND: ${existingExecution.orchestrationId}`);
			if (loaded.status === "corrupt") throw new Error(`ORCHESTRATION_PLAN_CORRUPT: ${loaded.diagnostic}`);
			if (loaded.document.plan.parentMissionId !== parentMissionId)
				throw new Error(
					`ORCHESTRATION_PARENT_MISMATCH: orchestration ${existingExecution.orchestrationId} belongs to ` +
						`${loaded.document.plan.parentMissionId}, not ${parentMissionId}`,
				);
			const reconcile = await this.materializeReady(existingExecution.orchestrationId);
			const updated = await this._store.load(existingExecution.orchestrationId);
			if (updated.status !== "ok") throw new Error(`ORCHESTRATION_NOT_FOUND: ${existingExecution.orchestrationId}`);
			return { ...reconcile, plan: updated.document.plan };
		}

		const planner = this._planner ?? createQwenPlanner();
		const plan = await this.createFromPlanner(proposalInputFor(parent, this._limits.maxTotalLogicalAgents), planner);
		if (options.childExecutionAuthority !== undefined)
			await this.attachOrchestrationExecution(
				parentMissionId,
				plan.orchestrationId,
				options.childExecutionAuthority,
			);
		const reconcile = await this.materializeReady(plan.orchestrationId);
		const updated = await this._store.load(plan.orchestrationId);
		if (updated.status !== "ok") throw new Error(`ORCHESTRATION_NOT_FOUND: ${plan.orchestrationId}`);
		return { ...reconcile, plan: updated.document.plan };
	}

	/**
	 * Plan, materialize, and explicitly resume the durable parent mission through
	 * the existing coordinator. The parent request contract is attached before
	 * `resume`, and no execution stack is constructed unless requested.
	 */
	async startAutomaticAndExecute(
		parentMissionId: string,
		options: AutomaticExecuteOptions,
	): Promise<DurableMissionRecord> {
		const existingParent = await this.loadMission(parentMissionId);
		if (isTerminalMissionState(existingParent.state)) return existingParent;
		if (!options.execution && !options.executionOptions)
			throw new Error("EXECUTION_OPTIONS_REQUIRED: executionOptions are required when execution is omitted");
		const execution =
			options.execution ??
			createParentOrchestrationExecution({
				...(options.executionOptions ?? {}),
				...(options.executionOptions?.port || this._childExecutionPort
					? { port: options.executionOptions?.port ?? this._childExecutionPort }
					: {}),
				missions: this._missions,
				store: this._store,
				orchestrator: this,
			});
		const authority =
			options.childExecutionAuthority ?? execution.port.authority ?? DEFAULT_ORCHESTRATION_CHILD_AUTHORITY;
		if (execution.port.authority !== authority)
			throw new Error(
				`AUTHORITY_MISMATCH: parent contract names '${authority}', execution provides '${execution.port.authority}'`,
			);
		await this.startAutomatic(parentMissionId, { childExecutionAuthority: authority });
		const resume = (signal?: AbortSignal) => execution.coordinator.resume(parentMissionId, { signal });
		if (execution.driver)
			return execution.driver.execute((signal) => resume(signal), {
				signal: options.resumeOptions?.signal,
				parentMissionId,
			});
		return resume(options.resumeOptions?.signal);
	}

	/**
	 * Persist the parent orchestration execution contract on the parent
	 * mission's durable request: atomically (DurableMissionStore `mutate`)
	 * update `request.orchestrationExecution` to name `orchestrationId` and
	 * `childExecutionAuthority`.
	 *
	 * Verified, never defaulted, never overwritten:
	 *   - `CHILD_EXECUTION_AUTHORITY_REQUIRED` — empty/whitespace authority
	 *   - `PARENT_MISSION_NOT_FOUND` / `PARENT_MISSION_CORRUPT`
	 *   - `PARENT_ALREADY_OWNS_ORCHESTRATION` — the parent already carries a
	 *     DIFFERENT contract (re-attaching the identical contract is
	 *     idempotent and writes nothing)
	 *   - `PARENT_MISSION_TERMINAL` — a terminal parent cannot own an
	 *     executable orchestration
	 *
	 * The contract is declarative: this writes no plan state and never
	 * launches anything. The parent lifecycle executor resolves the named
	 * authority later, at execution time.
	 */
	async attachOrchestrationExecution(
		parentMissionId: string,
		orchestrationId: string,
		childExecutionAuthority: string,
	): Promise<DurableMissionRecord> {
		const authority = childExecutionAuthority.trim();
		if (authority.length === 0)
			throw new Error("CHILD_EXECUTION_AUTHORITY_REQUIRED: a named child execution authority is required");
		const now = this._now();

		type AttachOutcome = { status: "attached" | "already_attached" | "conflict" | "terminal" };
		const result = await this._missions.mutate<AttachOutcome>(parentMissionId, (current) => {
			const existing = current.request.orchestrationExecution;
			if (existing) {
				if (existing.orchestrationId === orchestrationId && existing.childExecutionAuthority === authority)
					return { kind: "noop", value: { status: "already_attached" as const } };
				return { kind: "noop", value: { status: "conflict" as const } };
			}
			if (isTerminalMissionState(current.state)) return { kind: "noop", value: { status: "terminal" as const } };
			const next: DurableMissionRecord = {
				...current,
				request: Object.freeze({
					...current.request,
					orchestrationExecution: Object.freeze({ orchestrationId, childExecutionAuthority: authority }),
				}),
				updatedAtMs: now,
				revision: current.revision + 1,
			};
			return { kind: "write", next, value: { status: "attached" as const } };
		});

		if (result.status === "missing") throw new Error(`PARENT_MISSION_NOT_FOUND: ${parentMissionId}`);
		if (result.status === "corrupt")
			throw new Error(`PARENT_MISSION_CORRUPT: ${parentMissionId} is corrupt: ${result.diagnostic}`);
		switch (result.value.status) {
			case "attached":
			case "already_attached": {
				const loaded = await this.loadMission(parentMissionId);
				return loaded;
			}
			case "conflict":
				throw new Error(
					`PARENT_ALREADY_OWNS_ORCHESTRATION: ${parentMissionId} already carries a different ` +
						`orchestration execution contract`,
				);
			case "terminal":
				throw new Error(`PARENT_MISSION_TERMINAL: ${parentMissionId} is terminal and cannot own an orchestration`);
		}
	}

	/**
	 * Automatic orchestration preview. A single bounded planner probe (no
	 * replans, nothing persisted) reporting the plan `startAutomatic` would
	 * create for the parent mission.
	 */
	async previewAutomatic(parentMissionId: string): Promise<OrchestrationPreview> {
		const parent = await this.loadMission(parentMissionId);
		const planner = this._planner ?? createQwenPlanner();
		const proposed = await planner.propose(proposalInputFor(parent, this._limits.maxTotalLogicalAgents));
		const parsed = validatePlanProposal(proposed);
		if (!parsed.valid)
			return {
				plan: undefined,
				validation: { valid: false, issues: parsed.issues, dependencyCriticality: new Map() },
				issues: parsed.issues,
			};
		const plan = this.buildPlan({ parentMissionId, proposal: parsed.proposal, parentDepth: parent.depth });
		const validation = validateOrchestrationPlan(plan, {
			parentDepth: parent.depth,
			operatorAgents: this.effectiveOperatorAgents(undefined, planner),
		});
		return { plan: validation.valid ? plan : undefined, validation, issues: validation.issues };
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
			if (this._governance) {
				const admission = await this._governance.recordOrchestrationChild({
					missionId: plan.parentMissionId,
					eventId: `orchestration:${plan.orchestrationId}:child:${node.nodeId}`,
					childId: childMissionId(plan.orchestrationId, node.nodeId),
					orchestrationDepth: 1,
					atMs: this._now(),
					correlation: {
						parentMissionId: plan.parentMissionId,
						orchestrationId: plan.orchestrationId,
						nodeId: node.nodeId,
						phase: "child_materialization",
					},
				});
				if (!admission.allowed) {
					const deniedIndex = nextNodes.findIndex((candidate) => candidate.nodeId === node.nodeId);
					nextNodes[deniedIndex] = { ...node, status: "UNSCHEDULABLE", lastError: admission.reason };
					continue;
				}
			}
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
