/**
 * Built-in typed skills (1.5.0).
 *
 * A small, bounded set of useful example skills. They are deliberately mostly
 * read-only ("observe" mode), declare allowed tools and denied effects, carry a
 * budget, and declare success criteria. They are data/configuration, not code:
 * effective permissions are the intersection of user authorization, parent
 * policy, the skill allowlist, and the execution mode. A skill can never
 * authorize publication.
 */

import type { SkillManifest } from "./types.js";

export interface BuiltinSkill extends SkillManifest {}

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = Object.freeze([
	{
		name: "repository-audit",
		version: 1,
		description: "Audit a repository against defined criteria.",
		inputs: [{ name: "workspace", type: "workspace" }],
		allowedTools: ["read_file", "grep", "find"],
		deniedEffects: ["writesWorkspace", "mutatesGit"],
		executionMode: "observe",
		budget: { maxModelTurns: 5, maxToolCalls: 30 },
		timeoutMs: 120_000,
		successCriteria: ["Produce an evidence-backed audit report."],
		outputSchema: "RepositoryAuditResult",
		modelRole: "subagent",
		provenance: "builtin",
		requiredCapabilities: [],
	},
	{
		name: "focused-test-analysis",
		version: 1,
		description: "Analyze a focused failing test against known artifacts.",
		inputs: [{ name: "testFile", type: "path" }],
		allowedTools: ["read_file", "grep", "git_status", "git_log"],
		deniedEffects: ["writesWorkspace", "mutatesGit"],
		executionMode: "observe",
		budget: { maxModelTurns: 5, maxToolCalls: 40 },
		timeoutMs: 120_000,
		successCriteria: ["Classify the failure with evidence-backed attribution."],
		outputSchema: "TestFailureAnalysis",
		modelRole: "subagent",
		provenance: "builtin",
		requiredCapabilities: [],
	},
	{
		name: "release-readiness-review",
		version: 1,
		description: "Independently review release readiness against criteria.",
		inputs: [{ name: "criteria", type: "criteria[]" }],
		allowedTools: ["read_file", "grep", "git_status", "git_diff", "git_log"],
		deniedEffects: ["writesWorkspace", "mutatesGit", "publishes"],
		executionMode: "observe",
		budget: { maxModelTurns: 8, maxToolCalls: 60 },
		timeoutMs: 180_000,
		successCriteria: ["Return structured readiness findings against each criterion."],
		outputSchema: "ReleaseReadinessReview",
		modelRole: "reviewer",
		provenance: "builtin",
		requiredCapabilities: ["supportsCodeReview"],
	},
	{
		name: "web-research-brief",
		version: 1,
		description: "Produce a cited research brief bounded by a child budget.",
		inputs: [{ name: "topic", type: "string" }],
		allowedTools: ["web_search", "web_fetch"],
		deniedEffects: ["writesWorkspace", "mutatesGit"],
		executionMode: "observe",
		budget: { maxWebSearches: 8, maxWebFetches: 12, maxModelTurns: 6 },
		timeoutMs: 180_000,
		successCriteria: ["Return addressable citations for each claim."],
		outputSchema: "ResearchBrief",
		modelRole: "subagent",
		provenance: "builtin",
		requiredCapabilities: ["supportsResearchSynthesis"],
	},
	{
		name: "failure-log-summary",
		version: 1,
		description: "Summarize a bounded failure log into structured findings.",
		inputs: [{ name: "log", type: "path" }],
		allowedTools: ["read_file", "grep"],
		deniedEffects: ["writesWorkspace", "mutatesGit"],
		executionMode: "observe",
		budget: { maxModelTurns: 4, maxToolCalls: 20 },
		timeoutMs: 90_000,
		successCriteria: ["Produce a structured failure summary with signal counts."],
		outputSchema: "FailureLogSummary",
		modelRole: "subagent",
		provenance: "builtin",
		requiredCapabilities: [],
	},
]);
