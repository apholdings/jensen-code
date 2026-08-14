/**
 * Context Governor (Long-Horizon Context Virtualization, 2.5.0).
 *
 * First-class preflight enforcement of the safe input budget. Before a provider
 * is invoked, the candidate assembly (system prompt + tools + dynamic prompt +
 * messages) is conservatively counted and reduced until it fits — or a
 * structured unrecoverable condition is returned with region diagnostics.
 *
 * Reduction is deterministic and LLM-free (it runs BEFORE the model call, so it
 * cannot depend on another model call):
 *   1. Virtualize oversized/older tool results into the cold evidence archive
 *      (retaining a synopsis + durable evidence reference).
 *   2. Roll the context over: retire the historical transcript and replace the
 *      prefix with a bounded mission-context-checkpoint preamble + recent tail.
 *   3. Trim the recent tail deterministically (bounded iterations).
 *
 * The governor never invents mission state: the checkpoint is an operational
 * projection, and completion authority stays with the Reliability Kernel.
 */

import type { AgentMessage } from "@apholdings/jensen-agent-core";
import type { ToolResultMessage } from "@apholdings/jensen-ai";
import {
	type ContextCapability,
	contextPressureRatio,
	exceedsSafeInputBudget,
	resolveContextCapability,
} from "./context-capability.js";
import { type ContextAssembly, estimateAssemblyInputTokens, estimateMessageTokensFor } from "./context-token.js";
import type { EvidenceArchive } from "./evidence-archive.js";
import { buildEvidenceRecord } from "./evidence-archive.js";
import { checkpointToRehydrationPreamble, type MissionContextCheckpoint } from "./mission-checkpoint.js";

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
	messagesEvicted: number;
	tokensEvicted: number;
	rolloverOccurred: boolean;
	checkpointRevision?: number;
	evidenceIdsArchived: string[];
	reducedRegions: string[];
	unrecoverableReason?: string;
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
		details: { missionId: checkpoint.missionId, revision: checkpoint.revision },
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
		now: () => number;
	};

	/** Tool results already archived during this governor's lifetime. */
	private readonly _archivedToolCallIds = new Set<string>();

	/** Cumulative evidence refs (id -> short summary) archived during this governor's lifetime. */
	private readonly _archivedEvidenceRefs = new Map<string, string>();

	/** Count of provider overflow disagreements recorded (bounded reduction). */
	private _overflowCount = 0;

	/** Most recent governance diagnostics (telemetry surface). */
	private _lastDiagnostics: ContextGovernorDiagnostics | undefined;

	/** Most recent governance diagnostics (telemetry surface). */
	get lastDiagnostics(): ContextGovernorDiagnostics | undefined {
		return this._lastDiagnostics;
	}

	/** Number of provider overflow disagreements recorded. */
	get overflowCount(): number {
		return this._overflowCount;
	}

	/**
	 * Cumulative evidence references archived during this governor's lifetime.
	 * Used to persist references into the durable mission checkpoint so they
	 * survive a rollover without embedding the raw artifact.
	 */
	getArchivedEvidenceRefs(): { evidenceId: string; summary: string }[] {
		return [...this._archivedEvidenceRefs].map(([evidenceId, summary]) => ({ evidenceId, summary }));
	}

	constructor(options: ContextGovernorOptions) {
		this._options = {
			capability: options.capability,
			archive: options.archive,
			checkpointProvider: options.checkpointProvider,
			capabilityProvider: options.capabilityProvider,
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
	}

	/** Update the checkpoint provider (set after the session builds it). */
	setCheckpointProvider(provider: ContextGovernorOptions["checkpointProvider"]): void {
		this._options.checkpointProvider = provider;
	}

	/** Update the capability provider (for runtime model switches). */
	setCapabilityProvider(provider: ContextGovernorOptions["capabilityProvider"]): void {
		this._options.capabilityProvider = provider;
	}

	/**
	 * Record a provider context-overflow disagreement. Subsequent `govern` calls
	 * apply a progressively stricter budget (bounded) so a tokenizer mismatch
	 * forces stronger deterministic reduction instead of looping.
	 */
	recordOverflow(): void {
		this._overflowCount += 1;
	}

	/**
	 * Preflight-reduce an assembly to satisfy the safe input budget.
	 *
	 * @returns the reduced assembly plus diagnostics. When `action` is
	 * "unrecoverable", the caller must NOT send the request.
	 */
	async govern(assembly: ContextAssembly): Promise<ContextGovernorResult> {
		const baseCapability = this._options.capabilityProvider?.() ?? this._options.capability;
		const capability = this._overflowCount > 0 ? this._shrinkCapability(baseCapability) : baseCapability;
		const inputTokensBefore = estimateAssemblyInputTokens(assembly);
		const pressureRatioBefore = contextPressureRatio(capability, inputTokensBefore);

		const baseDiagnostics: ContextGovernorDiagnostics = {
			action: "pass",
			capability,
			iterations: 0,
			inputTokensBefore,
			inputTokensAfter: inputTokensBefore,
			pressureRatioBefore,
			pressureRatioAfter: pressureRatioBefore,
			toolResultsArchived: 0,
			messagesEvicted: 0,
			tokensEvicted: 0,
			rolloverOccurred: false,
			evidenceIdsArchived: [],
			reducedRegions: [],
		};

		// Phase 0: proactively virtualize oversized tool results regardless of
		// overall pressure. A single huge raw result must never live forever in
		// the hot working set even when the window still has headroom.
		let current = assembly;
		let inputTokens = inputTokensBefore;
		const evidenceIdsArchived: string[] = [];
		const reducedRegions: string[] = [];

		const proactive = await this._virtualizeToolResults(current, false);
		if (proactive.changed) {
			current = proactive.assembly;
			for (const id of proactive.archivedIds) evidenceIdsArchived.push(id);
			reducedRegions.push("tool-result-virtualization");
			inputTokens = estimateAssemblyInputTokens(current);
		}

		// Below soft pressure and nothing was virtualized: no further action.
		if (inputTokens <= capability.softPressureThreshold && evidenceIdsArchived.length === 0) {
			this._lastDiagnostics = baseDiagnostics;
			return { assembly, diagnostics: baseDiagnostics };
		}

		// Below soft pressure but proactive virtualization ran: report it.
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
				inputTokens = estimateAssemblyInputTokens(current);
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
						inputTokens = estimateAssemblyInputTokens(current);
						rolloverOccurred = true;
						rolloverDone = true;
						checkpointRevision = checkpoint.revision;
						reducedRegions.push("checkpoint-rollover");
						continue;
					}
				}
				rolloverDone = true;
			}

			// Step 3: deterministic tail trim (evict oldest retained messages).
			const trimmed = this._trimTail(current);
			if (trimmed.changed) {
				current = trimmed.assembly;
				inputTokens = estimateAssemblyInputTokens(current);
				reducedRegions.push("tail-trim");
				continue;
			}

			// No progress possible: structured unrecoverable.
			break;
		}

		const inputTokensAfter = estimateAssemblyInputTokens(current);
		const stillOver = exceedsSafeInputBudget(capability, inputTokensAfter);
		const tokensEvicted = Math.max(0, inputTokensBefore - inputTokensAfter);

		let action: GovernorAction;
		if (stillOver) {
			action = "unrecoverable";
		} else if (rolloverOccurred) {
			action = "rollover";
		} else if (evidenceIdsArchived.length > 0) {
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
			unrecoverableReason: stillOver ? this._unrecoverableReason(current) : undefined,
		};

		this._lastDiagnostics = diagnostics;
		return { assembly: current, diagnostics };
	}

	private _countEvicted(before: ContextAssembly, after: ContextAssembly): number {
		return Math.max(0, before.messages.length - after.messages.length);
	}

	/** Progressively shrink the effective window after provider overflow disagreement. */
	private _shrinkCapability(base: ContextCapability): ContextCapability {
		const shrinkPerOverflow = Math.max(base.safetyReserveTokens, 256);
		const totalShrink = Math.min(
			Math.floor(base.configuredContextWindow * 0.5),
			shrinkPerOverflow * this._overflowCount,
		);
		return resolveContextCapability(
			{ modelContextWindow: base.physicalContextWindow, modelMaxTokens: base.maximumOutputTokens },
			{
				configuredContextWindow: Math.max(1, base.configuredContextWindow - totalShrink),
				reservedOutputTokens: base.reservedOutputTokens,
				safetyReserveTokens: base.safetyReserveTokens,
				softPressureRatio: 0.8,
				minimumSafeInputBudget: 256,
			},
		);
	}

	private _unrecoverableReason(assembly: ContextAssembly): string {
		const fixed = estimateAssemblyInputTokens({ ...assembly, messages: [] });
		const safe = this._options.capability.safeInputBudget;
		const regions = [`fixed-prefix(system+tools+dynamic)≈${fixed}`, `safeInputBudget=${safe}`];
		return (
			`Cannot fit working set within safe input budget; ${regions.join(", ")}. ` +
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
			if (this._archivedToolCallIds.has(result.toolCallId)) continue;

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
			if (originEvidenceId) {
				const synopsis = synopsisFor(text);
				messages[i] = {
					...result,
					content: [
						{
							type: "text",
							text:
								`[evidence retrieval collapsed] ${result.toolName} — synopsis: ${synopsis}\n` +
								`<evidence ref="${originEvidenceId}"/>`,
						},
					],
					details: {
						...(typeof result.details === "object" && result.details !== null ? result.details : {}),
						__virtualizedEvidenceId: originEvidenceId,
					},
				} as ToolResultMessage;
				// Mark processed so the collapsed ref is not re-collapsed on a later
				// governance iteration (which would otherwise loop without rollover).
				this._archivedToolCallIds.add(result.toolCallId);
				changed = true;
				continue;
			}

			const record = buildEvidenceRecord({
				kind: "tool-result",
				source: result.toolName,
				content: text,
				now: this._options.now(),
			});
			await this._options.archive.store({
				kind: record.kind,
				source: record.source,
				content: record.content,
			});
			archivedIds.push(record.evidenceId);
			this._archivedToolCallIds.add(result.toolCallId);

			const synopsis = synopsisFor(text);
			this._archivedEvidenceRefs.set(record.evidenceId, synopsis.slice(0, 120));
			messages[i] = {
				...result,
				content: [
					{
						type: "text",
						text:
							`[tool result virtualized] ${result.toolName} (${record.contentBytes} bytes). ` +
							`Synopsis: ${synopsis}\n<evidence ref="${record.evidenceId}"/>`,
					},
				],
				details: {
					...(typeof result.details === "object" && result.details !== null ? result.details : {}),
					__virtualizedEvidenceId: record.evidenceId,
					__virtualizedContentBytes: record.contentBytes,
				},
			} as ToolResultMessage;
			changed = true;
		}

		return { assembly: { ...assembly, messages }, changed, archivedIds };
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

	/** Drop the oldest messages while retaining at least the recent tail + minimum. */
	private _trimTail(assembly: ContextAssembly): { assembly: ContextAssembly; changed: boolean } {
		if (assembly.messages.length <= this._options.minRetainedMessages) {
			return { assembly, changed: false };
		}
		// Keep the recent tail; if the tail is already shorter than the min, keep min.
		const tail = buildRecentTail(assembly.messages, this._options.keepRecentTokens);
		const keepCount = Math.max(this._options.minRetainedMessages, tail.length);
		if (keepCount >= assembly.messages.length) {
			return { assembly, changed: false };
		}
		const messages = assembly.messages.slice(assembly.messages.length - keepCount);
		// Ensure the cut does not orphan a leading tool result.
		let start = 0;
		while (start < messages.length && messages[start]!.role === "toolResult") start += 1;
		return { assembly: { ...assembly, messages: messages.slice(start) }, changed: true };
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
