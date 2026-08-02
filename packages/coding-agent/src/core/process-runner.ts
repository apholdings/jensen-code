import type { ChildProcess } from "node:child_process";

const DEFAULT_DRAIN_TIMEOUT_MS = 250;
const DEFAULT_TERMINATION_TIMEOUT_MS = 2000;

export interface ForegroundProcessRunnerOptions {
	child: ChildProcess;
	onStdout?: (data: Buffer) => void;
	onStderr?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	kill: () => void;
	drainTimeoutMs?: number;
	terminationTimeoutMs?: number;
}

export interface ForegroundProcessResult {
	exitCode: number | null;
}

/**
 * Run a foreground wrapper without making inherited descendant handles part
 * of its lifecycle. The wrapper exit code is authoritative; stdout/stderr
 * receive a short bounded drain, then local read handles are closed.
 */
export function runForegroundProcess(options: ForegroundProcessRunnerOptions): Promise<ForegroundProcessResult> {
	const {
		child,
		onStdout,
		onStderr,
		signal,
		timeout,
		kill,
		drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
		terminationTimeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS,
	} = options;

	return new Promise((resolve, reject) => {
		let settled = false;
		let processExited = false;
		let exitCode: number | null = null;
		let timedOut = false;
		let aborted = signal?.aborted ?? false;
		let drainTimer: NodeJS.Timeout | undefined;
		let terminationTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const clearTimers = () => {
			if (drainTimer) clearTimeout(drainTimer);
			if (terminationTimer) clearTimeout(terminationTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
		};

		const detachStreams = () => {
			const streams = [child.stdout, child.stderr];
			for (const stream of streams) {
				if (!stream) continue;
				stream.removeListener("data", stream === child.stdout ? handleStdout : handleStderr);
				stream.removeListener("end", stream === child.stdout ? handleStdoutEnd : handleStderrEnd);
				stream.removeListener("close", stream === child.stdout ? handleStdoutEnd : handleStderrEnd);
				stream.removeListener("error", stream === child.stdout ? handleStdoutEnd : handleStderrEnd);
				if (!stream.destroyed) stream.destroy();
			}
		};

		const cleanup = () => {
			clearTimers();
			child.removeListener("error", handleChildError);
			child.removeListener("exit", handleChildExit);
			child.removeListener("close", handleChildClose);
			signal?.removeEventListener("abort", handleAbort);
			detachStreams();
		};

		const finish = () => {
			if (settled) return;
			settled = true;
			cleanup();
			if (aborted) {
				reject(new Error("aborted"));
			} else if (timedOut) {
				reject(new Error(`timeout:${timeout}`));
			} else {
				resolve({ exitCode });
			}
		};

		const scheduleNormalFinish = () => {
			if (settled || !processExited) return;
			if (stdoutEnded && stderrEnded) {
				finish();
				return;
			}
			drainTimer = setTimeout(finish, drainTimeoutMs);
		};

		const terminate = () => {
			try {
				kill();
			} catch {
				// Process may have exited between timeout/abort and kill.
			}
			terminationTimer = setTimeout(finish, terminationTimeoutMs);
			if (processExited) finish();
		};

		const handleStdout = (data: Buffer) => onStdout?.(data);
		const handleStderr = (data: Buffer) => onStderr?.(data);
		const handleStdoutEnd = () => {
			stdoutEnded = true;
			scheduleNormalFinish();
		};
		const handleStderrEnd = () => {
			stderrEnded = true;
			scheduleNormalFinish();
		};
		const handleChildError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const handleChildExit = (code: number | null) => {
			processExited = true;
			exitCode = code;
			if (timedOut || aborted) {
				finish();
				return;
			}
			scheduleNormalFinish();
		};
		const handleChildClose = (code: number | null) => {
			if (!processExited) {
				processExited = true;
				exitCode = code;
			}
			if (timedOut || aborted) finish();
			else scheduleNormalFinish();
		};
		const handleAbort = () => {
			if (settled) return;
			aborted = true;
			terminate();
		};

		if (child.stdout) {
			child.stdout.on("data", handleStdout);
			child.stdout.on("end", handleStdoutEnd);
			child.stdout.on("close", handleStdoutEnd);
			child.stdout.on("error", handleStdoutEnd);
		}
		if (child.stderr) {
			child.stderr.on("data", handleStderr);
			child.stderr.on("end", handleStderrEnd);
			child.stderr.on("close", handleStderrEnd);
			child.stderr.on("error", handleStderrEnd);
		}
		child.once("error", handleChildError);
		child.once("exit", handleChildExit);
		child.once("close", handleChildClose);

		if (timeout !== undefined && timeout > 0) {
			timeoutTimer = setTimeout(() => {
				if (settled) return;
				timedOut = true;
				terminate();
			}, timeout * 1000);
		}

		if (signal) {
			if (signal.aborted) handleAbort();
			else signal.addEventListener("abort", handleAbort, { once: true });
		}
	});
}
