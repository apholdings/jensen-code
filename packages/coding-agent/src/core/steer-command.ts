export const STEER_COMMAND_NAME = "/steer";
export const STEER_COMMAND_USAGE = "Usage: /steer <message>";
export const STEER_COMMAND_ACTIVE_WORK_REQUIRED =
	"/steer needs an active workstream. Use it while Jensen is working, or after an assistant response to continue the current work. It does not create a new standalone task by itself.";

export interface SteerCommandMessage {
	role: string;
}

export interface SteerCommandTarget {
	isStreaming: boolean;
	state: {
		messages: readonly SteerCommandMessage[];
	};
	steer(text: string): Promise<void>;
	continueCurrentWork(): Promise<void>;
	getSteeringMessages(): readonly string[];
}

export function parseSteerCommand(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed.toLowerCase().startsWith(`${STEER_COMMAND_NAME} `)) {
		return undefined;
	}

	const message = trimmed.slice(STEER_COMMAND_NAME.length).trim();
	return message.length > 0 ? message : undefined;
}

export async function runSteerCommand(target: SteerCommandTarget, message: string): Promise<string> {
	if (target.isStreaming) {
		await target.steer(message);
		return (
			"Queued steering for the active workstream. It will be delivered after the current assistant turn finishes its current tool work, before the next model call. " +
			`Pending steering messages: ${target.getSteeringMessages().length}.`
		);
	}

	const lastMessage = target.state.messages[target.state.messages.length - 1];
	if (lastMessage?.role !== "assistant") {
		throw new Error(STEER_COMMAND_ACTIVE_WORK_REQUIRED);
	}

	await target.steer(message);
	await target.continueCurrentWork();
	return (
		"Submitted steering for the active workstream and resumed from the latest assistant turn. " +
		"This is not live mid-thought interruption; it starts a continuation turn from the current session state."
	);
}
