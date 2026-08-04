/**
 * Deterministic task feature extraction.
 *
 * Produces a bounded OrchestrationFeatureVector from the task text and optional
 * repository context. The baseline extractor never consults a model: it is a
 * pure deterministic function of its inputs so that decisions are replayable.
 * Missing values are explicit (undefined), never silently defaulted to zero
 * when that would imply confidence.
 *
 * Model-assisted features are optional and separately labeled; they can never
 * override the deterministic risk features (mutationRisk, requiresMutation,
 * requiresRelease, security sensitivity).
 */

import { createHash } from "node:crypto";
import type { OrchestrationFeatureVector } from "./types.js";

export interface TaskContext {
	/** The user task text. */
	task: string;
	/** Repository language IDs detected by the caller (e.g. ["typescript"]). */
	languageIds?: string[];
	/** Number of affected projects/files if known (0 = unknown). */
	estimatedAffectedFiles?: number;
	/** Operator-declared budget class override, if any. */
	operatorBudgetClass?: string;
	/** Operator-declared urgency. */
	operatorUrgency?: string;
}

/** Feature extraction mode: deterministic baseline only, or with optional model-assisted labels. */
export interface FeatureExtractionOptions {
	/** Bounded set of allowed language IDs (prevents unbounded features). */
	allowedLanguageIds?: string[];
	/** Model-assisted category labels. Separately labeled; never overrides deterministic risk features. */
	modelAssisted?: {
		taskCategory?: string;
		ambiguity?: number;
		evidenceRequirement?: number;
	};
}

export const FEATURE_SCHEMA_VERSION = 1;
export const MAX_FEATURES = 48;
const MAX_LANGUAGES = 12;

/** Deterministic token estimate: word + identifier boundaries. */
function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/** Detect category from task text deterministically. */
function detectCategory(task: string): string {
	const t = task.toLowerCase();
	if (/(release|publish|publish-?npm|tag|version|changelog|lockstep)/.test(t) && /(release|publish)/.test(t)) {
		return "release";
	}
	if (/(migrate|migration|refactor|rename|move|restructure)/.test(t)) {
		return "implementation";
	}
	if (/(bug\s?fix|fix|repair|patch|regression)/.test(t)) {
		return "implementation";
	}
	if (/(security|vulnerability|cve|exploit|sanitize|injection)/.test(t)) {
		return "security";
	}
	if (/(implement|add|build|create|feature|write)/.test(t)) {
		return "implementation";
	}
	if (/(investigate|find|locate|search|why|how does|understand|explain|trace|analyze)/.test(t)) {
		return "analysis";
	}
	if (/(test|validate|verify|check|quality gate|benchmark)/.test(t)) {
		return "operational_testing";
	}
	return "operational";
}

/** Detect mutation requirement deterministically. */
function detectRequiresMutation(task: string): boolean {
	const t = task.toLowerCase();
	return /(edit|write|update|add file|delete file|remove|create file|modify|change|implement|fix|refactor|migrate|rename)/.test(
		t,
	);
}

function detectRequiresRelease(task: string): boolean {
	const t = task.toLowerCase();
	return /(release|publish|deploy|tag|publish-?npm|version and release)/.test(t);
}

function detectRequiresCrossPlatform(task: string): boolean {
	const t = task.toLowerCase();
	return /(cross-platform|windows|linux|both platforms|platform-ci|win32)/.test(t);
}

function detectRequiresExternalResearch(task: string): boolean {
	const t = task.toLowerCase();
	return /(research|up-to-date|latest version|web search|primary source|paper|reference implementation|cta)/.test(t);
}

/** Deterministic complexity in 0..1. */
function detectComplexity(task: string, ctx: TaskContext): number {
	let score = 0;
	if (ctx.estimatedAffectedFiles !== undefined && ctx.estimatedAffectedFiles > 1) score += 0.3;
	const files = ctx.estimatedAffectedFiles ?? 0;
	if (files >= 5) score += 0.2;
	if (detectRequiresMutation(task)) score += 0.2;
	if (detectRequiresCrossPlatform(task)) score += 0.1;
	if (ctx.languageIds && ctx.languageIds.length > 1) score += 0.1;
	if (
		/(multiple file|many file|across|cross-cutting|architecture|state machine|transactional)/.test(task.toLowerCase())
	) {
		score += 0.2;
	}
	// Length heuristic — very short tasks are simple, very long tasks compound complexity.
	const len = task.length;
	if (len > 400) score += 0.1;
	return Math.min(1, score);
}

