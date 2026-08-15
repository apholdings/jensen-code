/**
 * Context Governor (Long-Horizon Context Virtualization, 2.5.0; production
 * hardening 2.6.0).
 *
 * First-class preflight enforcement of the safe input budget. Before a provider
 * is invoked, the candidate assembly (system prompt + tools + dynamic prompt +
 * messages) is conservatively counted and reduced until it fits — or a
 * structured unrecoverable condition is returned with region diagnostics.
 *
 * Reduction is deterministic and LLM-free (it runs BEFORE the model call, so it
 * cannot depend on another model call):
 *   1. Re-apply the durable virtualization ledger (already-archived tool
 *      results are restored to their virtualized representation, never the raw
 *      payload).
 *   2. Virtualize oversized/older tool results into the cold evidence archive
 *      (retaining a synopsis + durable evidence reference).
 *   3. Roll the context over: retire the historical transcript and replace the
 *      prefix with a bounded mission-context-checkpoint preamble + recent tail.
 *   4. Trim the recent tail deterministically (bounded iterations, pinned state
 *      never evicted).
 *
 * The governor never invents mission state: the checkpoint is an operational
 * projection, and completion authority stays with the Reliability Kernel.
 */

import type { AgentMessage } from "@apholdings/jensen-agent-core";
import type { ToolResultMessage } from "@apholdings/jensen-ai";
import {
	type ContextCapability,
	computeSafeInputBudget,
	contextPressureRatio,
	exceedsSafeInputBudget,
} from "./context-capability.js";
import {
	type ContextAssembly,
	estimateAssemblyInputTokens,
	estimateContextRegionCosts,
	estimateMessageTokensFor,
	type TokenAccountingMode,
} from "./context-token.js";
import type { EvidenceArchive } from "./evidence-archive.js";
import { buildEvidenceRecord } from "./evidence-archive.js";
import {
	checkpointToRehydrationPreamble,
	type EvidenceReference,
	type MissionContextCheckpoint,
} from "./mission-checkpoint.js";
import { MAX_CALIBRATED_MULTIPLIER, resolveAccountingMode } from "./token-accounting.js";

export type GovernorAction = "pass" | "virtualized" | "rollover" | "compacted" | "unrecoverable";

export interface ContextGovernorDiagnostics {
	action: GovernorAction;
	capability: ContextCapability;
	iterations: number;
	inputTokensBefore: number;
	inputTokensAfter: number;
	pressureRatioBefore: number;
	pressureRatioAfter: number;
	toolResultsArchived: number;
	/** Tool results restored to a virtualized form from the durable ledger. */
	toolResultsRevirtualized: number;
	messagesEvicted: number;
	tokensEvicted: number;
	rolloverOccurred: boolean;
	checkpointRevision?: number;
	evidenceIdsArchived: string[];
	reducedRegions: string[];
	unrecoverableReason?: string;
	/** Fixed prefix (system + tools + dynamic prompt) token cost. */
	fixedPrefixTokens: number;
	/** Current token accounting mode. */
	tokenAccountingMode: TokenAccountingMode;
	recoveryIteration: number;
}

export interface ContextGovernorResult {
	assembly: ContextAssembly;
	diagnostics: ContextGovernorDiagnostics;
}

export interface ContextGovernorOptions {
	capability: ContextCapability;
	archive: EvidenceArchive;
	/** Supplies the current durable mission checkpoint for rollover rehydration. */
	checkpointProvider?: () => MissionContextCheckpoint | undefined;
	/** When present, resolves the capability per call (model may change at runtime). */
	capabilityProvider?: () => ContextCapability;
	maxIterations?: number;
	/** Recent-token tail kept hot across a rollover. */
	keepRecentTokens?: number;
	/** Tool results at/above this cost are candidates for virtualization. */
	toolResultVirtualizeThreshold?: number;
	/** Minimum number of messages always retained (never evicted below this). */
	minRetainedMessages?: number;
	now?: () => number;
	/** Durable virtualization ledger source (e.g., the current session). */
	virtualizationProvider?: () => ToolVirtualizationRecord[];
	/** Durable virtualization ledger sink (persists the full snapshot). */
	virtualizationSink?: (records: ToolVirtualizationRecord[]) => void;
	/** Initial virtualization records to seed the ledger (session resume). */
	initialVirtualizations?: ToolVirtualizationRecord[];
	/** Initial evidence references to seed the archive map (session resume). */
	initialEvidenceRefs?: EvidenceReference[];
}

const DEFAULT_MAX_ITERATIONS = 8;
// The recent hot tail kept across a rollover must be a fraction of the safe
// input budget, never the whole conversation. A fixed 20000-token tail made
// rollover/trim no-ops on small windows because it retained every message.
const DEFAULT_KEEP_RECENT_RATIO = 0.3;
const MIN_KEEP_RECENT_TOKENS = 1024;
const DEFAULT_TOOL_RESULT_VIRTUALIZE_THRESHOLD = 768;
const DEFAULT_MIN_RETAINED_MESSAGES = 4;
const TOOL_RESULT_SYNOPSIS_CHARS = 400;

