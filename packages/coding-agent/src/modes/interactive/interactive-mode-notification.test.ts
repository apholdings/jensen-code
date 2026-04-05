import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "./interactive-mode.js";

type NotificationHarness = {
	handleEvent: (event: { type: string; [key: string]: unknown }) => Promise<void>;
	showStatus: (message: string) => void;
	ui: { requestRender: () => void };
	sessionEpoch: number;
};

describe("InteractiveMode notification event handling", () => {
	describe("operator_discipline_advisory", () => {
		it("shows advisory as status message when delegation occurs without task/todo state", async () => {
			const events: string[] = [];
			const showStatus = vi.fn((message: string) => {
				events.push(`showStatus:${message}`);
			});
			const requestRender = vi.fn(() => {
				events.push("requestRender");
			});
			const footer = { invalidate: vi.fn() };

			const mode = Object.assign(Object.create(InteractiveMode.prototype), {
				isInitialized: true,
				sessionEpoch: 1,
				showStatus,
				ui: { requestRender },
				footer,
				lastStatusText: undefined,
				lastStatusSpacer: undefined,
				chatContainer: { children: [] },
			}) as NotificationHarness;

			// Simulate the notification event that fires when delegating without task/todo state
			const notificationEvent = {
				type: "notification",
				kind: "operator_discipline_advisory",
				message:
					"Delegating without visible task or todo state. Consider creating tracking entries before delegating.",
			};

			await mode.handleEvent(notificationEvent);

			expect(showStatus).toHaveBeenCalledTimes(1);
			expect(showStatus).toHaveBeenCalledWith(notificationEvent.message);
		});

		it("does not show status for unknown notification kinds", async () => {
			const showStatus = vi.fn();
			const footer = { invalidate: vi.fn() };

			const mode = Object.assign(Object.create(InteractiveMode.prototype), {
				isInitialized: true,
				sessionEpoch: 1,
				showStatus,
				ui: { requestRender: vi.fn() },
				footer,
			}) as NotificationHarness;

			// Simulate an unknown notification type
			const unknownNotificationEvent = {
				type: "notification",
				kind: "unknown_advisory_type",
				message: "This is an unknown notification.",
			};

			await mode.handleEvent(unknownNotificationEvent);

			expect(showStatus).not.toHaveBeenCalled();
		});

		it("handles notification event correctly without regression on other event types", async () => {
			const showStatus = vi.fn();
			const requestRender = vi.fn();
			const updateWorkingContextPanel = vi.fn();
			const footer = { invalidate: vi.fn() };

			const mode = Object.assign(Object.create(InteractiveMode.prototype), {
				isInitialized: true,
				sessionEpoch: 1,
				showStatus,
				ui: { requestRender },
				updateWorkingContextPanel,
				footer,
				lastStatusText: undefined,
				lastStatusSpacer: undefined,
				chatContainer: { children: [] },
			}) as NotificationHarness;

			// Verify task_update still works (different event type)
			const taskUpdateEvent = {
				type: "task_update",
				tasks: [{ id: "1", content: "Test task", status: "in_progress" }],
			};

			await mode.handleEvent(taskUpdateEvent);

			expect(updateWorkingContextPanel).toHaveBeenCalled();
			expect(showStatus).not.toHaveBeenCalled();
		});
	});
});
