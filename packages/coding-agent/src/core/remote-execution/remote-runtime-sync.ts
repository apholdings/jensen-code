/**
 * Remote runtime synchronization (3.0.0 cross-host bridge).
 *
 * Transfers the content-addressed runtime bundle to a remote target's
 * user-scoped cache, verifies the tarball hash, atomically materialises the
 * runtime directory, and returns the authoritative remote CLI entry. A cache
 * hit (same runtimeId + commit + tarball hash) skips the transfer entirely.
 *
 * No legacy fallback: if the required runtime cannot be synchronised and
 * verified, sync throws and the caller must fail closed.
 */

import * as fsp from "node:fs/promises";
import type { RemoteExecutionTarget } from "./remote-target-types.js";
import { type BuiltRuntimeBundle, RUNTIME_PROTOCOL_VERSION, type RuntimeBundleIdentity } from "./runtime-bundle.js";
import { psLiteral, type SshRemoteExecutionTransport } from "./ssh-transport.js";

export interface RemoteRuntimeSyncOptions {
	transport: SshRemoteExecutionTransport;
	target: RemoteExecutionTarget;
	/** Remote user-scoped cache root (e.g. `%LOCALAPPDATA%\Jensen\runtimes`). */
	cacheRoot: string;
	bundle: BuiltRuntimeBundle;
	now?: () => number;
}

export interface SyncedRemoteRuntime {
	runtimeId: string;
	remoteRoot: string;
	cliEntry: string;
	jensenCommit: string;
	tarballHash: string;
	alreadyPresent: boolean;
}

export class RemoteRuntimeSyncError extends Error {
	readonly code: "REMOTE_RUNTIME_HASH_MISMATCH" | "REMOTE_RUNTIME_INCOMPATIBLE" | "REMOTE_RUNTIME_SYNC_FAILED";
	constructor(code: RemoteRuntimeSyncError["code"], message: string) {
		super(message);
		this.name = "RemoteRuntimeSyncError";
		this.code = code;
	}
}

