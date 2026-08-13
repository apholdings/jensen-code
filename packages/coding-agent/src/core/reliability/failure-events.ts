/**
 * Normalized failure taxonomy.
 *
 * Failures become structured runtime events instead of arbitrary strings so the
 * future Recovery Engine (2.1.1) can attach cleanly. No autonomous recovery
 * policy is implemented here — only classification and observability.
 */

import type { ActionValidationFailureCategory, FailureCategory, FailureEvent } from "./types.js";

/** Map a validation failure category to the normalized runtime failure category. */
export function classifyValidationFailure(category: ActionValidationFailureCategory): FailureCategory {
	switch (category) {
		case "BOUNDARY_VIOLATION":
			return "BOUNDARY_VIOLATION";
		case "PERMISSION_VIOLATION":
		case "FORBIDDEN_ACTION":
		case "MISSION_CONSTRAINT_VIOLATION":
			return "PERMISSION_FAILURE";
		case "UNKNOWN_ACTION_TYPE":
			return "ACTION_DECODE_FAILURE";
		default:
			return "ACTION_VALIDATION_FAILURE";
	}
}

export function createFailureEvent(
	category: FailureCategory,
	message: string,
	options: { recoverable?: boolean; details?: unknown; timestamp?: string } = {},
): FailureEvent {
	return {
		category,
		message,
		recoverable: options.recoverable ?? true,
		timestamp: options.timestamp ?? new Date().toISOString(),
		details: options.details,
	};
}

/** Human-readable, stable message for a finalization rejection. */
export function finalizationRejectedMessage(missingCriterionIds: string[]): string {
	if (missingCriterionIds.length === 0) {
		return "FINALIZATION_REJECTED: no active blockers";
	}
	return `FINALIZATION_REJECTED\n\nUnverified acceptance criteria:\n${missingCriterionIds
		.map((id) => `- ${id}`)
		.join("\n")}`;
}
