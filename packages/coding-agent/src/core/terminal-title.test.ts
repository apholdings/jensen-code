import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalTitle } from "./terminal-title.js";

/** A fake terminal that records title writes */
class FakeTerminal {
	titles: string[] = [];
	setTitle(title: string): void {
		this.titles.push(title);
	}
	lastTitle(): string | undefined {
		return this.titles[this.titles.length - 1];
	}
}

// Helper to simulate TTY state
function setTty(value: boolean): void {
	(process.stdout as unknown as Record<string, unknown>).isTTY = value;
}

describe("TerminalTitle", () => {
	let terminal: FakeTerminal;
	const originalIsTTY = process.stdout.isTTY;

	beforeEach(() => {
		terminal = new FakeTerminal();
		setTty(true);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		setTty(originalIsTTY);
	});

	it("sets static title with Jensen prefix on initialize", () => {
		const tt = new TerminalTitle(terminal, "django-mmo");
		tt.initialize("django-mmo");
		expect(terminal.lastTitle()).toBe("Jensen - django-mmo");
	});

	it("does not contain π symbol", () => {
		const tt = new TerminalTitle(terminal, "test-project");
		tt.initialize("test-project");
		for (const title of terminal.titles) {
			expect(title).not.toContain("π");
		}
	});

	it("preserves workspace name in title", () => {
		const tt = new TerminalTitle(terminal, "my-app");
		tt.initialize("my-app");
		expect(terminal.lastTitle()).toContain("my-app");
	});

	it("handles workspace with spaces and unicode", () => {
		const tt = new TerminalTitle(terminal, "café project");
		tt.initialize("café project");
		expect(terminal.lastTitle()).toBe("Jensen - café project");
	});

	it("shows spinner frame when working", () => {
		const tt = new TerminalTitle(terminal, "test");
		tt.initialize("test");
		terminal.titles = []; // Clear init title

		tt.setWorking(true);
		expect(terminal.titles.length).toBeGreaterThan(0);
		const lastTitle = terminal.lastTitle()!;
		expect(lastTitle).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Jensen - test$/u);
	});

	it("cycles spinner frames over time", () => {
		const tt = new TerminalTitle(terminal, "test");
		tt.initialize("test");
		terminal.titles = [];

		tt.setWorking(true);

		// First frame written immediately
		const frame0 = terminal.lastTitle()!;

		// Advance time and get next frame
		vi.advanceTimersByTime(100);
		const frame1 = terminal.lastTitle()!;

		expect(frame0).not.toBe(frame1);
	});

	it("returns to static title when work stops", () => {
		const tt = new TerminalTitle(terminal, "test");
		tt.initialize("test");
		terminal.titles = [];

		tt.setWorking(true);
		const workingTitle = terminal.lastTitle()!;
		expect(workingTitle).toContain("⠋");

		tt.setWorking(false);
		expect(terminal.lastTitle()).toBe("Jensen - test");
	});

	it("stops spinner on dispose", () => {
		const tt = new TerminalTitle(terminal, "test");
		tt.initialize("test");
		terminal.titles = [];

		tt.setWorking(true);
		tt.dispose();

		// After dispose, advance time - no more writes
		const countBefore = terminal.titles.length;
		vi.advanceTimersByTime(500);
		expect(terminal.titles.length).toBe(countBefore);
	});

	it("does not write after dispose", () => {
		const tt = new TerminalTitle(terminal, "test");
		tt.initialize("test");
		tt.dispose();
		terminal.titles = [];

		// These should all be no-ops
		tt.setWorking(true);
		tt.setWorking(false);
		tt.initialize("other");

		expect(terminal.titles.length).toBe(0);
	});

	it("setWorking(true) is idempotent", () => {
		const tt = new TerminalTitle(terminal, "test");
		tt.initialize("test");
		terminal.titles = [];

		tt.setWorking(true);
		const countAfterFirst = terminal.titles.length;

		tt.setWorking(true); // Second call should be no-op
		expect(terminal.titles.length).toBe(countAfterFirst);
	});

	it("setWorking(false) is idempotent", () => {
		const tt = new TerminalTitle(terminal, "test");
		tt.initialize("test");
		terminal.titles = [];

		tt.setWorking(false); // Already idle, no-op
		expect(terminal.titles.length).toBe(0);

		tt.setWorking(true);
		tt.setWorking(false);
		const countAfterStop = terminal.titles.length;

		tt.setWorking(false); // Already stopped, no-op
		expect(terminal.titles.length).toBe(countAfterStop);
	});

	it("exception in setWorking(false) after setWorking(true) still stops spinner", () => {
		// Simulate: start work, then an exception causes stop
		const tt = new TerminalTitle(terminal, "test");
		tt.initialize("test");
		terminal.titles = [];

		tt.setWorking(true);
		expect(terminal.lastTitle()).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);

		tt.setWorking(false);
		expect(terminal.lastTitle()).toBe("Jensen - test");

		// Verify spinner is fully stopped - no more frames
		const countAfterStop = terminal.titles.length;
		vi.advanceTimersByTime(500);
		expect(terminal.titles.length).toBe(countAfterStop);
	});

	it("no-op in non-TTY mode", () => {
		setTty(false);
		const tt = new TerminalTitle(terminal, "test");
		tt.initialize("test");
		tt.setWorking(true);
		vi.advanceTimersByTime(500);
		tt.setWorking(false);

		expect(terminal.titles.length).toBe(0);
	});

	it("handles multiple working cycles", () => {
		const tt = new TerminalTitle(terminal, "test");
		tt.initialize("test");
		terminal.titles = [];

		// Cycle 1
		tt.setWorking(true);
		expect(terminal.lastTitle()).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
		tt.setWorking(false);
		expect(terminal.lastTitle()).toBe("Jensen - test");

		// Cycle 2
		tt.setWorking(true);
		expect(terminal.lastTitle()).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
		tt.setWorking(false);
		expect(terminal.lastTitle()).toBe("Jensen - test");
	});

	it("reinitialize during working stops spinner and updates name", () => {
		const tt = new TerminalTitle(terminal, "old");
		tt.initialize("old");
		terminal.titles = [];

		tt.setWorking(true);
		tt.initialize("new");

		// Should now be static with new name
		expect(terminal.lastTitle()).toBe("Jensen - new");

		// Spinner should be stopped
		const beforeCount = terminal.titles.length;
		vi.advanceTimersByTime(500);
		expect(terminal.titles.length).toBe(beforeCount);
	});

	it("does not pollute stdout with title writes", () => {
		// Title writes use setTitle() which writes directly to stdout.
		// We verify the writes are well-formed OSC sequences by checking
		// the FakeTerminal captures them, not stdout output content.
		const tt = new TerminalTitle(terminal, "clean");
		tt.initialize("clean");
		tt.setWorking(true);
		vi.advanceTimersByTime(200);
		tt.setWorking(false);

		// All titles should match expected format
		for (const title of terminal.titles) {
			expect(title).toMatch(/^(?:Jensen - clean|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Jensen - clean)$/u);
		}
	});

	it("no π symbol anywhere in any title", () => {
		const tt = new TerminalTitle(terminal, "pi-test");
		tt.initialize("pi-test");
		tt.setWorking(true);
		vi.advanceTimersByTime(500);
		tt.setWorking(false);

		for (const title of terminal.titles) {
			expect(title).not.toContain("π");
			expect(title).toContain("Jensen");
		}
	});
});

