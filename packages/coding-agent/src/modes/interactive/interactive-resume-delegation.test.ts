import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "./interactive-mode.js";

type ResumeHarness = {
	handleResumeSession: (sessionPath: string) => Promise<void>;
	session: { switchSession: (sessionPath: string) => Promise<boolean> };
	loadingAnimation?: { dispose: () => void };
	clearStatusOwner: (options: { requestRender: boolean }) => void;
	pendingMessagesContainer: { clear: () => void };
	compactionQueuedMessages: string[];
	resetInteractiveSessionUI: (renderInitialMessages?: boolean) => void;
	showStatus: (message: string) => void;
};

describe("InteractiveMode /resume delegation boundary", () => {
	it("delegates resume to AgentSession.switchSession(sessionPath) before interactive UI reset", async () => {
		const events: string[] = [];
		let resolveSwitch: ((value: boolean) => void) | undefined;

		const switchSession = vi.fn<(sessionPath: string) => Promise<boolean>>((sessionPath: string) => {
			events.push(`switch:${sessionPath}`);
			return new Promise<boolean>((resolve) => {
				resolveSwitch = resolve;
			});
		});
		const dispose = vi.fn(() => {
			events.push("disposeLoading");
		});
		const clearStatusOwner = vi.fn(() => {
			events.push("clearStatusOwner");
		});
		const clearPendingMessages = vi.fn(() => {
			events.push("clearPendingMessages");
		});
		const resetInteractiveSessionUI = vi.fn(() => {
			events.push("resetInteractiveSessionUI");
		});
		const showStatus = vi.fn(() => {
			events.push("showStatus");
		});

		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			session: { switchSession },
			loadingAnimation: { dispose },
			clearStatusOwner,
			pendingMessagesContainer: { clear: clearPendingMessages },
			compactionQueuedMessages: ["queued"],
			resetInteractiveSessionUI,
			showStatus,
		}) as ResumeHarness;

		const resumePromise = mode.handleResumeSession("/tmp/resumed-session.jsonl");

		expect(switchSession).toHaveBeenCalledWith("/tmp/resumed-session.jsonl");
		expect(resetInteractiveSessionUI).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();

		resolveSwitch?.(true);
		await resumePromise;

		expect(events).toEqual([
			"disposeLoading",
			"clearStatusOwner",
			"switch:/tmp/resumed-session.jsonl",
			"clearPendingMessages",
			"resetInteractiveSessionUI",
			"showStatus",
		]);
		expect(mode.compactionQueuedMessages).toEqual([]);
		expect(resetInteractiveSessionUI).toHaveBeenCalledWith(true);
		expect(showStatus).toHaveBeenCalledWith("Resumed session");
	});

	it("preserves local UI state and avoids success signals when resume is cancelled before switching", async () => {
		const events: string[] = [];
		const switchSession = vi.fn<(sessionPath: string) => Promise<boolean>>((sessionPath: string) => {
			events.push(`switch:${sessionPath}`);
			return Promise.resolve(false);
		});
		const dispose = vi.fn(() => {
			events.push("disposeLoading");
		});
		const clearStatusOwner = vi.fn(() => {
			events.push("clearStatusOwner");
		});
		const clearPendingMessages = vi.fn(() => {
			events.push("clearPendingMessages");
		});
		const resetInteractiveSessionUI = vi.fn(() => {
			events.push("resetInteractiveSessionUI");
		});
		const showStatus = vi.fn(() => {
			events.push("showStatus");
		});

		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			session: { switchSession },
			loadingAnimation: { dispose },
			clearStatusOwner,
			pendingMessagesContainer: { clear: clearPendingMessages },
			compactionQueuedMessages: ["queued"],
			resetInteractiveSessionUI,
			showStatus,
		}) as ResumeHarness;

		await expect(mode.handleResumeSession("/tmp/cancelled-session.jsonl")).resolves.toBeUndefined();

		expect(events).toEqual(["disposeLoading", "clearStatusOwner", "switch:/tmp/cancelled-session.jsonl"]);
		expect(mode.compactionQueuedMessages).toEqual(["queued"]);
		expect(clearPendingMessages).not.toHaveBeenCalled();
		expect(resetInteractiveSessionUI).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("preserves local UI state and avoids success signals when resume fails", async () => {
		const events: string[] = [];
		const switchSession = vi.fn<(sessionPath: string) => Promise<boolean>>((sessionPath: string) => {
			events.push(`switch:${sessionPath}`);
			return Promise.reject(new Error("Session not found"));
		});
		const dispose = vi.fn(() => {
			events.push("disposeLoading");
		});
		const clearStatusOwner = vi.fn(() => {
			events.push("clearStatusOwner");
		});
		const clearPendingMessages = vi.fn(() => {
			events.push("clearPendingMessages");
		});
		const resetInteractiveSessionUI = vi.fn(() => {
			events.push("resetInteractiveSessionUI");
		});
		const showStatus = vi.fn(() => {
			events.push("showStatus");
		});

		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			session: { switchSession },
			loadingAnimation: { dispose },
			clearStatusOwner,
			pendingMessagesContainer: { clear: clearPendingMessages },
			compactionQueuedMessages: ["queued"],
			resetInteractiveSessionUI,
			showStatus,
		}) as ResumeHarness;

		await expect(mode.handleResumeSession("/tmp/missing-session.jsonl")).rejects.toThrow("Session not found");

		expect(events).toEqual(["disposeLoading", "clearStatusOwner", "switch:/tmp/missing-session.jsonl"]);
		expect(mode.compactionQueuedMessages).toEqual(["queued"]);
		expect(clearPendingMessages).not.toHaveBeenCalled();
		expect(resetInteractiveSessionUI).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
	});
});
