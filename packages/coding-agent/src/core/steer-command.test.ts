import { describe, expect, it, vi } from "vitest";
import { parseSteerCommand, runSteerCommand, STEER_COMMAND_ACTIVE_WORK_REQUIRED } from "./steer-command.js";

describe("steer-command", () => {
	it("parses /steer messages", () => {
		expect(parseSteerCommand("/steer keep the implementation bounded")).toBe("keep the implementation bounded");
		expect(parseSteerCommand("/steer    tighten the acceptance criteria   ")).toBe("tighten the acceptance criteria");
		expect(parseSteerCommand("/steer")).toBeUndefined();
		expect(parseSteerCommand("/btw not this one")).toBeUndefined();
	});

	it("queues steering during streaming without forcing a new continuation", async () => {
		const steeringMessages: string[] = [];
		const continueCurrentWork = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		const output = await runSteerCommand(
			{
				isStreaming: true,
				state: { messages: [{ role: "assistant" }] },
				steer: async (message) => {
					steeringMessages.push(message);
				},
				continueCurrentWork,
				getSteeringMessages: () => steeringMessages,
			},
			"keep the task bounded",
		);

		expect(steeringMessages).toEqual(["keep the task bounded"]);
		expect(continueCurrentWork).not.toHaveBeenCalled();
		expect(output).toContain("Queued steering for the active workstream.");
		expect(output).toContain("Pending steering messages: 1.");
	});

	it("resumes from the latest assistant turn when idle", async () => {
		const steeringMessages: string[] = [];
		const continueCurrentWork = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		const output = await runSteerCommand(
			{
				isStreaming: false,
				state: { messages: [{ role: "user" }, { role: "assistant" }] },
				steer: async (message) => {
					steeringMessages.push(message);
				},
				continueCurrentWork,
				getSteeringMessages: () => steeringMessages,
			},
			"re-check the last diff before editing",
		);

		expect(steeringMessages).toEqual(["re-check the last diff before editing"]);
		expect(continueCurrentWork).toHaveBeenCalledTimes(1);
		expect(output).toContain(
			"Submitted steering for the active workstream and resumed from the latest assistant turn.",
		);
		expect(output).toContain("This is not live mid-thought interruption");
	});

	it("rejects /steer when there is no active workstream to continue", async () => {
		const continueCurrentWork = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const steer = vi.fn<(message: string) => Promise<void>>().mockResolvedValue(undefined);

		await expect(
			runSteerCommand(
				{
					isStreaming: false,
					state: { messages: [] },
					steer,
					continueCurrentWork,
					getSteeringMessages: () => [],
				},
				"start doing the work now",
			),
		).rejects.toThrow(STEER_COMMAND_ACTIVE_WORK_REQUIRED);
		expect(steer).not.toHaveBeenCalled();
		expect(continueCurrentWork).not.toHaveBeenCalled();
	});
});
