import { Container } from "@apholdings/jensen-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "./interactive-mode.js";

describe("InteractiveMode /btw command", () => {
	it("queues /btw guidance through the interactive command surface", () => {
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			chatContainer: new Container(),
			showWarning: vi.fn(),
			ui: { requestRender: vi.fn() },
			session: {
				pendingBtwNotes: [] as string[],
				queueByTheWay(note: string) {
					this.pendingBtwNotes.push(note);
				},
				getPendingByTheWayNotes() {
					return this.pendingBtwNotes;
				},
			},
		}) as unknown as {
			handleBtwCommand: (text: string) => void;
			chatContainer: Container;
			session: { pendingBtwNotes: string[] };
		};

		mode.handleBtwCommand("/btw keep the next step narrow");
		expect(mode.session.pendingBtwNotes).toEqual(["keep the next step narrow"]);
		expect(mode.chatContainer.children.at(-1)).toMatchObject({
			text: expect.stringContaining("Queued by-the-way guidance for the next turn only (runtime-only)."),
		});

		mode.handleBtwCommand("/btw mention the pending blocker");
		expect(mode.session.pendingBtwNotes).toEqual(["keep the next step narrow", "mention the pending blocker"]);
		expect(mode.chatContainer.children.at(-1)).toMatchObject({
			text: expect.stringContaining("Pending BTW notes: 2."),
		});
	});
});