const CHECKPOINT_CUSTOM_TYPE = "mission_context_checkpoint";

/** Bounded adaptive safety reserve ceiling (fraction of configured window). */
const MAX_ADAPTIVE_SAFETY_RATIO = 0.25;
/** Per-overflow adaptive safety step. */
const ADAPTIVE_SAFETY_STEP = 512;

/** Durable virtualization provenance: which tool result maps to which cold evidence. */
export interface ToolVirtualizationRecord {
	toolCallId: string;
	evidenceId: string;
	contentHash: string;
	source: string;
	synopsis: string;
	contentBytes: number;
	virtualizedAtMs: number;
}

/** Structured context captured when a provider rejects a request for size. */
export interface ProviderOverflowContext {
	configuredContextWindow: number;
	estimatedInputTokens: number;
	reservedOutputTokens: number;
	safetyReserveTokens: number;
	accountingMode: TokenAccountingMode;
	providerError?: string;
	/** Provider-reported input token count when available. */
	observedInputTokens?: number;
	/** Provider-reported maximum context when available. */
	observedContextWindow?: number;
}

/** Opt-in telemetry surface (metadata only; never prompt content). */
export interface ContextGovernorTelemetry {
	tokenAccountingMode: TokenAccountingMode;
	estimatedInputTokens: number;
	providerObservedInputTokens?: number;
	estimationError?: number;
	estimationErrorRatio?: number;
	configuredContextWindow: number;
	baseSafeInputBudget: number;
	effectiveSafeInputBudget: number;
	reservedOutputTokens: number;
	safetyReserveTokens: number;
	overflowCount: number;
	providerOverflowCount: number;
	forcedReductionCount: number;
	rolloverCount: number;
	archivedEvidenceCount: number;
	reusedEvidenceCount: number;
	duplicateArchiveAvoidedCount: number;
	fixedPrefixTokens: number;
	messageTokens: number;
	toolSchemaTokens: number;
	recoveryIteration: number;
	adaptiveSafetyReserveTokens: number;
	calibratedMultiplier: number;
	calibrationSamples: number;
}

/** Estimate the token cost of a single tool result's text content. */
function toolResultTextTokens(message: ToolResultMessage): number {
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "text" && block.text) chars += block.text.length;
		else if (block.type === "image") chars += 4800;
	}
	return Math.ceil(chars / 4);
}

function toolResultText(message: ToolResultMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function synopsisFor(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= TOOL_RESULT_SYNOPSIS_CHARS) return normalized;
	return `${normalized.slice(0, TOOL_RESULT_SYNOPSIS_CHARS)}…`;
}

function makeCheckpointMessage(checkpoint: MissionContextCheckpoint): AgentMessage {
	return {
		role: "custom",
		customType: CHECKPOINT_CUSTOM_TYPE,
		content: checkpointToRehydrationPreamble(checkpoint),
		display: false,
		details: { missionId: checkpoint.missionId, revision: checkpoint.revision, pinned: true },
		timestamp: checkpoint.updatedAtMs,
	} as AgentMessage;
}

/** Return the originating archive id when a tool result came from retrieve_evidence. */
function getEvidenceSourceId(message: ToolResultMessage): string | undefined {
	const details = (message as { details?: unknown }).details;
	if (typeof details === "object" && details !== null) {
		const id = (details as Record<string, unknown>).__evidenceSourceId;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	}
	return undefined;
}

/** True when a message is already in the virtualized representation. */
function isAlreadyVirtualized(message: ToolResultMessage): boolean {
	const details = (message as { details?: unknown }).details;
	if (typeof details === "object" && details !== null) {
		const id = (details as Record<string, unknown>).__virtualizedEvidenceId;
		return typeof id === "string" && id.length > 0;
	}
	return false;
}

function isPinnedMessage(message: AgentMessage): boolean {
	if ((message as { customType?: string }).customType === CHECKPOINT_CUSTOM_TYPE) return true;
	const details = (message as { details?: unknown }).details;
	if (typeof details === "object" && details !== null) {
		return (details as Record<string, unknown>).pinned === true;
	}
	return false;
}

function virtualizedText(source: string, synopsis: string, evidenceId: string, collapsed: boolean): string {
	if (collapsed) {
		return `[evidence retrieval collapsed] ${source} — synopsis: ${synopsis}\n<evidence ref="${evidenceId}"/>`;
	}
	return `[tool result virtualized] ${source}. Synopsis: ${synopsis}\n<evidence ref="${evidenceId}"/>`;
}

