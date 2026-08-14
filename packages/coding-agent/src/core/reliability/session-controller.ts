/**
 * Reliability Session Controller — production wiring between a live AgentSession
 * and the Reliability Kernel.
 *
 * The controller owns the MissionRuntime, ReliabilitySessionBridge, and the
 * deterministic verification executor. AgentSession delegates its
 * beforeToolCall / afterToolCall / onTurnEnd hooks here so that:
 *
 *   - every real tool call is validated against mission policy (boundary,
 *     forbidden, permission) before execution — schema validation remains the
 *     agent loop's responsibility and is not duplicated here;
 *   - every real tool outcome is recorded as authoritative evidence;
 *   - a model that "thinks it is done" is routed through the Completion Gate;
 *   - mission state persists with the session and restores on resume.
 *
 * Tool governance (policy + evidence) is active for every session. The
 * completion gate only applies while a mission is active; plain chat sessions
 * without a mission stop normally.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { AgentMessage, AgentTool, AgentToolCall } from "@apholdings/jensen-agent-core";
import type { SessionManager } from "../session-manager.js";
import type { ActionPolicyAdapter } from "./action-validator.js";
import { finalizationRejectedMessage } from "./failure-events.js";
import { createToolSchemaValidator, ReliabilitySessionBridge } from "./integration.js";
import type { MissionDefinitionInput } from "./mission-contract-factory.js";
import { MissionRuntime } from "./mission-runtime.js";
import type { ActionValidationFailureCategory, ToolCallAction } from "./types.js";
import { type VerificationExecutor, verify } from "./verifier.js";

export interface ReliabilitySessionControllerOptions {
	/** Session working directory (the workspace boundary root). */
	cwd: string;
	/** Session manager used to persist/restore the mission document. */
	sessionManager: SessionManager;
	/** Deterministic verification executor bound to the workspace. */
	verificationExecutor: VerificationExecutor;
	/** Returns the currently active tools (used for mission schema validation). */
	getTools: () => readonly AgentTool[];
	/** Tool names always forbidden for reliability-governed tool calls. */
	forbiddenTools?: readonly string[];
	/** Maximum consecutive finalization rejections before the run ends (bounded loop guard). */
	maxFinalizationRejections?: number;
}

export interface ReliabilityBeforeResult {
	block: boolean;
	reason?: string;
}

export interface ReliabilityTurnEndResult {
	continue: boolean;
	message?: AgentMessage;
}

export class ReliabilitySessionController {
	private readonly _cwd: string;
	private readonly _sessionManager: SessionManager;
	private readonly _verificationExecutor: VerificationExecutor;
	private readonly _getTools: () => readonly AgentTool[];
	private readonly _policy: ActionPolicyAdapter;
	private readonly _maxFinalizationRejections: number;

	private _runtime?: MissionRuntime;
	private _bridge?: ReliabilitySessionBridge;
	private _corruptPersistedState = false;
	private _rejectionsThisRun = 0;

	constructor(options: ReliabilitySessionControllerOptions) {
		this._cwd = options.cwd;
		this._sessionManager = options.sessionManager;
		this._verificationExecutor = options.verificationExecutor;
		this._getTools = options.getTools;
		this._maxFinalizationRejections = options.maxFinalizationRejections ?? 3;
		this._policy = this._buildPolicy(options.forbiddenTools ?? []);

		this._restore();
	}

	// =========================================================================
	// State accessors
	// =========================================================================

	get isActive(): boolean {
		return this._runtime !== undefined;
	}

	get missionId(): string | undefined {
		return this._runtime?.missionId;
	}

	get phase(): MissionRuntime["phase"] | undefined {
		return this._runtime?.phase;
	}

	get runtime(): MissionRuntime | undefined {
		return this._runtime;
	}

	get corruptPersistedState(): boolean {
		return this._corruptPersistedState;
	}

	criterionView(): ReturnType<MissionRuntime["criterionView"]> {
		return this._runtime?.criterionView() ?? [];
	}

	summarizeForModel(): string | undefined {
		return this._runtime?.summarizeForModel();
	}

	// =========================================================================
	// Mission lifecycle
	// =========================================================================

	/** Create and attach a new governed mission from an explicit definition. */
	startMission(definition: MissionDefinitionInput): void {
		const runtime = MissionRuntime.create(definition);
		this._attach(runtime);
		this._corruptPersistedState = false;
		// Leave PLANNING so the live loop can act on the mission.
		this._advanceTo("START_EXECUTION");
		this._persist();
	}

	/** Reset the per-run rejection counter (call when a new run begins). */
	resetRun(): void {
		this._rejectionsThisRun = 0;
	}

	private _restore(): void {
		const persisted = this._sessionManager.getLatestReliabilityState();
		if (!persisted) return;

		try {
			this._attach(MissionRuntime.deserialize(persisted.data));
			this._rejectionsThisRun = 0;
		} catch {
			// A corrupt/foreign persisted document must never abort session load and
			// must never be silently overwritten: mark it and keep running without
			// a mission until the caller explicitly starts a fresh one.
			this._corruptPersistedState = true;
			this._runtime = undefined;
			this._bridge = undefined;
		}
	}

	private _attach(runtime: MissionRuntime): void {
		this._runtime = runtime;
		this._bridge = new ReliabilitySessionBridge(runtime, createToolSchemaValidator(this._getTools()), this._policy);
	}

