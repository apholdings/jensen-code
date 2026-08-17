/**
 * Parent orchestration lifecycle executor (2.15.0).
 *
 * The parent side of the child execution boundary. It owns the parent's
 * lifecycle step of driving a materialized orchestration toward execution
 * without ever launching anything itself and without re-implementing the
 * port's verification:
 *
 *   1. Load the parent mission from the durable mission store.
 *   2. Read the parent's durable execution contract
 *      (`MissionRequest.orchestrationExecution`) — the plan identity and the
 *      named child execution authority.
 *   3. Resolve the named authority against the registered ports'
 *      `authority` identities. Verified, never defaulted: an unknown
 *      authority is a hard error, and duplicate authority identities fail
 *      construction.
 *   4. Load the named plan and verify it belongs to this parent.
 *   5. Request execution of every materialized node through
 *      `port.executeChild` using the node's durable structured identity.
 *   6. Poll status/terminal outcome for a materialized node through the
 *      port's optional `childStatus` when the named authority provides it.
 *
 * The port remains the single verification and launch authority (it
 * re-verifies plan/node identity, child metadata, the parent's contract, and
 * terminal state, and owns the launch — Scheduler/Worker, local runtime, or
 * remote executor). This executor is read-only against both stores: it
 * never enqueues, assigns, starts, or launches, and it writes no plan or
 * mission state.
 */

import type { DurableMissionRecord, DurableMissionStore } from "../mission-domain/durable-store.js";
import type { MissionOrchestrationExecution } from "../mission-domain/mission-request.js";
import type {
	OrchestrationChildExecutionPort,
	OrchestrationChildExecutionReceipt,
	OrchestrationChildExecutionRequest,
	OrchestrationChildExecutionStatus,
	OrchestrationPlanDocument,
	OrchestrationStore,
} from "./types.js";

export interface OrchestrationLifecycleExecutorOptions {
	/** Durable mission store for parent contract resolution. */
	missions: DurableMissionStore;
	/** Orchestration plan store for materialized node identity. */
	store: OrchestrationStore;
	/**
	 * Registered child execution authorities. The parent's durable contract
	 * names exactly one by `childExecutionAuthority`; a duplicate authority
	 * identity is a construction error (verified, never defaulted).
	 */
	ports: readonly OrchestrationChildExecutionPort[];
}

/** Structured outcome for one plan node in a lifecycle launch pass. */
export interface OrchestrationLifecycleNodeOutcome {
	nodeId: string;
	/** True when the node carries a durable child identity (mission + session). */
	materialized: boolean;
	/** True when the port accepted the execution request. */
	launched: boolean;
	/** Authoritative port receipt for materialized nodes. */
	receipt?: OrchestrationChildExecutionReceipt;
}

/** Structured outcome of one lifecycle launch pass for a parent mission. */
export interface OrchestrationLifecycleLaunchOutcome {
	parentMissionId: string;
	orchestrationId: string;
	/** Authority identity that handled the pass. */
	authority: string;
	nodes: OrchestrationLifecycleNodeOutcome[];
	materializedCount: number;
	launchedCount: number;
	declinedCount: number;
}

/**
 * Resolve the child execution authority named by a parent mission's durable
 * contract against the registered ports.
 *
 * Throws (never defaults):
 *   - `PARENT_MISSION_NOT_FOUND` / `PARENT_MISSION_CORRUPT` — parent missing
 *   - `NO_ORCHESTRATION_EXECUTION_CONTRACT` — parent does not own an
 *     orchestration
 *   - `AUTHORITY_NOT_REGISTERED` — the named authority is not registered
 */
export async function resolveChildExecutionAuthority(
	missions: DurableMissionStore,
	parentMissionId: string,
	ports: readonly OrchestrationChildExecutionPort[],
): Promise<OrchestrationChildExecutionPort> {
	const parent = await loadParentMission(missions, parentMissionId);
	const execution = parent.request.orchestrationExecution;
	if (!execution)
		throw new Error(`NO_ORCHESTRATION_EXECUTION_CONTRACT: ${parentMissionId} names no orchestration execution`);
	const port = ports.find((candidate) => candidate.authority === execution.childExecutionAuthority);
	if (!port)
		throw new Error(
			`AUTHORITY_NOT_REGISTERED: no child execution authority registered for '${execution.childExecutionAuthority}'`,
		);
	return port;
}