function applyVirtualizedForm(
	result: ToolResultMessage,
	evidenceId: string,
	synopsis: string,
	contentBytes: number,
	collapsed: boolean,
): ToolResultMessage {
	return {
		...result,
		content: [{ type: "text", text: virtualizedText(result.toolName, synopsis, evidenceId, collapsed) }],
		details: {
			...(typeof result.details === "object" && result.details !== null ? result.details : {}),
			__virtualizedEvidenceId: evidenceId,
			__virtualizedContentBytes: contentBytes,
		},
	} as ToolResultMessage;
}

/** Find a safe front cut index: the suffix must not start with a toolResult. */
function findSafeCutIndex(messages: AgentMessage[], maxSuffixTokens: number): number {
	let accumulated = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		const cost = estimateMessageTokensFor([message]);
		accumulated += cost;

		if (accumulated > maxSuffixTokens) {
			// The next candidate start is i+1, but only if it isn't a toolResult.
			let start = i + 1;
			while (start < messages.length && messages[start]!.role === "toolResult") {
				start += 1;
			}
			return start;
		}

		if (i === 0) return 0;
	}
	return messages.length;
}

function buildRecentTail(messages: AgentMessage[], keepRecentTokens: number): AgentMessage[] {
	if (messages.length === 0) return [];
	const cut = findSafeCutIndex(messages, keepRecentTokens);
	return messages.slice(cut);
}

export class ContextGovernor {
	private readonly _options: Required<
		Pick<
			ContextGovernorOptions,
			| "capability"
			| "archive"
			| "maxIterations"
			| "keepRecentTokens"
			| "toolResultVirtualizeThreshold"
			| "minRetainedMessages"
		>
	> & {
		checkpointProvider?: ContextGovernorOptions["checkpointProvider"];
		capabilityProvider?: ContextGovernorOptions["capabilityProvider"];
		virtualizationProvider?: ContextGovernorOptions["virtualizationProvider"];
		virtualizationSink?: ContextGovernorOptions["virtualizationSink"];
		now: () => number;
	};

	/** Durable virtualization ledger: toolCallId -> cold evidence record. */
	private readonly _virtualizations = new Map<string, ToolVirtualizationRecord>();

	/** Cumulative evidence refs (id -> short summary) archived during this governor's lifetime. */
	private readonly _archivedEvidenceRefs = new Map<string, string>();

	/** Optional sink notified when cumulative evidence refs change (durable persistence). */
	private _evidenceRefsSink?: (refs: EvidenceReference[]) => void;

	/** Total provider overflow disagreements recorded. */
	private _overflowCount = 0;

	/** Provider overflow disagreements specifically (subset of _overflowCount). */
	private _providerOverflowCount = 0;

	/** Number of forced reductions (adaptive safety applied). */
	private _forcedReductionCount = 0;

	/** Number of rollovers performed across this governor's lifetime. */
	private _rolloverCount = 0;

	/** Number of times an existing cold evidence id was reused (no duplicate write). */
	private _reusedEvidenceCount = 0;

	/** Number of duplicate archive writes avoided. */
	private _duplicateArchiveAvoidedCount = 0;

	/** Cumulative adaptive safety reserve tokens (bounded). */
	private _adaptiveSafetyReserveTokens = 0;

	/** Calibrated conservative multiplier from provider usage (>= 1). */
	private _calibratedMultiplier: number | undefined;

	/** Number of provider usage observations used for calibration. */
	private _calibrationSamples = 0;

	/** Last observed provider usage (estimated vs observed). */
	private _lastUsageObservation: { estimated: number; observed: number } | undefined;

	/** Most recent governance diagnostics (telemetry surface). */
	private _lastDiagnostics: ContextGovernorDiagnostics | undefined;

	/** Most recent structured overflow context. */
	private _lastOverflowContext: ProviderOverflowContext | undefined;

	/** Most recent region cost breakdown (telemetry). */
	private _lastRegionCosts: { fixedPrefixTokens: number; messageTokens: number; toolSchemaTokens: number } | undefined;

	/** Most recent governance diagnostics (telemetry surface). */
	get lastDiagnostics(): ContextGovernorDiagnostics | undefined {
		return this._lastDiagnostics;
	}

	/** Number of provider overflow disagreements recorded. */
	get overflowCount(): number {
		return this._overflowCount;
	}

	/** Number of provider-reported context overflow events. */
	get providerOverflowCount(): number {
		return this._providerOverflowCount;
	}

	/** Most recent structured provider overflow context, if any. */
	get lastOverflowContext(): ProviderOverflowContext | undefined {
		return this._lastOverflowContext;
	}

	getTokenAccountingMode(): TokenAccountingMode {
		return resolveAccountingMode(this._calibratedMultiplier);
	}

	/**
	 * Cumulative evidence references archived during this governor's lifetime.
	 * Used to persist references into the durable mission checkpoint so they
	 * survive a rollover without embedding the raw artifact.
	 */
	getArchivedEvidenceRefs(): { evidenceId: string; summary: string }[] {
		return [...this._archivedEvidenceRefs].map(([evidenceId, summary]) => ({ evidenceId, summary }));
	}

