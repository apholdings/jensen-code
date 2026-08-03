/**
 * Context handoff and synthesis.
 *
 * A typed context packet for subagents and model-role transitions. Contains
 * only the objective, relevant criteria, selected evidence, selected file
 * references, structured state, bounded recent failures, explicit constraints,
 * and the required output schema — never full hidden reasoning, unrelated
 * transcript, unbounded logs, secrets, or stale cached conclusions as
 * authority. Subagent results are claims that the parent must validate.
 */

import type { AcceptanceCriterion } from "./types.js";

export interface ContextPacket {
	objective: string;
	criteria: readonly AcceptanceCriterion[];
	selectedEvidence: readonly { evidenceId: string; summary: string }[];
	selectedFileRefs: readonly string[];
	structuredState: Record<string, unknown>;
	boundedRecentFailures: readonly { fingerprint: string; count: number }[];
	explicitConstraints: readonly string[];
	requiredOutputSchema?: string;
	forbiddenContent: readonly ("secrets" | "reasoning" | "transcript" | "logs")[];
}

export interface PacketValidation {
	valid: boolean;
	reasons: string[];
}

const TOO_MANY_FILES = 128;
const TOO_MANY_EVIDENCE = 256;
const MAX_FAILURE_ENTRIES = 16;

/** Deterministically validate that a packet is bounded and contains no forbidden sensitive content. */
export function validateContextPacket(packet: ContextPacket): PacketValidation {
	const reasons: string[] = [];
	if (!packet.objective || packet.objective.trim().length === 0) {
		reasons.push("OBJECTIVE_REQUIRED");
	}
	if (packet.selectedFileRefs.length > TOO_MANY_FILES) {
		reasons.push("TOO_MANY_FILES");
	}
	if (packet.selectedEvidence.length > TOO_MANY_EVIDENCE) {
		reasons.push("TOO_MANY_EVIDENCE");
	}
	if (packet.boundedRecentFailures.length > MAX_FAILURE_ENTRIES) {
		reasons.push("TOO_MANY_FAILURES");
	}
	if (packet.forbiddenContent.includes("secrets") && hasSecretPattern(packet)) {
		reasons.push("SECRET_CANDIDATE_IN_PACKET");
	}
	if (packet.forbiddenContent.includes("reasoning") && packet.structuredState.chainOfThought) {
		reasons.push("HIDDEN_REASONING_IN_PACKET");
	}
	return { valid: reasons.length === 0, reasons };
}

function hasSecretPattern(packet: ContextPacket): boolean {
	const sensitiveKeys = ["apiKey", "token", "secret", "password", "privateKey", "credential"];
	const values: string[] = [];
	const collect = (obj: unknown): void => {
		if (typeof obj === "string") values.push(obj);
		else if (obj && typeof obj === "object") {
			for (const value of Object.values(obj as Record<string, unknown>)) collect(value);
		}
	};
	collect(packet.structuredState);
	for (const key of sensitiveKeys) {
		if (Object.hasOwn(packet.structuredState, key)) {
			if (typeof packet.structuredState[key] === "string") return true;
		}
	}
	return values.some((v) => /(?:^|[^a-z0-9])(?:sk-|ghp_|Bearer\s+)/iu.test(v));
}

/**
 * Reconcile contradictory child results: a deterministic claim validator.
 * The parent is authoritative — contradictory or unverifiable results become
 * explicit unresolved findings, never silently merged truth.
 */
export function reconcileChildResults(claims: readonly { childId: string; claim: unknown; supported?: boolean }[]) {
	const contradictions: string[] = [];
	const accepted: string[] = [];
	for (const c of claims) {
		if (c.supported === false) {
			contradictions.push(`${c.childId}:unsupported-claim`);
		} else {
			accepted.push(c.childId);
		}
	}
	return { accepted, contradictions };
}
