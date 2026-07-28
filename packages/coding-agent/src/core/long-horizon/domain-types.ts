/**
 * Shared long-horizon domain primitives.
 *
 * These types are neutral with respect to benchmark evaluation and
 * mission-contract/ledger tracking. They are the single canonical
 * source for requirement state semantics used by:
 *   - LH-0 benchmark evaluation
 *   - LH-1 mission contract and requirement ledger
 *   - Future LH phases
 */

// =============================================================================
// Requirement Evaluation Status
// =============================================================================

/**
 * Canonical requirement evaluation states.
 *
 * Semver: this is a closed union. Adding a new state is a breaking change.
 * All consumers MUST handle all 8 states exhaustively.
 */
export type RequirementEvaluationStatus =
	| "UNASSESSED"
	| "PENDING"
	| "IN_PROGRESS"
	| "IMPLEMENTED_UNVERIFIED"
	| "SATISFIED"
	| "BLOCKED"
	| "NOT_APPLICABLE"
	| "FAILED";