	/** Current durable virtualization ledger snapshot. */
	getVirtualizations(): ToolVirtualizationRecord[] {
		return [...this._virtualizations.values()].sort((a, b) => a.virtualizedAtMs - b.virtualizedAtMs);
	}

	constructor(options: ContextGovernorOptions) {
		this._options = {
			capability: options.capability,
			archive: options.archive,
			checkpointProvider: options.checkpointProvider,
			capabilityProvider: options.capabilityProvider,
			virtualizationProvider: options.virtualizationProvider,
			virtualizationSink: options.virtualizationSink,
			maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			keepRecentTokens:
				options.keepRecentTokens ??
				Math.max(
					MIN_KEEP_RECENT_TOKENS,
					Math.floor(options.capability.safeInputBudget * DEFAULT_KEEP_RECENT_RATIO),
				),
			toolResultVirtualizeThreshold:
				options.toolResultVirtualizeThreshold ?? DEFAULT_TOOL_RESULT_VIRTUALIZE_THRESHOLD,
			minRetainedMessages: options.minRetainedMessages ?? DEFAULT_MIN_RETAINED_MESSAGES,
			now: options.now ?? Date.now,
		};

		for (const record of options.initialVirtualizations ?? []) {
			this._virtualizations.set(record.toolCallId, record);
		}
		for (const ref of options.initialEvidenceRefs ?? []) {
			if (!this._archivedEvidenceRefs.has(ref.evidenceId)) {
				this._archivedEvidenceRefs.set(ref.evidenceId, ref.summary);
			}
		}
	}

	/** Update the checkpoint provider (set after the session builds it). */
	setCheckpointProvider(provider: ContextGovernorOptions["checkpointProvider"]): void {
		this._options.checkpointProvider = provider;
	}

	/**
	 * Attach a durable sink for archived evidence references. Invoked whenever
	 * new cold evidence is archived so references can survive process death and
	 * be restored on explicit child resume.
	 */
	setEvidenceRefsSink(sink: (refs: EvidenceReference[]) => void): void {
		this._evidenceRefsSink = sink;
	}

	private _emitEvidenceRefs(): void {
		if (!this._evidenceRefsSink) return;
		this._evidenceRefsSink(this.getArchivedEvidenceRefs());
	}

	/** Update the capability provider (for runtime model switches). */
	setCapabilityProvider(provider: ContextGovernorOptions["capabilityProvider"]): void {
		this._options.capabilityProvider = provider;
	}

	/**
	 * Refresh the durable virtualization ledger from the persistence source
	 * (e.g., after a session resume where a new session snapshot was loaded).
	 */
	private _refreshVirtualizations(): void {
		const records = this._options.virtualizationProvider?.() ?? [];
		for (const record of records) {
			const existing = this._virtualizations.get(record.toolCallId);
			if (existing && existing.virtualizedAtMs >= record.virtualizedAtMs) continue;
			this._virtualizations.set(record.toolCallId, record);
			if (!this._archivedEvidenceRefs.has(record.evidenceId)) {
				this._archivedEvidenceRefs.set(record.evidenceId, record.synopsis.slice(0, 120));
			}
		}
	}

	private _persistVirtualizations(): void {
		this._options.virtualizationSink?.(this.getVirtualizations());
	}

	/**
	 * Record a provider context-overflow disagreement. Subsequent `govern` calls
	 * apply a progressively stricter budget (bounded) so a tokenizer mismatch
	 * forces stronger deterministic reduction instead of looping.
	 */
	recordOverflow(context?: ProviderOverflowContext): void {
		this._overflowCount += 1;
		this._providerOverflowCount += 1;
		this._forcedReductionCount += 1;

		if (context) {
			this._lastOverflowContext = context;
			if (context.observedInputTokens && context.estimatedInputTokens > 0) {
				const ratio = context.observedInputTokens / context.estimatedInputTokens;
				this._applyCalibrationRatio(ratio);
			}
		}

		// Adaptive safety: reserve more headroom after authoritative disagreement.
		const step = Math.max(
			256,
			Math.min(ADAPTIVE_SAFETY_STEP, Math.floor(this._options.capability.safetyReserveTokens * 0.5)),
		);
		this._adaptiveSafetyReserveTokens = Math.min(
			Math.floor(this._options.capability.configuredContextWindow * MAX_ADAPTIVE_SAFETY_RATIO),
			this._adaptiveSafetyReserveTokens + step,
		);
	}