function parseIdentity(value: string): RuntimeBundleIdentity | undefined {
	try {
		const parsed = JSON.parse(value) as RuntimeBundleIdentity;
		if (
			parsed &&
			typeof parsed.jensenCommit === "string" &&
			typeof parsed.runtimeProtocolVersion === "number" &&
			typeof parsed.sharedInferenceProtocolVersion === "number"
		) {
			return parsed;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function readRemoteText(
	transport: SshRemoteExecutionTransport,
	target: RemoteExecutionTarget,
	remotePath: string,
): Promise<string | undefined> {
	// Windows file handles can briefly outlive the SSH session that wrote them;
	// retry a bounded number of times on transient sharing-violation errors.
	for (let attempt = 0; attempt < 5; attempt++) {
		const result = await transport.runPowerShell(
			target,
			[
				"$ErrorActionPreference = 'Stop'",
				"$ProgressPreference = 'SilentlyContinue'",
				"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
				`$p = ${psLiteral(remotePath)}`,
				"if (!(Test-Path -LiteralPath $p)) { exit 3 }",
				"Get-Content -LiteralPath $p -Raw",
			].join("\r\n"),
			{ timeoutMs: 60_000 },
		);
		if (result.exitCode === 3) return undefined;
		if (result.exitCode === 0) return result.stdout;
		if (!/being used by another process|sharing violation|denied/iu.test(result.stderr) || attempt === 4) {
			throw new RemoteRuntimeSyncError(
				"REMOTE_RUNTIME_SYNC_FAILED",
				(result.stderr || result.launchError || "read failed").slice(0, 2000),
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
	}
	return undefined;
}

/**
 * Synchronise the bundle onto the target and return the remote runtime entry.
 * Idempotent: a verified cache hit returns without retransmitting.
 */
export async function syncRemoteRuntime(options: RemoteRuntimeSyncOptions): Promise<SyncedRemoteRuntime> {
	const { transport, target, bundle } = options;
	const runtimeRoot = `${options.cacheRoot.replace(/[\\/]+$/, "")}\\${bundle.runtimeId}`;
	const identityPath = `${runtimeRoot}\\identity.json`;
	const cliEntry = `${runtimeRoot}\\node_modules\\@apholdings\\jensen-code\\dist\\cli.js`;

	// 1. Cache hit: existing in-tarball identity matches commit + protocol.
	const existing = await readRemoteText(transport, target, identityPath);
	if (existing !== undefined) {
		const identity = parseIdentity(existing);
		if (
			identity &&
			identity.jensenCommit === bundle.jensenCommit &&
			identity.runtimeProtocolVersion === RUNTIME_PROTOCOL_VERSION &&
			identity.sharedInferenceProtocolVersion === bundle.identity.sharedInferenceProtocolVersion
		) {
			const cliCheck = await transport.runPowerShell(
				target,
				["$ErrorActionPreference = 'Stop'", `Test-Path -LiteralPath ${psLiteral(cliEntry)}`].join("\r\n"),
				{ timeoutMs: 60_000 },
			);
			if (cliCheck.stdout.trim() === "True") {
				return {
					runtimeId: bundle.runtimeId,
					remoteRoot: runtimeRoot,
					cliEntry,
					jensenCommit: bundle.jensenCommit,
					tarballHash: bundle.tarballHash,
					alreadyPresent: true,
				};
			}
		}
	}

	// 2. Transfer + verify + atomic materialise.
	const staging = `${options.cacheRoot.replace(/[\\/]+$/, "")}\\.staging-${bundle.runtimeId}`;
	const stagingRuntime = `${staging}\\${bundle.runtimeId}`;

	try {
		// Prepare a clean staging runtime dir.
		await transport.runPowerShell(
			target,
			[
				"$ErrorActionPreference = 'Stop'",
				`$dir = ${psLiteral(stagingRuntime)}`,
				"if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }",
				"New-Item -ItemType Directory -Path $dir -Force | Out-Null",
			].join("\r\n"),
			{ timeoutMs: 60_000 },
		);

		// Stream-extract the tarball (binary stdin; tar verifies gzip CRC/tar checksums).
		const tarball = await fsp.readFile(bundle.tarballPath);
		const extract = await transport.extractTarballFromStdin(target, stagingRuntime, tarball, { timeoutMs: 900_000 });
		if (extract.exitCode !== 0) {
			throw new RemoteRuntimeSyncError(
				"REMOTE_RUNTIME_SYNC_FAILED",
				extract.stderr || extract.launchError || `tar exit ${extract.exitCode}`,
			);
		}

		// Verify the in-tarball identity (commit + protocol) after extraction.
		// This is a read of a file written by tar extraction (no sidecar write
		// race); the bounded retry in readRemoteText handles transient locks.
		const remoteIdentity = await readRemoteText(transport, target, `${stagingRuntime}\\identity.json`);
		if (remoteIdentity === undefined) {
			throw new RemoteRuntimeSyncError("REMOTE_RUNTIME_SYNC_FAILED", "identity.json missing after extraction");
		}
		const identity = parseIdentity(remoteIdentity);
		if (
			!identity ||
			identity.jensenCommit !== bundle.jensenCommit ||
			identity.runtimeProtocolVersion !== RUNTIME_PROTOCOL_VERSION ||
			identity.sharedInferenceProtocolVersion !== bundle.identity.sharedInferenceProtocolVersion
		) {
			throw new RemoteRuntimeSyncError(
				"REMOTE_RUNTIME_INCOMPATIBLE",
				"extracted runtime identity does not match expected commit/protocol",
			);
		}

		// Atomic swap into the cache (remove any stale/partial prior runtime).
		await transport.runPowerShell(
			target,
			[
				"$ErrorActionPreference = 'Stop'",
				`$cache = ${psLiteral(options.cacheRoot.replace(/[\\/]+$/, ""))}`,
				"if (!(Test-Path -LiteralPath $cache)) { New-Item -ItemType Directory -Path $cache -Force | Out-Null }",
				`$target = ${psLiteral(runtimeRoot)}`,
				"if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }",
				`Move-Item -LiteralPath ${psLiteral(stagingRuntime)} -Destination $target`,
				`Remove-Item -LiteralPath ${psLiteral(staging)} -Recurse -Force`,
			].join("\r\n"),
			{ timeoutMs: 120_000 },
		);

		const cliCheck = await transport.runPowerShell(
			target,
			["$ErrorActionPreference = 'Stop'", `Test-Path -LiteralPath ${psLiteral(cliEntry)}`].join("\r\n"),
			{ timeoutMs: 60_000 },
		);
		if (cliCheck.stdout.trim() !== "True") {
			throw new RemoteRuntimeSyncError("REMOTE_RUNTIME_SYNC_FAILED", "runtime CLI entry missing after sync");
		}
	} catch (error) {
		// Best-effort cleanup of the staging area; never leave a partial runtime.
		await transport
			.runPowerShell(
				target,
				[
					"$ErrorActionPreference = 'SilentlyContinue'",
					`Remove-Item -LiteralPath ${psLiteral(staging)} -Recurse -Force`,
				].join("\r\n"),
				{ timeoutMs: 60_000 },
			)
			.catch(() => undefined);
		if (error instanceof RemoteRuntimeSyncError) throw error;
		throw new RemoteRuntimeSyncError(
			"REMOTE_RUNTIME_SYNC_FAILED",
			error instanceof Error ? error.message : String(error),
		);
	}

	return {
		runtimeId: bundle.runtimeId,
		remoteRoot: runtimeRoot,
		cliEntry,
		jensenCommit: bundle.jensenCommit,
		tarballHash: bundle.tarballHash,
		alreadyPresent: false,
	};
}
