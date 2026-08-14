/**
 * Reliability execution step — a Jensen-owned decode/validate/execute/record
 * pipeline over raw model output.
 *
 * This is the authority boundary in code form: raw output is decoded into an
 * AgentAction, validated against the tool registry/boundary/policy, and only
 * then executed. Evidence is recorded by Jensen from the observed outcome.
 *
 * The deterministic Reliability Suite drives the kernel through this function
 * with a scripted model and tool harness. The LIVE agent loop integrates with
 * the same decoder/validator/evidence/gate primitives through
 * {@link ReliabilitySessionBridge} (wired by ReliabilitySessionController as
 * Agent beforeToolCall/afterToolCall/onTurnEnd hooks) rather than through this
 * function, so the live loop is not duplicated and adversarial behavior cannot
 * bypass the kernel by taking a different code path.
 */

import { decodeAction } from "./action-decoder.js";
import { type ActionValidatorContext, validateToolCallAction } from "./action-validator.js";
import type { MissionRuntime } from "./mission-runtime.js";
import type { ActionValidationFailure, AgentAction, MissionEvidence, ToolCallAction } from "./types.js";

export interface ReliabilityExecutionContext extends ActionValidatorContext {
	/** Execute a validated tool action and return the observed outcome. */
	executeTool(action: ToolCallAction): Promise<MissionEvidence>;
}

export type ReliabilityStepResult =
	| { kind: "executed"; action: ToolCallAction; evidence: MissionEvidence }
	| { kind: "validation_rejected"; failure: ActionValidationFailure }
	| { kind: "decode_rejected"; failure: ActionValidationFailure }
	| { kind: "non_tool"; action: Exclude<AgentAction, ToolCallAction> };

/**
 * Decode, validate, and (if valid) execute a single raw model output as a
 * Jensen-owned action. Never executes an invalid action. Never throws for
 * invalid model output — failures are returned as structured results.
 */
export async function executeAgentAction(
	runtime: MissionRuntime,
	raw: unknown,
	ctx: ReliabilityExecutionContext,
): Promise<ReliabilityStepResult> {
	const decoded = decodeAction(raw);
	if (!decoded.ok) {
		runtime.recorder.record("action_decode_failure", { message: decoded.failure.message });
		return { kind: "decode_rejected", failure: decoded.failure };
	}

	const action = decoded.action;
	runtime.recorder.record("action_proposed", { type: action.type });

	if (action.type !== "tool_call") {
		return { kind: "non_tool", action };
	}

	const validated = validateToolCallAction(action, ctx);
	if (!validated.ok) {
		runtime.recorder.record("action_validation_failure", {
			tool: action.tool,
			category: validated.failure.category,
		});
		return { kind: "validation_rejected", failure: validated.failure };
	}

	const evidence = await ctx.executeTool(validated.action);
	runtime.recordToolEvidence(evidence);
	if (evidence.success === false) {
		runtime.recorder.record("tool_failed", { tool: action.tool });
	} else {
		runtime.recorder.record("tool_executed", { tool: action.tool });
	}
	return { kind: "executed", action: validated.action, evidence };
}