async function loadParentMission(
	missions: DurableMissionStore,
	parentMissionId: string,
): Promise<DurableMissionRecord> {
	const loaded = await missions.load(parentMissionId);
	if (loaded.status === "missing") throw new Error(`PARENT_MISSION_NOT_FOUND: ${parentMissionId}`);
	if (loaded.status === "corrupt")
		throw new Error(`PARENT_MISSION_CORRUPT: ${parentMissionId} is corrupt: ${loaded.diagnostic}`);
	return loaded.record;
}

export class OrchestrationLifecycleExecutor {
	private readonly _missions: DurableMissionStore;
	private readonly _store: OrchestrationStore;
	private readonly _portsByAuthority: ReadonlyMap<string, OrchestrationChildExecutionPort>;

	constructor(options: OrchestrationLifecycleExecutorOptions) {
		this._missions = options.missions;
		this._store = options.store;
		const byAuthority = new Map<string, OrchestrationChildExecutionPort>();
		for (const port of options.ports) {
			if (byAuthority.has(port.authority))
				throw new Error(`DUPLICATE_AUTHORITY: child execution authority '${port.authority}' is registered twice`);
			byAuthority.set(port.authority, port);
		}
		this._portsByAuthority = byAuthority;
	}

	/** Registered authorities, in registration order. */
	get authorities(): readonly string[] {
		return [...this._portsByAuthority.keys()];
	}

	/**
	 * Resolve the child execution authority named by the parent's durable
	 * contract. See `resolveChildExecutionAuthority` for the error contract.
	 */
	async resolvePort(parentMissionId: string): Promise<OrchestrationChildExecutionPort> {
		return resolveChildExecutionAuthority(this._missions, parentMissionId, [...this._portsByAuthority.values()]);
	}

	/**
	 * Drive one lifecycle launch pass for the parent mission's orchestration.
	 *
	 * Loads the parent's durable contract, resolves the named authority,
	 * verifies the named plan belongs to this parent, and requests execution
	 * of every materialized node through the port. Non-materialized nodes are
	 * reported as such and never presented to the port. The port's receipt is
	 * authoritative; the executor never launches and never writes state.
	 *
	 * Throws (never defaults): `PARENT_MISSION_NOT_FOUND`,
	 * `PARENT_MISSION_CORRUPT`, `NO_ORCHESTRATION_EXECUTION_CONTRACT`,
	 * `AUTHORITY_NOT_REGISTERED`, `ORCHESTRATION_NOT_FOUND`,
	 * `ORCHESTRATION_PLAN_CORRUPT`, `ORCHESTRATION_PARENT_MISMATCH`.
	 */
	async launchChildren(parentMissionId: string): Promise<OrchestrationLifecycleLaunchOutcome> {
		const { execution, port, document } = await this._resolveExecutionContext(parentMissionId);

		const nodes: OrchestrationLifecycleNodeOutcome[] = [];
		let launchedCount = 0;
		let declinedCount = 0;
		for (const node of document.plan.nodes) {
			const childMissionId = node.childMissionId;
			const childSessionId = node.childSessionId;
			if (!childMissionId || !childSessionId) {
				nodes.push({ nodeId: node.nodeId, materialized: false, launched: false });
				continue;
			}
			const request: OrchestrationChildExecutionRequest = {
				orchestrationId: execution.orchestrationId,
				nodeId: node.nodeId,
				childMissionId,
				childSessionId,
				workspaceAccess: node.workspaceAccess,
			};
			const receipt = await port.executeChild(request);
			if (receipt.accepted) launchedCount++;
			else declinedCount++;
			nodes.push({ nodeId: node.nodeId, materialized: true, launched: receipt.accepted, receipt });
		}
		return {
			parentMissionId,
			orchestrationId: execution.orchestrationId,
			authority: port.authority,
			nodes,
			materializedCount: nodes.filter((outcome) => outcome.materialized).length,
			launchedCount,
			declinedCount,
		};
	}

