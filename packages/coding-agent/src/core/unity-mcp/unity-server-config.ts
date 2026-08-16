/**
 * Unity MCP Vertical Slice — server configuration (2.13.0).
 *
 * Builds a reusable Jensen-side `McpServerDefinition` that reaches the LOTG
 * Unity Editor's MCP relay through non-interactive SSH stdio. The MCP Client
 * Foundation continues to see a normal stdio child process (`ssh`); this module
 * only constructs the safe argv.
 *
 * No secrets are stored. SSH authentication is assumed to already work through
 * the operator's existing key material; the definition never persists
 * credentials. The Windows username is resolved remotely through `%USERPROFILE%`
 * rather than hardcoded.
 */

import type { McpServerDefinition } from "../mcp-foundation/mcp-types.js";
import type { UnityServerTarget } from "./unity-types.js";

/** Canonical LOTG Unity endpoint on Blackpearl. Configurable, not a credential. */
export const LOTG_UNITY_TARGET: UnityServerTarget = Object.freeze({
	serverId: "unity-lotg-blackpearl",
	sshTarget: "sparrow@blackpearl",
	unityProjectPath: "D:\\Documents\\software\\light-of-the-galaxy\\mmo-client",
	relayWindowsPath: "%USERPROFILE%\\.unity\\relay\\relay_win.exe",
});

export const UNITY_DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
export const UNITY_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The remote relay argv string executed by the SSH session's default shell
 * (cmd.exe on the LOTG host). `--mcp` selects MCP stdio mode; `--project-path`
 * targets the exact LOTG project so a multi-project host is never ambiguous.
 */
export function unityRelayCommand(target: UnityServerTarget): string {
	const relay = target.relayWindowsPath ?? "%USERPROFILE%\\.unity\\relay\\relay_win.exe";
	const parts = [`"${relay}"`, "--mcp", "--project-path", `"${target.unityProjectPath}"`];
	if (target.editorPid !== undefined) {
		parts.push("--instance-id", String(target.editorPid));
	}
	return parts.join(" ");
}

/**
 * The official SDK's stdio transport spawns children with a sanitized
 * environment (HOME/PATH/... only) and therefore does NOT forward the
 * operator's ssh-agent socket. `ssh blackpearl` works interactively because the
 * agent key is offered, so the MCP definition must forward `SSH_AUTH_SOCK`
 * explicitly or the SSH child cannot authenticate. The socket path is a
 * non-secret environment value; evidence/argv diagnostics still only ever log
 * env NAMES, never values.
 */
function sshEnvironment(): Record<string, string> | undefined {
	const env: Record<string, string> = {};
	if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
	return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Build a Jensen `McpServerDefinition` for a Unity MCP endpoint carried across
 * SSH stdio. Output is plain, serializable, secret-free configuration.
 */
export function buildUnityMcpServerDefinition(target: UnityServerTarget): McpServerDefinition {
	if (typeof target.serverId !== "string" || target.serverId.length === 0) {
		throw new Error("UnityServerTarget.serverId must be a non-empty string");
	}
	if (typeof target.sshTarget !== "string" || target.sshTarget.length === 0) {
		throw new Error("UnityServerTarget.sshTarget must be a non-empty string");
	}
	if (typeof target.unityProjectPath !== "string" || target.unityProjectPath.length === 0) {
		throw new Error("UnityServerTarget.unityProjectPath must be a non-empty string");
	}

	return {
		id: target.serverId,
		name: "Unity MCP (LOTG)",
		command: "ssh",
		args: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target.sshTarget, unityRelayCommand(target)],
		env: sshEnvironment(),
		startupTimeoutMs: target.startupTimeoutMs ?? UNITY_DEFAULT_STARTUP_TIMEOUT_MS,
		requestTimeoutMs: target.requestTimeoutMs ?? UNITY_DEFAULT_REQUEST_TIMEOUT_MS,
	};
}