	private _buildPolicy(forbiddenTools: readonly string[]): ActionPolicyAdapter {
		const root = resolve(this._cwd);
		const forbidden = new Set(forbiddenTools);

		const pathArg = (action: ToolCallAction): string | undefined => {
			const args = action.arguments as Record<string, unknown>;
			const candidate = args?.path ?? args?.file ?? args?.filePath ?? args?.target ?? args?.newPath;
			return typeof candidate === "string" ? candidate : undefined;
		};

		return {
			forbiddenReason(action) {
				if (forbidden.has(action.tool)) {
					return `tool '${action.tool}' is forbidden for this mission`;
				}
				return undefined;
			},
			boundaryViolationReason(action) {
				const p = pathArg(action);
				if (!p) return undefined;
				if (p.includes("\u0000")) return "path contains NUL byte";

				// Resolve lexically against the workspace root and reject only paths
				// that escape it (including `..` escapes). This is defense in depth;
				// the tool executor enforces the realpath boundary.
				const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
				const rel = relative(root, abs);
				if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
					return "path resolves outside the workspace boundary";
				}
				return undefined;
			},
			permissionViolationReason() {
				return undefined;
			},
		};
	}

	// =========================================================================
	// Tool governance hooks
	// =========================================================================

	/** Validate a real tool call against mission policy before execution. */
	beforeToolCall(toolCall: AgentToolCall): ReliabilityBeforeResult {
		const action = this._toToolCallAction(toolCall);

		const forbidden = this._policy.forbiddenReason(action);
		if (forbidden) {
			return this._reject(action, `Tool ${action.tool} is forbidden: ${forbidden}`, "FORBIDDEN_ACTION");
		}

		const boundary = this._policy.boundaryViolationReason(action);
		if (boundary) {
			return this._reject(
				action,
				`Tool ${action.tool} violates workspace boundary: ${boundary}`,
				"BOUNDARY_VIOLATION",
			);
		}

		const permission = this._policy.permissionViolationReason(action);
		if (permission) {
			return this._reject(action, `Tool ${action.tool} is not permitted: ${permission}`, "PERMISSION_VIOLATION");
		}

		return { block: false };
	}

	/** Record a real tool outcome as authoritative evidence. */
	afterToolCall(toolCall: AgentToolCall, isError: boolean, summary?: string): void {
		if (!this._bridge) return;
		this._bridge.afterToolCall(this._toToolCallAction(toolCall), isError, summary);
		// Evidence is persisted at the next turn checkpoint to avoid write churn
		// on every individual tool call while still surviving a crash between turns.
	}

	private _toToolCallAction(toolCall: AgentToolCall): ToolCallAction {
		return {
			type: "tool_call",
			tool: toolCall.name,
			toolCallId: toolCall.id,
			arguments: toolCall.arguments as Record<string, unknown>,
		};
	}

	private _reject(
		action: ToolCallAction,
		reason: string,
		category: ActionValidationFailureCategory,
	): ReliabilityBeforeResult {
		this._runtime?.recorder.record("action_validation_failure", { tool: action.tool, category });
		this._persist();
		return { block: true, reason };
	}

	// =========================================================================
	// Turn-end policy (Completion Gate authority)
	// =========================================================================

	/**
	 * Called when the model finished its turn without further tool calls.
	 *
	 * Runs automatic deterministic verification for outstanding criteria, then
	 * routes the model's implicit "I am done" through the Completion Gate.
	 */
	async onTurnEnd(): Promise<ReliabilityTurnEndResult> {
		if (!this._runtime) return { continue: false };

		// Advance the execution state machine so deterministic verification and
		// the completion gate have an authoritative place to run.
		this._advanceTo("START_EXECUTION");
		this._advanceTo("REQUEST_VERIFICATION");

		await this._runAutomaticFinalVerification();

		this._advanceTo("REQUEST_COMPLETION_REVIEW");

		const gate = this._runtime.proposeFinalCandidate();
		this._persist();

		if (gate.decision === "accept") {
			this._runtime.approveCompletion();
			this._persist();
			return { continue: false };
		}

		// Rejected (missing criteria or genuine blockers): return control to the
		// execution state so the mission remains resumable and never loops forever.
		this._advanceTo("RETURN_TO_EXECUTION");
		this._persist();

		if (gate.blockedBy.length > 0) {
			return { continue: false };
		}

		// Bounded rejection: give the model structured feedback and another turn,
		// up to a fixed limit, then stop to avoid an infinite loop.
		if (this._rejectionsThisRun >= this._maxFinalizationRejections) {
			return { continue: false };
		}
		this._rejectionsThisRun += 1;

		return {
			continue: true,
			message: {
				role: "user",
				content: [{ type: "text", text: finalizationRejectedMessage(gate.missingCriterionIds) }],
				timestamp: Date.now(),
			},
		};
	}

	/** Apply an execution transition, ignoring transitions the state machine already passed. */
	private _advanceTo(kind: Parameters<MissionRuntime["transition"]>[0]): void {
		if (!this._runtime) return;
		const result = this._runtime.transition(kind);
		if (result.ok) {
			this._persist();
		}
	}

	private async _runAutomaticFinalVerification(): Promise<void> {
		if (!this._runtime) return;
		for (const criterion of this._runtime.criterionView()) {
			if (criterion.status === "passed") continue;
			if (!criterion.verification) continue;
			const result = await verify(criterion.verification, this._verificationExecutor, {
				criterionId: criterion.id,
				cwd: this._cwd,
			});
			this._runtime.recordVerification(criterion.id, result);
		}
	}

	// =========================================================================
	// Persistence
	// =========================================================================

	private _persist(): void {
		if (!this._runtime) return;
		this._sessionManager.appendReliabilityState(this._runtime.serialize());
	}
}