	/**
	 * Feed an authoritative provider usage observation into deterministic
	 * calibration. Only ever biases the estimator MORE conservative (never less).
	 */
	observeProviderUsage(estimatedInputTokens: number, observedInputTokens: number): void {
		if (estimatedInputTokens <= 0 || observedInputTokens <= 0) return;
		this._calibrationSamples += 1;
		this._lastUsageObservation = { estimated: estimatedInputTokens, observed: observedInputTokens };
		const ratio = observedInputTokens / estimatedInputTokens;
		this._applyCalibrationRatio(ratio);
	}

	private _applyCalibrationRatio(ratio: number): void {
		if (ratio <= 1) return;
		this._calibratedMultiplier = Math.min(
			MAX_CALIBRATED_MULTIPLIER,
			Math.max(this._calibratedMultiplier ?? 1, ratio),
		);
	}

	private _deriveAdaptiveCapability(base: ContextCapability): ContextCapability {
		if (this._adaptiveSafetyReserveTokens <= 0) return base;
		const safetyReserveTokens = Math.min(
			base.safetyReserveTokens + this._adaptiveSafetyReserveTokens,
			Math.floor(base.configuredContextWindow * 0.4),
		);
		if (safetyReserveTokens <= base.safetyReserveTokens) return base;
		const safeInputBudget = computeSafeInputBudget(
			base.configuredContextWindow,
			base.reservedOutputTokens,
			safetyReserveTokens,
			256,
		);
		const softPressureRatio = base.safeInputBudget > 0 ? base.softPressureThreshold / base.safeInputBudget : 0.8;
		return {
			...base,
			safetyReserveTokens,
			safeInputBudget,
			softPressureThreshold: Math.floor(safeInputBudget * softPressureRatio),
		};
	}

	private _accounting(): { calibratedMultiplier?: number } {
		return { calibratedMultiplier: this._calibratedMultiplier };
	}