	/**
	 * Poll the status/terminal outcome of one materialized node through the
	 * child execution authority named by the parent's durable contract.
	 *
	 * The request is built from the node's durable structured identity in the
	 * plan — the caller never supplies child mission or session identity. The
	 * port's polling is authoritative (it owns the read model); the executor
	 * performs no launches and writes no state.
	 *
	 * Throws (never defaults): `PARENT_MISSION_NOT_FOUND`,
	 * `PARENT_MISSION_CORRUPT`, `NO_ORCHESTRATION_EXECUTION_CONTRACT`,
	 * `AUTHORITY_NOT_REGISTERED`, `ORCHESTRATION_NOT_FOUND`,
	 * `ORCHESTRATION_PLAN_CORRUPT`, `ORCHESTRATION_PARENT_MISMATCH`,
	 * `NODE_NOT_FOUND`, `CHILD_NOT_MATERIALIZED`, `PORT_LACKS_CHILD_STATUS`.
	 */
	async childStatus(parentMissionId: string, nodeId: string): Promise<OrchestrationChildExecutionStatus> {
		const { execution, port, document } = await this._resolveExecutionContext(parentMissionId);
		const node = document.plan.nodes.find((candidate) => candidate.nodeId === nodeId);
		if (!node) throw new Error(`NODE_NOT_FOUND: orchestration ${execution.orchestrationId} has no node ${nodeId}`);
		if (!node.childMissionId || !node.childSessionId)
			throw new Error(`CHILD_NOT_MATERIALIZED: node ${nodeId} has no materialized child mission`);
		if (typeof port.childStatus !== "function")
			throw new Error(
				`PORT_LACKS_CHILD_STATUS: child execution authority '${port.authority}' does not provide child status polling`,
			);
		return port.childStatus({
			orchestrationId: execution.orchestrationId,
			nodeId,
			childMissionId: node.childMissionId,
			childSessionId: node.childSessionId,
			workspaceAccess: node.workspaceAccess,
		});
	}

	/**
	 * Shared preamble for launch and status paths: load the parent mission,
	 * verify its durable orchestration execution contract, resolve the named
	 * authority (verified, never defaulted), and verify the named plan belongs
	 * to this parent.
	 */
	private async _resolveExecutionContext(parentMissionId: string): Promise<{
		execution: MissionOrchestrationExecution;
		port: OrchestrationChildExecutionPort;
		document: OrchestrationPlanDocument;
	}> {
		const parent = await loadParentMission(this._missions, parentMissionId);
		const execution = parent.request.orchestrationExecution;
		if (!execution)
			throw new Error(`NO_ORCHESTRATION_EXECUTION_CONTRACT: ${parentMissionId} names no orchestration execution`);
		const port = this._portsByAuthority.get(execution.childExecutionAuthority);
		if (!port)
			throw new Error(
				`AUTHORITY_NOT_REGISTERED: no child execution authority registered for '${execution.childExecutionAuthority}'`,
			);
		const document = await this._loadPlan(execution.orchestrationId);
		if (document.plan.parentMissionId !== parentMissionId)
			throw new Error(
				`ORCHESTRATION_PARENT_MISMATCH: orchestration ${execution.orchestrationId} belongs to ` +
					`${document.plan.parentMissionId}, not ${parentMissionId}`,
			);
		return { execution, port, document };
	}

	private async _loadPlan(orchestrationId: string): Promise<OrchestrationPlanDocument> {
		const loaded = await this._store.load(orchestrationId);
		if (loaded.status === "missing") throw new Error(`ORCHESTRATION_NOT_FOUND: ${orchestrationId}`);
		if (loaded.status === "corrupt")
			throw new Error(`ORCHESTRATION_PLAN_CORRUPT: ${orchestrationId} is corrupt: ${loaded.diagnostic}`);
		return loaded.document;
	}
}

/** Build an `OrchestrationLifecycleExecutor` over the given stores and ports. */
export function createOrchestrationLifecycleExecutor(
	options: OrchestrationLifecycleExecutorOptions,
): OrchestrationLifecycleExecutor {
	return new OrchestrationLifecycleExecutor(options);
}
