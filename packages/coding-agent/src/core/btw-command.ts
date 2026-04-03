import type { CustomMessage } from "./messages.js";

export const BTW_COMMAND_NAME = "/btw";
export const BTW_COMMAND_USAGE = "Usage: /btw <note>";
export const BTW_CUSTOM_TYPE = "btw";

export interface BtwNoteDetails {
	note: string;
}

export interface BtwCommandTarget {
	queueByTheWay(note: string): void;
	getPendingByTheWayNotes(): readonly string[];
}

export function parseBtwCommand(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed.toLowerCase().startsWith(`${BTW_COMMAND_NAME} `)) {
		return undefined;
	}

	const note = trimmed.slice(BTW_COMMAND_NAME.length).trim();
	return note.length > 0 ? note : undefined;
}

export function createBtwNextTurnMessage(
	note: string,
): Pick<CustomMessage<BtwNoteDetails>, "customType" | "content" | "display" | "details"> {
	return {
		customType: BTW_CUSTOM_TYPE,
		content:
			`<system-reminder>By the way from the operator for the next turn only. ` +
			`Treat this as additional guidance that should inform the next response, but do not treat it as persisted memory or a new standalone task by itself unless the next user message asks for that. ` +
			`This note is runtime-only and should be consumed once on the next turn.</system-reminder>\n\n${note}`,
		display: false,
		details: { note },
	};
}

export function getBtwNoteFromMessage(
	message: Pick<CustomMessage<unknown>, "customType" | "details">,
): string | undefined {
	if (message.customType !== BTW_CUSTOM_TYPE) {
		return undefined;
	}

	if (!message.details || typeof message.details !== "object" || !Object.hasOwn(message.details, "note")) {
		return undefined;
	}

	const { note } = message.details as { note?: unknown };
	return typeof note === "string" ? note : undefined;
}

export function runBtwCommand(target: BtwCommandTarget, note: string): string {
	target.queueByTheWay(note);
	const pendingCount = target.getPendingByTheWayNotes().length;
	return (
		`Queued by-the-way guidance for the next turn only (runtime-only). ` +
		`It will be injected with the next real prompt and then cleared. Pending BTW notes: ${pendingCount}.`
	);
}