	/**
	 * Preflight-reduce an assembly to satisfy the safe input budget.
	 *
	 * @returns the reduced assembly plus diagnostics. When `action` is
	 * "unrecoverable", the caller must NOT send the request.
	 */
	async govern(assembly: ContextAssembly): Promise<ContextGovernorResult> {
		this._refreshVirtualizations();
		const baseCapability = this._options.capabilityProvider?.() ?? this._options.capability;
		const capability = this._deriveAdaptiveCapability(baseCapability);
		const accounting = this._accounting();
		const accountingMode = this.getTokenAccountingMode();

		const inputTokensBefore = estimateAssemblyInputTokens(assembly, accounting);
		const pressureRatioBefore = contextPressureRatio(capability, inputTokensBefore);
		const regionCosts = estimateContextRegionCosts(assembly, accounting);
		this._lastRegionCosts = {
			fixedPrefixTokens: regionCosts.fixedPrefixTokens,
			messageTokens: regionCosts.messageTokens,
			toolSchemaTokens: regionCosts.toolSchemaTokens,
		};

		// Phase 0: restore any tool result that the durable ledger has already
		// virtualized. This is what keeps raw payloads from reappearing on the
		// next request / process restart / session resume.
		const revirtualized = this._applyPersistedVirtualizations(assembly);
		let current = revirtualized.assembly;
		let inputTokens = estimateAssemblyInputTokens(current, accounting);
		const toolResultsRevirtualized = revirtualized.count;

		const evidenceIdsArchived: string[] = [];
		const reducedRegions: string[] = [];
		if (toolResultsRevirtualized > 0) reducedRegions.push("virtualization-restore");

		const baseDiagnostics: ContextGovernorDiagnostics = {
			action: "pass",
			capability,
			iterations: 0,
			inputTokensBefore,
			inputTokensAfter: inputTokens,
			pressureRatioBefore,
			pressureRatioAfter: contextPressureRatio(capability, inputTokens),
			toolResultsArchived: 0,
			toolResultsRevirtualized,
			messagesEvicted: 0,
			tokensEvicted: 0,
			rolloverOccurred: false,
			evidenceIdsArchived: [],
			reducedRegions: [],
			fixedPrefixTokens: regionCosts.fixedPrefixTokens,
			tokenAccountingMode: accountingMode,
			recoveryIteration: this._overflowCount,
		};

		// Phase 1: proactively virtualize oversized tool results regardless of
		// overall pressure. A single huge raw result must never live forever in
		// the hot working set even when the window still has headroom.
		const proactive = await this._virtualizeToolResults(current, false);
		const proactiveChanged = proactive.changed;
		if (proactiveChanged) {
			current = proactive.assembly;
			for (const id of proactive.archivedIds) evidenceIdsArchived.push(id);
			reducedRegions.push("tool-result-virtualization");
			inputTokens = estimateAssemblyInputTokens(current, accounting);
		}

		// Below soft pressure and nothing was virtualized: no further action.
		if (inputTokens <= capability.softPressureThreshold && !proactiveChanged && toolResultsRevirtualized === 0) {
			this._lastDiagnostics = baseDiagnostics;
			return { assembly, diagnostics: baseDiagnostics };
		}

		// Below soft pressure but virtualization ran (archive or identity reuse): report it.
		if (inputTokens <= capability.softPressureThreshold) {
			const diagnostics: ContextGovernorDiagnostics = {
				...baseDiagnostics,
				action: "virtualized",
				inputTokensAfter: inputTokens,
				pressureRatioAfter: contextPressureRatio(capability, inputTokens),
				toolResultsArchived: evidenceIdsArchived.length,
				tokensEvicted: Math.max(0, inputTokensBefore - inputTokens),
				evidenceIdsArchived,
				reducedRegions: [...new Set(reducedRegions)],
			};
			this._lastDiagnostics = diagnostics;
			return { assembly: current, diagnostics };
		}

		let rolloverOccurred = false;
		let rolloverDone = false;
		let checkpointRevision: number | undefined;
		let iterations = 0;

		for (let iteration = 1; iteration <= this._options.maxIterations; iteration++) {
			iterations = iteration;
			if (!exceedsSafeInputBudget(capability, inputTokens)) {
				break;
			}

			// Step 1: virtualize oversized/older tool results.
			const virtualized = await this._virtualizeToolResults(current, true);
			if (virtualized.changed) {
				current = virtualized.assembly;
				for (const id of virtualized.archivedIds) evidenceIdsArchived.push(id);
				reducedRegions.push("tool-result-virtualization");
				inputTokens = estimateAssemblyInputTokens(current, accounting);
				continue;
			}

			// Step 2: rollover via mission checkpoint (once).
			if (!rolloverDone) {
				let checkpoint: MissionContextCheckpoint | undefined;
				try {
					checkpoint = this._options.checkpointProvider?.();
				} catch {
					// A corrupt/unreadable checkpoint must never fabricate state; fall
					// back to deterministic trimming only.
					checkpoint = undefined;
				}
				if (checkpoint) {
					const rehydrated = this._rollover(current, checkpoint);
					if (rehydrated) {
						current = rehydrated.assembly;
						inputTokens = estimateAssemblyInputTokens(current, accounting);
						rolloverOccurred = true;
						rolloverDone = true;
						this._rolloverCount += 1;
						checkpointRevision = checkpoint.revision;
						reducedRegions.push("checkpoint-rollover");
						continue;
					}
				}
				rolloverDone = true;
			}

			// Step 3: deterministic tail trim (evict oldest non-pinned messages).
			const trimmed = this._trimTail(current);
			if (trimmed.changed) {
				current = trimmed.assembly;
				inputTokens = estimateAssemblyInputTokens(current, accounting);
				reducedRegions.push("tail-trim");
				continue;
			}

			// No progress possible: structured unrecoverable.
			break;
		}

		const inputTokensAfter = estimateAssemblyInputTokens(current, accounting);
		const stillOver = exceedsSafeInputBudget(capability, inputTokensAfter);
		const tokensEvicted = Math.max(0, inputTokensBefore - inputTokensAfter);

		let action: GovernorAction;
		if (stillOver) {
			action = "unrecoverable";
		} else if (rolloverOccurred) {
			action = "rollover";
		} else if (evidenceIdsArchived.length > 0 || toolResultsRevirtualized > 0 || proactiveChanged) {
			action = "virtualized";
		} else if (this._countEvicted(assembly, current) > 0) {
			action = "compacted";
		} else {
			action = "pass";
		}

		const diagnostics: ContextGovernorDiagnostics = {
			...baseDiagnostics,
			action,
			iterations,
			inputTokensAfter,
			pressureRatioAfter: contextPressureRatio(capability, inputTokensAfter),
			toolResultsArchived: evidenceIdsArchived.length,
			messagesEvicted: this._countEvicted(assembly, current),
			tokensEvicted,
			rolloverOccurred,
			checkpointRevision,
			evidenceIdsArchived,
			reducedRegions: [...new Set(reducedRegions)],
			unrecoverableReason: stillOver ? this._unrecoverableReason(current, accounting) : undefined,
		};

		this._lastDiagnostics = diagnostics;
		return { assembly: current, diagnostics };
	}

	private _countEvicted(before: ContextAssembly, after: ContextAssembly): number {
		return Math.max(0, before.messages.length - after.messages.length);
	}

	/**
	 * Restore the virtualized representation for any tool result present in the
	 * durable ledger. Returns a new assembly (message objects are NOT mutated so
	 * the caller's durable state is preserved) and the count of restored results.
	 */
	private _applyPersistedVirtualizations(assembly: ContextAssembly): {
		assembly: ContextAssembly;
		count: number;
	} {
		if (this._virtualizations.size === 0) return { assembly, count: 0 };
		let count = 0;
		const messages = assembly.messages.map((message) => {
			if (message.role !== "toolResult") return message;
			const result = message as ToolResultMessage;
			if (isAlreadyVirtualized(result)) return message;
			const record = this._virtualizations.get(result.toolCallId);
			if (!record) return message;
			count += 1;
			return applyVirtualizedForm(result, record.evidenceId, record.synopsis, record.contentBytes, false);
		});
		return { assembly: { ...assembly, messages }, count };
	}