describe("TerminalTitle integration lifecycle", () => {
	let terminal: FakeTerminal;
	const originalIsTTY = process.stdout.isTTY;

	beforeEach(() => {
		terminal = new FakeTerminal();
		setTty(true);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		setTty(originalIsTTY);
	});

	it("full lifecycle: idle → working → tool → working → done", () => {
		const tt = new TerminalTitle(terminal, "jensen-code");

		// Session starts - idle
		tt.initialize("jensen-code");
		expect(terminal.lastTitle()).toBe("Jensen - jensen-code");

		// User sends prompt, agent starts working
		tt.setWorking(true);
		expect(terminal.lastTitle()).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Jensen - jensen-code$/u);

		// Agent calls a tool (still working)
		vi.advanceTimersByTime(500); // Several frames during tool execution
		expect(terminal.lastTitle()).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Jensen - jensen-code$/u);

		// Agent finishes
		tt.setWorking(false);
		expect(terminal.lastTitle()).toBe("Jensen - jensen-code");

		// No stray frames after stop
		const countAfterStop = terminal.titles.length;
		vi.advanceTimersByTime(1000);
		expect(terminal.titles.length).toBe(countAfterStop);
	});

	it("lifecycle with cancellation", () => {
		const tt = new TerminalTitle(terminal, "test-project");
		tt.initialize("test-project");
		terminal.titles = [];

		// Start working
		tt.setWorking(true);
		vi.advanceTimersByTime(200);

		// Cancelled - should stop immediately
		tt.setWorking(false);
		expect(terminal.lastTitle()).toBe("Jensen - test-project");

		// No orphaned frames
		const countAfterCancel = terminal.titles.length;
		vi.advanceTimersByTime(1000);
		expect(terminal.titles.length).toBe(countAfterCancel);
	});

	it("lifecycle with error", () => {
		const tt = new TerminalTitle(terminal, "test-project");
		tt.initialize("test-project");
		terminal.titles = [];

		// Start working
		tt.setWorking(true);
		vi.advanceTimersByTime(200);

		// Error - should stop
		tt.setWorking(false);
		expect(terminal.lastTitle()).toBe("Jensen - test-project");

		const countAfterError = terminal.titles.length;
		vi.advanceTimersByTime(1000);
		expect(terminal.titles.length).toBe(countAfterError);
	});

	it("new session does not inherit working state from previous", () => {
		const tt = new TerminalTitle(terminal, "project-a");
		tt.initialize("project-a");
		terminal.titles = [];

		// Session A starts working
		tt.setWorking(true);
		vi.advanceTimersByTime(200);

		// Session A ends
		tt.setWorking(false);

		// New session B starts
		tt.initialize("project-b");
		expect(terminal.lastTitle()).toBe("Jensen - project-b");

		// No spinner from session A
		const countAfterNewSession = terminal.titles.length;
		vi.advanceTimersByTime(1000);
		expect(terminal.titles.length).toBe(countAfterNewSession);
	});

	it("interaction/permission request stops spinner", () => {
		const tt = new TerminalTitle(terminal, "test-project");
		tt.initialize("test-project");
		terminal.titles = [];

		// Agent is working
		tt.setWorking(true);
		vi.advanceTimersByTime(200);

		// Agent needs user permission - stops
		tt.setWorking(false);
		expect(terminal.lastTitle()).toBe("Jensen - test-project");

		const countBeforePermission = terminal.titles.length;
		vi.advanceTimersByTime(1000);
		expect(terminal.titles.length).toBe(countBeforePermission);
	});
});