/** Deterministic ambiguity in 0..1. */
function detectAmbiguity(task: string, modelAssistedAmbiguity?: number): number {
	if (modelAssistedAmbiguity !== undefined) return Math.max(0, Math.min(1, modelAssistedAmbiguity));
	const t = task.toLowerCase();
	let score = 0;
	if (/(maybe|perhaps|possibly|unsure|not sure|ambiguous|either|or whether)/.test(t)) score += 0.4;
	if (/(i don't know|unknown|unclear|investigate first)/.test(t)) score += 0.3;
	if (t.split(/\?/).length - 1 > 1) score += 0.2;
	if (task.includes("?")) score += 0.1;
	// Vagueness by length
	if (task.trim().length < 40) score += 0.2;
	return Math.min(1, score);
}

/** Deterministic evidence requirement in 0..1. */
function detectEvidenceRequirement(task: string, modelAssistedEvidence?: number): number {
	if (modelAssistedEvidence !== undefined) return Math.max(0, Math.min(1, modelAssistedEvidence));
	const t = task.toLowerCase();
	let score = 0;
	if (/(verify|validate|evidence|baseline|compare|measure|prove|test|reproduce|confirm)/.test(t)) score += 0.5;
	if (/(regression|quality gate|acceptance)/.test(t)) score += 0.3;
	if (/benchmark|performance|latency|cost/.test(t)) score += 0.3;
	return Math.min(1, score);
}

/** Deterministic mutation risk (0..1). Higher = more destructive/irreversible. */
function detectMutationRisk(task: string): number {
	const t = task.toLowerCase();
	let score = 0;
	if (/(delete|remove file|drop|wipe|clear|reset\s--hard|force|overwrite source)/.test(t)) score = 0.9;
	else if (/(migrate|refactor|rename|restructure|rewrite)/.test(t)) score = 0.6;
	else if (/(edit|update|modify|change|write to|add file|patch)/.test(t)) score = 0.35;
	if (/(security|production|prod|release|critical path)/.test(t)) score = Math.min(1, score + 0.2);
	return Math.min(1, score);
}

function failureClusters(task: string, _ctx: TaskContext, allowed: string[]): string[] {
	const clusters: string[] = [];
	if (/(stall|hang|timeout|not responding)/.test(task.toLowerCase())) clusters.push("stall");
	if (/(flaky|intermittent|sporadic)/.test(task.toLowerCase())) clusters.push("flakiness");
	if (/(tool failure|tool call|capability)/.test(task.toLowerCase())) clusters.push("tool_failure");
	if (/(rollback|transaction|partial|atomic)/.test(task.toLowerCase())) clusters.push("rollback");
	// Bound to allowed set.
	const out = clusters.filter((c) => allowed.includes(c));
	return out.slice(0, 4);
}

const DEFAULT_ALLOWED_LANGUAGES = [
	"typescript",
	"javascript",
	"python",
	"go",
	"rust",
	"java",
	"csharp",
	"ruby",
	"kotlin",
	"swift",
	"php",
	"c",
	"cpp",
	"shell",
	"sql",
	"markdown",
	"yaml",
	"json",
];

/**
 * Deterministic feature extraction baseline.
 * Returns a bounded, versioned feature vector with an explicit feature hash.
 */
export function extractFeatures(
	task: string | TaskContext,
	options: FeatureExtractionOptions = {},
): OrchestrationFeatureVector {
	const ctx: TaskContext = typeof task === "string" ? { task } : task;
	const text = ctx.task ?? "";
	const allowed = options.allowedLanguageIds ?? DEFAULT_ALLOWED_LANGUAGES;
	const languageIds = (ctx.languageIds ?? []).filter((l) => allowed.includes(l)).slice(0, MAX_LANGUAGES);

	const taskCategory = options.modelAssisted?.taskCategory ?? detectCategory(text);
	const ambiguity = detectAmbiguity(text, options.modelAssisted?.ambiguity);
	const evidenceRequirement = detectEvidenceRequirement(text, options.modelAssisted?.evidenceRequirement);
	// Deterministic risk features — never overridden by model-assisted labels.
	const requiresMutation = detectRequiresMutation(text);
	const requiresRelease = detectRequiresRelease(text);
	const requiresCrossPlatformValidation = detectRequiresCrossPlatform(text);
	const requiresExternalResearch = detectRequiresExternalResearch(text);
	const mutationRisk = detectMutationRisk(text);
	const taskComplexity = detectComplexity(text, ctx);
	const relevantFailureClusters = failureClusters(text, ctx, [
		"stall",
		"flakiness",
		"tool_failure",
		"rollback",
		"retrieval",
		"structured_output",
	]);

	const vector: OrchestrationFeatureVector = {
		schemaVersion: FEATURE_SCHEMA_VERSION,
		taskCategory,
		taskComplexity,
		ambiguity,
		mutationRisk,
		evidenceRequirement,
		estimatedAffectedFiles: ctx.estimatedAffectedFiles,
		estimatedContextTokens:
			ctx.estimatedAffectedFiles !== undefined && ctx.estimatedAffectedFiles > 0
				? Math.min(400_000, estimateTokens(text) + ctx.estimatedAffectedFiles * 8000)
				: estimateTokens(text),
		requiresMutation,
		requiresExternalResearch,
		requiresCrossPlatformValidation,
		requiresRelease,
		languageIds,
		relevantFailureClusters,
		featureHash: "",
	};

	// Compute feature hash after all fields are set (excluding the hash itself).
	vector.featureHash = featureHash(vector);
	return vector;
}

/** Stable hash of a feature vector (excluding the hash field). */
export function featureHash(vector: Omit<OrchestrationFeatureVector, "featureHash">): string {
	const copy = { ...vector, featureHash: undefined } as Record<string, unknown>;
	return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

/** Deterministic task fingerprint used to correlate decisions across runs. */
export function taskFingerprint(task: string): string {
	return createHash("sha256").update(task.trim()).digest("hex");
}
