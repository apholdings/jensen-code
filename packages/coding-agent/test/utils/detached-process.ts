import type { ChildProcess } from "node:child_process";

export interface ChildExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

export interface TerminationResult extends ChildExit {
	forced: boolean;
	usedProcessGroup: boolean;
	signalErrors: string[];
}

const terminations = new WeakMap<ChildProcess, Promise<TerminationResult>>();

function alreadyExited(child: ChildProcess): ChildExit | undefined {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode };
	}
	return undefined;
}

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<ChildExit> {
	const exited = alreadyExited(child);
	if (exited) return Promise.resolve(exited);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`timeout waiting for child pid ${child.pid ?? "unknown"} to exit`));
		}, timeoutMs);
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			resolve({ code, signal });
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			clearTimeout(timer);
			child.off("exit", onExit);
			child.off("error", onError);
		};
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): { usedProcessGroup: boolean; errors: string[] } {
	const errors: string[] = [];
	if (child.pid && process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
			return { usedProcessGroup: true, errors };
		} catch (error) {
			if (errorCode(error) !== "ESRCH")
				errors.push(`process-group ${signal}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	try {
		child.kill(signal);
	} catch (error) {
		if (errorCode(error) !== "ESRCH")
			errors.push(`child ${signal}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { usedProcessGroup: false, errors };
}

async function waitForProcessGroupGone(pid: number | undefined, timeoutMs: number): Promise<void> {
	if (process.platform === "win32" || !pid) return;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			process.kill(-pid, 0);
		} catch (error) {
			if (errorCode(error) === "ESRCH") return;
			throw error;
		}
		if (Date.now() >= deadline) throw new Error(`timeout waiting for process group ${pid} to exit`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export function terminateDetached(
	child: ChildProcess,
	options: { gracefulTimeoutMs?: number; forceTimeoutMs?: number; signal?: NodeJS.Signals } = {},
): Promise<TerminationResult> {
	const existing = terminations.get(child);
	if (existing) return existing;
	const promise = (async (): Promise<TerminationResult> => {
		const initial = alreadyExited(child);
		const signal = options.signal ?? "SIGTERM";
		const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 250;
		const forceTimeoutMs = options.forceTimeoutMs ?? 1000;
		let forced = false;
		let usedProcessGroup = false;
		let signalErrors: string[] = [];
		let exited = initial;

		if (!exited) {
			const firstSignal = signalChild(child, signal);
			usedProcessGroup ||= firstSignal.usedProcessGroup;
			signalErrors = [...signalErrors, ...firstSignal.errors];
			try {
				exited = await waitForChildExit(child, gracefulTimeoutMs);
			} catch {
				forced = true;
				const forceSignal = signalChild(child, "SIGKILL");
				usedProcessGroup ||= forceSignal.usedProcessGroup;
				signalErrors = [...signalErrors, ...forceSignal.errors];
				exited = await waitForChildExit(child, forceTimeoutMs);
			}
		}

		// The wrapper may exit before a descendant. Re-signal the owned Unix
		// process group and wait for the group itself, not only the leader.
		const groupSignal = signalChild(child, "SIGKILL");
		usedProcessGroup ||= groupSignal.usedProcessGroup;
		signalErrors = [...signalErrors, ...groupSignal.errors];
		try {
			await waitForProcessGroupGone(child.pid, forceTimeoutMs);
		} catch (error) {
			throw new Error(
				`bounded child cleanup timed out for pid ${child.pid ?? "unknown"}; ${
					error instanceof Error ? error.message : String(error)
				}; signal errors: ${signalErrors.join(" | ") || "none"}`,
			);
		}
		if (!exited) throw new Error(`child pid ${child.pid ?? "unknown"} exited without an exit result`);
		return { ...exited, forced, usedProcessGroup, signalErrors };
	})();
	terminations.set(child, promise);
	void promise.catch(() => {
		if (terminations.get(child) === promise) terminations.delete(child);
	});
	return promise;
}
