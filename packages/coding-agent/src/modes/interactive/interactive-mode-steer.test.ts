import { Container } from "@apholdings/jensen-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "./interactive-mode.js";

describe("InteractiveMode /steer command", () => {
	it("routes /steer through the interactive command surface and resumes the active workstream", async () => {
		const steer = vi.fn<(message: string) => Promise<void>>().mockResolvedValue(undefined);
		const continueCurrentWork = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const updatePendingMessagesDisplay = vi.fn();

		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			chatContainer: new Container(),
			showWarning: vi.fn(),
			ui: { requestRender: vi.fn() },
			updatePendingMessagesDisplay,
			session: {
				isStreaming: false,
				state: { messages: [{ role: "assistant" }] },
				steer,
				getSteeringMessages: () => [],
				agent: {
					continue: continueCurrentWork,
				},
			},
		}) as unknown as {
			handleSteerCommand: (text: string) => Promise<void>;
			chatContainer: Container;
		};

		await mode.handleSteerCommand("/steer keep the patch focused");

		expect(steer).toHaveBeenCalledWith("keep the patch focused");
		expect(continueCurrentWork).toHaveBeenCalledTimes(1);
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(mode.chatContainer.children.at(-1)).toMatchObject({
			text: expect.stringContaining(
				"Submitted steering for the active workstream and resumed from the latest assistant turn.",
			),
		});
	});
});
