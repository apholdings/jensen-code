/**
 * Terminal title manager with animated working indicator.
 *
 * Provides a centralized controller for terminal window/tab titles.
 * - Static title: "Jensen - <workspace>"
 * - Working title: "<spinner> Jensen - <workspace>" with animated braille spinner
 *
 * The spinner is active during agent work cycles and stops when the agent
 * is idle, waiting for user input, cancelled, or errored.
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Interval between spinner frame updates in milliseconds */
const SPINNER_INTERVAL_MS = 100;

/**
 * Minimal terminal interface for title operations.
 * Accepts any object with a setTitle method.
 */
export interface TitleTerminal {
	setTitle(title: string): void;
}

/**
 * Manages the terminal window/tab title with optional animated spinner.
 *
 * Thread-safe and idempotent:
 * - Multiple setWorking(true) calls create at most one animation interval
 * - setWorking(false) is safe to call repeatedly
 * - dispose() cleans up all timers and prevents further writes
 * - Graceful no-op when stdout is not a TTY
 */
export class TerminalTitle {
	private workspaceName: string;
	private terminal: TitleTerminal;
	private spinnerIndex = 0;
	private spinnerInterval: ReturnType<typeof setInterval> | undefined;
	private isWorking = false;
	private isDisposed = false;
	private isTty: boolean;

	constructor(terminal: TitleTerminal, workspaceName: string) {
		this.terminal = terminal;
		this.workspaceName = workspaceName;
		this.isTty = process.stdout.isTTY === true;
	}

	/**
	 * Set the initial static title.
	 * Safe to call multiple times — overwrites the workspace name and resets to static title.
	 * If a spinner is active, it is stopped first.
	 */
	initialize(workspaceName: string): void {
		this.workspaceName = workspaceName;
		this.isWorking = false;
		this.stopSpinner();
		this.writeStatic();
	}

	/**
	 * Enable or disable the animated spinner.
	 * When active, the title cycles through spinner frames.
	 * When inactive, reverts to the static title.
	 */
	setWorking(active: boolean): void {
		if (this.isDisposed) return;

		if (active) {
			if (this.isWorking) return; // Already working, no-op
			this.isWorking = true;
			this.startSpinner();
		} else {
			if (!this.isWorking) return; // Already idle, no-op
			this.isWorking = false;
			this.stopSpinner();
			this.writeStatic();
		}
	}

	/**
	 * Stop the spinner and prevent any further title writes.
	 * Safe to call multiple times.
	 */
	dispose(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		this.isWorking = false;
		this.stopSpinner();
		// Deliberately do NOT restore the title on dispose —
		// the terminal session is ending and the title will be reclaimed by the shell.
	}

	/**
	 * Immediately write the static title to the terminal.
	 */
	private writeStatic(): void {
		if (!this.isTty || this.isDisposed) return;
		const title = `Jensen - ${this.workspaceName}`;
		this.writeTitle(title);
	}

	/**
	 * Write the current spinner frame to the terminal title.
	 */
	private writeSpinnerFrame(): void {
		if (!this.isTty || this.isDisposed || !this.isWorking) return;
		const frame = SPINNER_FRAMES[this.spinnerIndex];
		this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
		const title = `${frame} Jensen - ${this.workspaceName}`;
		this.writeTitle(title);
	}

	/**
	 * Write a title to the terminal using OSC sequence.
	 */
	private writeTitle(title: string): void {
		try {
			this.terminal.setTitle(title);
		} catch {
			// Terminal writes may fail if the fd is closed; ignore
		}
	}

	private startSpinner(): void {
		if (this.spinnerInterval !== undefined) return; // Already running
		// Write first frame immediately
		this.writeSpinnerFrame();
		this.spinnerInterval = setInterval(() => {
			this.writeSpinnerFrame();
		}, SPINNER_INTERVAL_MS);
		// Don't let the interval keep the process alive
		if (this.spinnerInterval && typeof this.spinnerInterval === "object" && "unref" in this.spinnerInterval) {
			this.spinnerInterval.unref();
		}
	}

	private stopSpinner(): void {
		if (this.spinnerInterval !== undefined) {
			clearInterval(this.spinnerInterval);
			this.spinnerInterval = undefined;
		}
		this.spinnerIndex = 0;
	}
}
