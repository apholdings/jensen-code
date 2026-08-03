import path from "node:path";
import type { ToolEffectScope, ToolEffects } from "@apholdings/jensen-agent-core";
import type { PolicyDecision, PolicyEvaluation, PolicyInput } from "./types.js";

/**
 * Deterministic policy engine.
 *
 * Precedence (highest to lowest): deny > require_approval > allow > default.
 * A deny rule can never be overridden by a lower-priority rule, model output,
 * web content, tool results, workspace instructions, or a provider hint. The
 * engine never reads model prose or tool output: policy truth comes only from
 * the structured PolicyInput.
 */

function precedence(outcome: PolicyDecision["outcome"]): number {
	switch (outcome) {
		case "deny":
			return 4;
		case "require_approval":
			return 3;
		case "allow":
			return 2;
		default:
			return 1;
	}
}

function isMutating(effects: ToolEffects): boolean {
	return (
		effects.writesWorkspace ||
		effects.deletesFiles ||
		effects.mutatesGit ||
		effects.mutatesExternalState ||
		effects.executesProcesses ||
		effects.startsPersistentProcesses
	);
}

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const SECRET_PATH_PATTERNS = [
	/\.pem$/i,
	/\.key$/i,
	/\.p12$/i,
	/\.pfx$/i,
	/\.keystore$/i,
	/(^|[\\/])id_rsa([^\\/]*)?$/,
	/(^|[\\/])id_ed25519([^\\/]*)?$/,
	/(^|[\\/])id_ecdsa([^\\/]*)?$/,
	/(^|[\\/])\.credentials$/i,
	/(^|[\\/])credentials\.json$/i,
	/(^|[\\/])\.env$/,
];

const POLICY_BYPASS_MARKERS = [
	"--no-verify",
	"--no-commit-verify",
	"JENSEN_SKIP_POLICY",
	"JENSEN_ALLOW_UNSAFE",
	"jensen-skip-policy",
	"--no-policy",
];

export function isSecretPath(p: string): boolean {
	return SECRET_PATH_PATTERNS.some((re) => re.test(p));
}

export interface PolicyRule {
	id: string;
	description: string;
	/** Return a decision if this rule applies, otherwise null. */
	evaluate(input: PolicyInput): PolicyDecision | null;
}

export interface PolicyEngineOptions {
	allowApprovalResolver?: (scope: string, input: PolicyInput) => boolean;
	ruleOverrides?: Partial<Record<string, boolean>>;
}

/**
 * Default (lowest precedence) decision derived from execution mode.
 * The model cannot promote itself between modes: mode is provided by the
 * caller from durable state.
 */
function defaultDecision(input: PolicyInput): PolicyDecision {
	const mutates = isMutating(input.effects);
	if (input.executionMode === "observe") {
		if (mutates || input.effects.accessesNetwork) {
			return {
				outcome: "deny",
				ruleId: "mode.observe",
				reasonCode: "observe_mode_blocks_mutation",
			};
		}
		return { outcome: "allow", ruleId: "mode.observe", reasonCode: "observe_read_allowed" };
	}
	if (input.executionMode === "plan") {
		if (mutates) {
			return {
				outcome: "require_approval",
				ruleId: "mode.plan",
				reasonCode: "plan_mode_blocks_mutation",
				approvalScope: "plan_execute_override",
			};
		}
		return { outcome: "allow", ruleId: "mode.plan", reasonCode: "plan_read_allowed" };
	}
	// execute
	if (!mutates) {
		return { outcome: "allow", ruleId: "mode.execute", reasonCode: "execute_read_allowed" };
	}
	// A mutating operation in execute mode is never auto-approved: it needs an
	// explicit allow rule or an explicit approval resolution.
	return {
		outcome: "require_approval",
		ruleId: "mode.execute",
		reasonCode: "execute_requires_authorization",
		approvalScope: "mutation",
	};
}

