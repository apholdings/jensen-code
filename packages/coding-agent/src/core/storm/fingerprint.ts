import { stableHash } from "../tool-call/canonicalize.js";

/**
 * Canonical call fingerprint for storm detection.
 *
 * Fingerprint basis:
 *  - tool identity
 *  - normalized canonical arguments (stable hash)
 *  - a relevant fixed execution context (workspace id / run scope)
 *
 * Deliberately EXCLUDES volatile ids (provider tool-call ids, timestamps) that
 * would defeat duplicate detection. The fingerprint is NOT consulted when the
 * authoritative context changed (see StormBreaker#classify).
 */
export interface CallFingerprintInput {
	toolName: string;
	canonicalArgsHash: string;
	workspaceScope?: string;
	runScope?: string;
}

/** Stable, replay-safe fingerprint string. */
export function fingerprintCall(input: CallFingerprintInput): string {
	return stableHash({
		t: input.toolName,
		a: input.canonicalArgsHash,
		w: input.workspaceScope ?? "",
		r: input.runScope ?? "",
	});
}