	private _unrecoverableReason(assembly: ContextAssembly, accounting: { calibratedMultiplier?: number }): string {
		const regions = estimateContextRegionCosts(assembly, accounting);
		const safe = this._deriveAdaptiveCapability(
			this._options.capabilityProvider?.() ?? this._options.capability,
		).safeInputBudget;
		const parts = [
			`systemPrompt≈${regions.systemPromptTokens}`,
			`toolSchemas≈${regions.toolSchemaTokens}`,
			`dynamicPrompt≈${regions.dynamicPromptTokens}`,
			`messages≈${regions.messageTokens}`,
			`fixedPrefix≈${regions.fixedPrefixTokens}`,
			`safeInputBudget=${safe}`,
		];
		return (
			`Cannot fit working set within safe input budget (${parts.join(", ")}). ` +
			"Reduce tools, shrink the system prompt, or configure a larger context window."
		);
	}

	/**
	 * Archive tool results, replacing raw text with a synopsis + a durable
	 * evidence reference. The full content remains recoverable.
	 *
	 * @param includeOlder When false, only individually oversized results are
	 * virtualized (proactive LARGE rule). When true, older results outside the
	 * recent hot tail are also virtualized (pressure reduction).
	 */
	private async _virtualizeToolResults(
		assembly: ContextAssembly,
		includeOlder: boolean,
	): Promise<{
		assembly: ContextAssembly;
		changed: boolean;
		archivedIds: string[];
	}> {
		const archivedIds: string[] = [];
		let changed = false;
		const messages = assembly.messages.map((message) => message);
		const recentTail = buildRecentTail(messages, this._options.keepRecentTokens);
		const recentTailStart = messages.length - recentTail.length;

		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];
			if (!message || message.role !== "toolResult") continue;

			const result = message as ToolResultMessage;
			if (isAlreadyVirtualized(result)) continue;

			const cost = toolResultTextTokens(result);
			const inRecentTail = i >= recentTailStart;
			// Large results always; older results only when reducing pressure.
			if (cost < this._options.toolResultVirtualizeThreshold && !(includeOlder && !inRecentTail)) {
				continue;
			}

			const text = toolResultText(result);
			if (text.length === 0) continue;

			// Identity reuse: content fetched via retrieve_evidence already has an
			// authoritative cold copy. Collapse it back to the ORIGINAL evidence ref
			// instead of archiving a duplicate (avoids archive -> retrieve -> archive
			// duplicate chains).
			const originEvidenceId = getEvidenceSourceId(result);
			const synopsis = synopsisFor(text);

			if (originEvidenceId) {
				const contentHash = buildEvidenceRecord({
					kind: "tool-result",
					source: result.toolName,
					content: text,
					now: this._options.now(),
				}).contentHash;
				this._recordVirtualization(result.toolCallId, {
					evidenceId: originEvidenceId,
					contentHash,
					source: result.toolName,
					synopsis,
					contentBytes: Buffer.byteLength(text, "utf8"),
				});
				messages[i] = applyVirtualizedForm(
					result,
					originEvidenceId,
					synopsis,
					Buffer.byteLength(text, "utf8"),
					true,
				);
				changed = true;
				continue;
			}

			const record = buildEvidenceRecord({
				kind: "tool-result",
				source: result.toolName,
				content: text,
				now: this._options.now(),
			});

			// Content-addressed identity reuse: never write the same artifact twice.
			const alreadyStored = await this._options.archive.has(record.evidenceId);
			if (alreadyStored) {
				this._reusedEvidenceCount += 1;
				this._duplicateArchiveAvoidedCount += 1;
			} else {
				await this._options.archive.store({
					kind: record.kind,
					source: record.source,
					content: record.content,
				});
			}

			archivedIds.push(record.evidenceId);
			this._recordVirtualization(result.toolCallId, {
				evidenceId: record.evidenceId,
				contentHash: record.contentHash,
				source: record.source,
				synopsis,
				contentBytes: record.contentBytes,
			});

			if (!this._archivedEvidenceRefs.has(record.evidenceId)) {
				this._archivedEvidenceRefs.set(record.evidenceId, synopsis.slice(0, 120));
				this._emitEvidenceRefs();
			}

