import { readFile } from "node:fs/promises";

/**
 * Process-identity primitives for authoritative job ownership and PID-reuse
 * protection. Ownership must NEVER rely on PID alone.
 */

export interface ProcessIdentityInfo {
	pid: number;
	/** Command line (cmdline joined with spaces). */
	commandLine: string;
	/** Start identity: epoch seconds (POSIX) or creation timestamp (Windows). */
	startIdentity?: number;
	alive: boolean;
}

function linuxCmdline(pid: number): string | null {
	try {
		// Node's fs.realpathSync may choke; use readlink on /proc.
		return require("node:fs").readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ").trim() || null;
	} catch {
		return null;
	}
}

function linuxStartTicks(pid: number): number | null {
	try {
		const stat = require("node:fs").readFileSync(`/proc/${pid}/stat`, "utf-8");
		// field 22 (after comm in parentheses) is starttime in clock ticks.
		const idx = stat.lastIndexOf(")");
		if (idx < 0) return null;
		const fields = stat.slice(idx + 2).split(" ");
		const starttime = Number(fields[19]); // 0-indexed: field 22 -> index 21, minus comm shift
		return Number.isFinite(starttime) ? starttime : null;
	} catch {
		return null;
	}
}

const psCmdline: { pid: number; cmdline: string }[] = [];
let psLoaded = false;

function loadPsSnapshot(): void {
	if (psLoaded) return;
	psLoaded = true;
	try {
		const out = require("node:child_process").execFileSync("ps", ["-eo", "pid=,args="], {
			encoding: "utf-8",
			timeout: 3000,
		});
		psCmdline.length = 0;
		for (const line of out.split("\n")) {
			const m = line.match(/^\s*(\d+)\s+(.*)$/);
			if (m) psCmdline.push({ pid: Number(m[1]), cmdline: m[2] });
		}
	} catch {
		// ps unavailable
	}
}

function posixIdentity(pid: number): ProcessIdentityInfo {
	const alive = require("node:fs").existsSync(`/proc/${pid}`) || isAlivePosixFallback(pid);
	const cmdline =
		linuxCmdline(pid) ??
		(() => {
			loadPsSnapshot();
			return psCmdline.find((p) => p.pid === pid)?.cmdline ?? null;
		})();
	return { pid, commandLine: cmdline ?? "", startIdentity: linuxStartTicks(pid) ?? undefined, alive };
}

function isAlivePosixFallback(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function windowsIdentity(pid: number): ProcessIdentityInfo {
	let alive = false;
	let commandLine = "";
	let startIdentity: number | undefined;
	try {
		const out = require("node:child_process").execFileSync(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { "ALIVE|" + $p.CommandLine + "|" + $p.CreationDate }`,
			],
			{ encoding: "utf-8", timeout: 4000, windowsHide: true },
		);
		const parts = out.trim().split("|");
		if (parts[0] === "ALIVE") {
			alive = true;
			commandLine = parts[1] ?? "";
			const created = Date.parse(parts[2] ?? "");
			if (!Number.isNaN(created)) startIdentity = created;
		}
	} catch {
		// fall through: alive=false
	}
	return { pid, commandLine, startIdentity, alive };
}

/**
 * Read authoritative identity for a PID on the current platform. Never trusts
 * PID alone.
 */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentityInfo> {
	try {
		if (isWindowsPlatform()) return windowsIdentity(pid);
		return posixIdentity(pid);
	} catch {
		return { pid, commandLine: "", alive: false };
	}
}

export function isWindowsPlatform(): boolean {
	return process.platform === "win32";
}

/** Verify a live PID matches a recorded identity (executable + start time). */
export function identityMatches(
	live: ProcessIdentityInfo,
	expected: { commandIdentity?: string; processStartIdentity?: number },
): { match: boolean; reason?: string } {
	if (!live.alive) return { match: false, reason: "process_not_alive" };
	if (expected.processStartIdentity !== undefined && live.startIdentity !== undefined) {
		if (live.startIdentity !== expected.processStartIdentity) {
			return { match: false, reason: "pid_reuse_start_identity_mismatch" };
		}
	}
	if (expected.commandIdentity) {
		// commandIdentity is the (sanitized) executable+args; verify the live
		// cmdline contains the executable as its first token.
		const firstToken = expected.commandIdentity.split(/\s+/)[0];
		if (firstToken && live.commandLine) {
			if (!live.commandLine.includes(firstToken) && !live.commandLine.includes(basename(firstToken))) {
				return { match: false, reason: "command_identity_mismatch" };
			}
		}
	}
	return { match: true };
}

function basename(p: string): string {
	const parts = p.split(/[\\/]/);
	return parts[parts.length - 1] ?? p;
}

export const readFileUtf8 = (p: string) => readFile(p, "utf-8").catch(() => null);
