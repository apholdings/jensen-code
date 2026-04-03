/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@apholdings/jensen-ai";
import type { AgentSession } from "../core/agent-session.js";
import { BRIEF_ONLY_COMMAND_USAGE, parseBriefOnlyCommand, runBriefOnlyCommand } from "../core/brief-only-command.js";
import { BTW_COMMAND_USAGE, parseBtwCommand, runBtwCommand } from "../core/btw-command.js";
import { initializeProjectScaffold } from "../core/init-project.js";
import {
	formatMemoryDiffOutput,
	formatMemoryHistoryOutput,
	formatRelativeAgeLabel,
} from "../core/memory-compare-output.js";
import {
	parseSteerCommand,
	runSteerCommand,
	STEER_COMMAND_ACTIVE_WORK_REQUIRED,
	STEER_COMMAND_USAGE,
} from "../core/steer-command.js";
import { formatUltraplanShowOutput } from "../core/ultraplan.js";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

interface PrintModeLocalCommandSession
	extends Pick<
		AgentSession,
		| "briefOnly"
		| "setBriefOnly"
		| "queueByTheWay"
		| "getPendingByTheWayNotes"
		| "getMemoryHistory"
		| "resolveMemorySnapshotSelector"
		| "getLatestUltraplanPlan"
		| "runUltraplan"
		| "runUltraplanRevise"
		| "applyUltraplan"
	> {
	isStreaming?: boolean;
	state?: { messages: ReadonlyArray<{ role: string }> };
	steer?: (message: string) => Promise<void>;
	getSteeringMessages?: () => readonly string[];
	agent?: { continue(): Promise<void> };
}

export async function getPrintModeLocalCommandOutput(
	session: PrintModeLocalCommandSession,
	text: string,
): Promise<string | undefined> {
	const parts = text.trim().split(/\s+/);
	const command = parts[0]?.toLowerCase();
	const subcommand = parts[1]?.toLowerCase();
	const briefOnlyAction = parseBriefOnlyCommand(text);
	const btwNote = parseBtwCommand(text);
	const steerMessage = parseSteerCommand(text);

	if (command === "/brief") {
		return briefOnlyAction ? runBriefOnlyCommand(session, briefOnlyAction) : BRIEF_ONLY_COMMAND_USAGE;
	}

	if (command === "/btw") {
		return btwNote ? runBtwCommand(session, btwNote) : BTW_COMMAND_USAGE;
	}

	if (command === "/steer") {
		if (!steerMessage) {
			return STEER_COMMAND_USAGE;
		}
		if (!session.state || !session.steer || !session.getSteeringMessages || !session.agent) {
			return STEER_COMMAND_ACTIVE_WORK_REQUIRED;
		}
		try {
			return await runSteerCommand(
				{
					isStreaming: session.isStreaming ?? false,
					state: session.state,
					steer: (message) => session.steer!(message),
					continueCurrentWork: () => session.agent!.continue(),
					getSteeringMessages: () => session.getSteeringMessages!(),
				},
				steerMessage,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return message || STEER_COMMAND_ACTIVE_WORK_REQUIRED;
		}
	}

	if (command === "/memory") {
		const snapshots = session.getMemoryHistory();
		if (subcommand === "history") {
			return formatMemoryHistoryOutput(snapshots, {
				getRelativeAgeLabel: formatRelativeAgeLabel,
			}).join("\n");
		}

		if (subcommand === "diff") {
			return formatMemoryDiffOutput(
				snapshots,
				{
					getRelativeAgeLabel: formatRelativeAgeLabel,
					resolveSnapshotSelector: (input) => session.resolveMemorySnapshotSelector(input),
				},
				{ baseline: parts[2], target: parts[3] },
			).join("\n");
		}
	}

	if (command === "/init-project") {
		const includeProtocol = parts[1] === "--protocol";
		if (parts.length > 2 || (parts[1] !== undefined && !includeProtocol)) {
			return "Usage: /init-project [--protocol]";
		}
		return initializeProjectScaffold(process.cwd(), { includeProtocol }).output;
	}

	if (command === "/ultraplan") {
		if (subcommand === "show") {
			return formatUltraplanShowOutput(session.getLatestUltraplanPlan());
		}

		if (subcommand === "apply") {
			return session.applyUltraplan().displayText;
		}

		if (subcommand === "revise" || subcommand === "regenerate") {
			const instruction = text.slice(`/ultraplan ${subcommand}`.length).trim();
			if (!instruction) {
				return "Usage: /ultraplan <objective> | /ultraplan show | /ultraplan apply | /ultraplan revise <instruction> | /ultraplan regenerate <instruction>";
			}
			const result = await session.runUltraplanRevise(instruction);
			return result.displayText;
		}

		const objective = text.slice("/ultraplan".length).trim();
		if (!objective) {
			return "Usage: /ultraplan <objective> | /ultraplan show | /ultraplan apply | /ultraplan revise <instruction> | /ultraplan regenerate <instruction>";
		}

		const result = await session.runUltraplan(objective);
		return result.displayText;
	}

	return undefined;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			console.log(JSON.stringify(header));
		}
	}
	// Set up extensions for print mode (no UI)
	await session.bindExtensions({
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async (options) => {
				const success = await session.newSession({ parentSession: options?.parentSession });
				if (success && options?.setup) {
					await options.setup(session.sessionManager);
				}
				return { cancelled: !success };
			},
			fork: async (entryId) => {
				const result = await session.fork(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await session.navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath) => {
				const success = await session.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await session.reload();
			},
		},
		onError: (err) => {
			console.error(`Extension error (${err.extensionPath}): ${err.error}`);
		},
	});

	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe((event) => {
		// In JSON mode, output all events
		if (mode === "json") {
			console.log(JSON.stringify(event));
		}
	});

	const handleTextOrLocalCommand = async (text: string, images?: ImageContent[]): Promise<void> => {
		if (mode === "text") {
			const localOutput = await getPrintModeLocalCommandOutput(session, text);
			if (localOutput !== undefined) {
				console.log(localOutput);
				return;
			}
		}
		await session.prompt(text, { images });
	};

	// Send initial message with attachments
	if (initialMessage) {
		await handleTextOrLocalCommand(initialMessage, initialImages);
	}

	// Send remaining messages
	for (const message of messages) {
		await handleTextOrLocalCommand(message);
	}

	// In text mode, output final response
	if (mode === "text") {
		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;

			// Check for error/aborted
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				process.exit(1);
			}

			// Output text content
			for (const content of assistantMsg.content) {
				if (content.type === "text") {
					console.log(content.text);
				}
			}
		}
	}

	// Ensure stdout is fully flushed before returning
	// This prevents race conditions where the process exits before all output is written
	await new Promise<void>((resolve, reject) => {
		process.stdout.write("", (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}