			messages[i] = applyVirtualizedForm(result, record.evidenceId, synopsis, record.contentBytes, false);
			changed = true;
		}

		return { assembly: { ...assembly, messages }, changed, archivedIds };
	}

	private _recordVirtualization(
		toolCallId: string,
		record: Omit<ToolVirtualizationRecord, "toolCallId" | "virtualizedAtMs">,
	): void {
		const existing = this._virtualizations.get(toolCallId);
		const full: ToolVirtualizationRecord = {
			toolCallId,
			...record,
			virtualizedAtMs: existing?.virtualizedAtMs ?? this._options.now(),
		};
		this._virtualizations.set(toolCallId, full);
		this._persistVirtualizations();
	}

	/** Roll the context over: preamble + recent tail. Returns undefined if no change. */
	private _rollover(
		assembly: ContextAssembly,
		checkpoint: MissionContextCheckpoint,
	): { assembly: ContextAssembly } | undefined {
		const preamble = makeCheckpointMessage(checkpoint);
		const tail = buildRecentTail(assembly.messages, this._options.keepRecentTokens);
		const nextMessages = [preamble, ...tail];
		if (nextMessages.length >= assembly.messages.length) {
			return undefined;
		}
		return { assembly: { ...assembly, messages: nextMessages } };
	}

	/** Drop the oldest non-pinned messages while retaining at least the recent tail + minimum. */
	private _trimTail(assembly: ContextAssembly): { assembly: ContextAssembly; changed: boolean } {
		const pinned = assembly.messages.filter(isPinnedMessage);
		const normal = assembly.messages.filter((m) => !isPinnedMessage(m));
		if (normal.length <= this._options.minRetainedMessages) {
			return { assembly, changed: false };
		}
		const tail = buildRecentTail(normal, this._options.keepRecentTokens);
		const keepCount = Math.max(this._options.minRetainedMessages, tail.length);
		if (keepCount >= normal.length) {
			return { assembly, changed: false };
		}
		let kept = normal.slice(normal.length - keepCount);
		// Ensure the cut does not orphan a leading tool result.
		let start = 0;
		while (start < kept.length && kept[start]!.role === "toolResult") start += 1;
		kept = kept.slice(start);
		return { assembly: { ...assembly, messages: [...pinned, ...kept] }, changed: true };
	}

	/** Opt-in telemetry snapshot (metadata only; never prompt content). */
	getTelemetry(): ContextGovernorTelemetry {
		const capability = this._options.capabilityProvider?.() ?? this._options.capability;
		const effective = this._deriveAdaptiveCapability(capability);
		const last = this._lastDiagnostics;
		const regions = this._lastRegionCosts;
		const estimationError =
			this._lastUsageObservation && this._lastUsageObservation.observed - this._lastUsageObservation.estimated;
		const estimationErrorRatio =
			this._lastUsageObservation && this._lastUsageObservation.estimated > 0
				? this._lastUsageObservation.observed / this._lastUsageObservation.estimated
				: undefined;

		return {
			tokenAccountingMode: this.getTokenAccountingMode(),
			estimatedInputTokens: last?.inputTokensAfter ?? last?.inputTokensBefore ?? 0,
			providerObservedInputTokens: this._lastUsageObservation?.observed,
			estimationError,
			estimationErrorRatio,
			configuredContextWindow: effective.configuredContextWindow,
			baseSafeInputBudget: capability.safeInputBudget,
			effectiveSafeInputBudget: effective.safeInputBudget,
			reservedOutputTokens: effective.reservedOutputTokens,
			safetyReserveTokens: effective.safetyReserveTokens,
			overflowCount: this._overflowCount,
			providerOverflowCount: this._providerOverflowCount,
			forcedReductionCount: this._forcedReductionCount,
			rolloverCount: this._rolloverCount,
			archivedEvidenceCount: this._archivedEvidenceRefs.size,
			reusedEvidenceCount: this._reusedEvidenceCount,
			duplicateArchiveAvoidedCount: this._duplicateArchiveAvoidedCount,
			fixedPrefixTokens: regions?.fixedPrefixTokens ?? last?.fixedPrefixTokens ?? 0,
			messageTokens: regions?.messageTokens ?? (last ? last.inputTokensAfter - last.fixedPrefixTokens : 0),
			toolSchemaTokens: regions?.toolSchemaTokens ?? 0,
			recoveryIteration: this._overflowCount,
			adaptiveSafetyReserveTokens: this._adaptiveSafetyReserveTokens,
			calibratedMultiplier: this._calibratedMultiplier ?? 1,
			calibrationSamples: this._calibrationSamples,
		};
	}
}

/**
 * Rehydrate an archived evidence artifact back into hot context text. Used when
 * a model needs an old tool output again; the governor does not auto-page-in
 * (avoiding loops).
 */
export async function rehydrateEvidence(
	archive: EvidenceArchive,
	evidenceId: string,
	maxChars = 8000,
): Promise<string | undefined> {
	const record = await archive.load(evidenceId);
	if (!record) return undefined;
	if (record.content.length <= maxChars) return record.content;
	return `${record.content.slice(0, maxChars)}\n\n[... truncated from durable evidence ${record.evidenceId} (${record.contentBytes} bytes total)]`;
}