export const BASELINE_RULES: PolicyRule[] = [
	{
		id: "deny.destructive_shell",
		description: "Deny destructive shell patterns against unrelated or external work.",
		evaluate(input) {
			const cmd = input.requestedCommand ?? "";
			// rm -rf on root
			if (/\brm\s+(-{1,2}[rifd]*\s+)*[/~](\s|$)/.test(cmd) && /-rf/.test(cmd)) {
				return { outcome: "deny", ruleId: "deny.destructive_shell", reasonCode: "rm_rf_root" };
			}
			// git reset --hard
			if (/\bgit\s+reset\s+--hard\b/.test(cmd)) {
				return { outcome: "deny", ruleId: "deny.destructive_shell", reasonCode: "git_reset_hard" };
			}
			// git clean -fd
			if (/\bgit\s+clean\s+-[a-z]*f[a-z]*d\b/.test(cmd) || /\bgit\s+clean\s+-[a-z]*d[a-z]*f\b/.test(cmd)) {
				return {
					outcome: "require_approval",
					ruleId: "deny.destructive_shell",
					reasonCode: "git_clean_requires_scope",
					approvalScope: "git_clean_scoped",
				};
			}
			// git push --force to protected branch
			const forcePush = /\bgit\s+push\b[^&;]*\s--force(-with-lease)?\b/.test(cmd);
			const protectedBranch = PROTECTED_BRANCHES.has(input.currentBranch ?? "");
			if (forcePush && protectedBranch) {
				if (input.releaseAuthorized) return null;
				return {
					outcome: "deny",
					ruleId: "deny.destructive_shell",
					reasonCode: "force_push_protected_branch",
				};
			}
			// Explicit policy-bypass markers in a command are denied outright.
			if (POLICY_BYPASS_MARKERS.some((m) => cmd.includes(m))) {
				return {
					outcome: "deny",
					ruleId: "deny.destructive_shell",
					reasonCode: "policy_bypass_marker",
				};
			}
			return null;
		},
	},
	{
		id: "deny.paths_outside_workspace",
		description: "Deny targets resolved outside the authorized workspace.",
		evaluate(input) {
			if (!input.resolvedPaths?.length) return null;
			for (const p of input.resolvedPaths) {
				// Marker produced by the boundary validator for escapes.
				if (p.includes("\u0000")) {
					return { outcome: "deny", ruleId: "deny.paths_outside_workspace", reasonCode: "escaped_path" };
				}
			}
			return null;
		},
	},
	{
		id: "deny.secrets",
		description: "Deny reading or publishing private key material.",
		evaluate(input) {
			const targets = input.resolvedPaths ?? [input.requestedCommand ?? ""];
			const secret = targets.some((t) => isSecretPath(t));
			if (secret) {
				return { outcome: "deny", ruleId: "deny.secrets", reasonCode: "secret_material" };
			}
			return null;
		},
	},
	{
		id: "allow.authorized_release",
		description: "Publication is allowed only under explicit release authorization.",
		evaluate(input) {
			if (!input.releaseAuthorized) return null;
			if (input.releaseAuthorized && (input.effects.mutatesExternalState || input.effects.mutatesGit)) {
				return { outcome: "allow", ruleId: "allow.authorized_release", reasonCode: "release_authorized" };
			}
			return null;
		},
	},
	{
		id: "deny.unknown_effects",
		description: "Dynamic or unknown-effect tools fail conservative validation.",
		evaluate(input) {
			const hasUnknown = (input.effects.scopes ?? []).some((s: ToolEffectScope) => s.kind === "unknown");
			if (hasUnknown) {
				return {
					outcome: "require_approval",
					ruleId: "deny.unknown_effects",
					reasonCode: "unknown_effects_conservative",
					approvalScope: "unknown_effects",
				};
			}
			return null;
		},
	},
];

export class PolicyEngine {
	private readonly rules: PolicyRule[];
	private readonly options: PolicyEngineOptions;

	constructor(rules: PolicyRule[] = BASELINE_RULES, options: PolicyEngineOptions = {}) {
		this.rules = rules.filter((r) => options.ruleOverrides?.[r.id] !== false);
		this.options = options;
	}

	/** Evaluate the policy for a single tool invocation. Deterministic. */
	evaluate(input: PolicyInput): PolicyEvaluation {
		let best: PolicyDecision | null = null;
		for (const rule of this.rules) {
			let decision: PolicyDecision | null = null;
			try {
				decision = rule.evaluate(input);
			} catch {
				// A throwing rule is a policy failure: deny conservatively.
				decision = { outcome: "deny", ruleId: rule.id, reasonCode: "policy_rule_error" };
			}
			if (!decision) continue;
			const p = precedence(decision.outcome);
			if (!best || p > precedence(best.outcome)) {
				best = decision;
			}
		}
		if (!best) {
			best = defaultDecision(input);
		}
		return { decision: best, key: input.workspaceId };
	}

	/** Structured allow when the caller has resolved an approval for a scope. */
	approve(input: PolicyInput, scope: string): PolicyEvaluation {
		const resolver = this.options.allowApprovalResolver;
		const allowed = resolver ? resolver(scope, input) : true;
		if (!allowed) {
			return {
				decision: { outcome: "deny", ruleId: "approval", reasonCode: "approval_rejected" },
				key: input.workspaceId,
			};
		}
		return {
			decision: { outcome: "allow", ruleId: "approval", reasonCode: "approval_granted" },
			key: input.workspaceId,
		};
	}
}

/** Derive a workspace id from the canonical workspace root. */
export function workspaceIdFromRoot(root: string): string {
	return path
		.resolve(root)
		.replace(/[\\/]+/g, "/")
		.toLowerCase();
}
