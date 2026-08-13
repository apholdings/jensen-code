/**
 * Action Validator — Jensen-owned execution authority boundary.
 *
 * No model-proposed executable action may reach a tool without passing this
 * validator. It checks, in order:
 *
 *   1. tool exists in the registry
 *   2. arguments parse and satisfy the tool schema
 *   3. required arguments are present and correctly typed (schema)
 *   4. the action is not a mission-forbidden action
 *   5. the action respects the workspace/path boundary
 *   6. the action respects permission/effect policy
 *
 * Any failure returns a structured ActionValidationFailure and the tool is NOT
 * executed. The validator is provider-independent: the live integration injects
 * the real tool registry, boundary, and policy adapters.
 */

import type { ActionValidationFailureCategory, ActionValidationResult, ToolCallAction } from "./types.js";

export interface ToolSchemaValidator {
	exists(name: string): boolean;
	validateArgs(
		name: string,
		args: Record<string, unknown>,
	): { ok: true; normalized: Record<string, unknown> } | { ok: false; message: string };
}

export interface ActionPolicyAdapter {
	/** Return a reason string when the action is forbidden, else undefined. */
	forbiddenReason(action: ToolCallAction): string | undefined;
	/** Return a reason string when the action violates the boundary, else undefined. */
	boundaryViolationReason(action: ToolCallAction): string | undefined;
	/** Return a reason string when the action violates permission policy, else undefined. */
	permissionViolationReason(action: ToolCallAction): string | undefined;
}

export interface ActionValidatorContext {
	schema: ToolSchemaValidator;
	policy?: ActionPolicyAdapter;
}

const NOOP_POLICY: ActionPolicyAdapter = {
	forbiddenReason: () => undefined,
	boundaryViolationReason: () => undefined,
	permissionViolationReason: () => undefined,
};

function failure(
	category: ActionValidationFailureCategory,
	message: string,
	recoverable: boolean,
	details?: unknown,
): ActionValidationResult {
	return { ok: false, failure: { category, message, recoverable, details } };
}

/**
 * Validate a model-proposed tool call. Returns a normalized/validated argument
 * object on success; a structured failure otherwise. Never throws and never
 * executes anything.
 */
export function validateToolCallAction(action: ToolCallAction, ctx: ActionValidatorContext): ActionValidationResult {
	const policy = ctx.policy ?? NOOP_POLICY;

	if (!ctx.schema.exists(action.tool)) {
		return failure("UNKNOWN_TOOL", `Tool ${action.tool} not found`, false, { tool: action.tool });
	}

	const argsResult = ctx.schema.validateArgs(action.tool, action.arguments);
	if (!argsResult.ok) {
		return failure("INVALID_ARGUMENTS", `Tool ${action.tool}: ${argsResult.message}`, true, {
			tool: action.tool,
		});
	}

	const normalizedArgs = argsResult.normalized;

	const forbidden = policy.forbiddenReason(action);
	if (forbidden) {
		return failure("FORBIDDEN_ACTION", `Tool ${action.tool} is forbidden: ${forbidden}`, false, {
			tool: action.tool,
		});
	}

	const boundary = policy.boundaryViolationReason(action);
	if (boundary) {
		return failure("BOUNDARY_VIOLATION", `Tool ${action.tool} violates workspace boundary: ${boundary}`, false, {
			tool: action.tool,
		});
	}

	const permission = policy.permissionViolationReason(action);
	if (permission) {
		return failure("PERMISSION_VIOLATION", `Tool ${action.tool} is not permitted: ${permission}`, false, {
			tool: action.tool,
		});
	}

	return { ok: true, action, normalizedArgs };
}
