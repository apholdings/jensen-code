/**
 * Remote Execution — CLI (2.14.0).
 *
 * `jensen remote register|probe|status|list`
 *
 * Operator surface for the remote target catalog + reachability. It never
 * exposes an unrestricted remote shell; authoritative execution stays on the
 * Mission → Assignment → Worker path.
 */

import chalk from "chalk";
import { createFileRemoteTargetRegistry } from "./file-remote-target-registry.js";
import { RemoteTargetRegistry } from "./remote-target-registry.js";
import type { RemoteExecutionTarget } from "./remote-target-types.js";
import { SshRemoteExecutionTransport } from "./ssh-transport.js";

function flagValue(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function renderError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${chalk.red(message)}\n`);
}

export function printRemoteUsage(): string {
	return [
		"  remote register --target-id <ID> --host <HOST> --user <USER> --platform windows|linux|macos --arch x64|arm64 [--temp-root <DIR>]",
		"  remote probe <TARGET_ID> [--json]",
		"  remote status <TARGET_ID> [--json]",
		"  remote list [--json]",
	].join("\n");
}

export async function handleRemoteCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "remote") return false;
	const sub = args[1];
	const json = args.includes("--json");
	const registry = new RemoteTargetRegistry({
		store: createFileRemoteTargetRegistry(),
		transport: new SshRemoteExecutionTransport(),
	});

	try {
		switch (sub) {
			case "register": {
				const targetId = flagValue(args, "--target-id");
				const host = flagValue(args, "--host");
				const user = flagValue(args, "--user");
				const platform = flagValue(args, "--platform");
				const arch = flagValue(args, "--arch");
				const tempRoot = flagValue(args, "--temp-root");
				if (!targetId || !host || !user || !platform || !arch) {
					process.stderr.write("remote register requires --target-id, --host, --user, --platform, --arch\n");
					process.exitCode = 1;
					return true;
				}
				const target: RemoteExecutionTarget = {
					targetId,
					transport: "ssh",
					host,
					user,
					platform: platform as RemoteExecutionTarget["platform"],
					arch: arch as RemoteExecutionTarget["arch"],
					connection: { remoteTempRoot: tempRoot },
				};
				const registered = await registry.register(target);
				if (json) printJson({ status: "registered", target: registered });
				else process.stdout.write(`registered remote target ${registered.targetId}\n`);
				return true;
			}

			case "probe":
			case "status": {
				const targetId = args[2];
				if (!targetId) {
					process.stderr.write(`remote ${sub} requires <TARGET_ID>\n`);
					process.exitCode = 1;
					return true;
				}
				const health = await registry.probe(targetId);
				if (json) printJson(health);
				else {
					process.stdout.write(
						`${health.targetId}  [${health.status}]${health.remoteHost ? ` host=${health.remoteHost}` : ""}${health.remoteUser ? ` user=${health.remoteUser}` : ""}\n`,
					);
					if (health.summary) process.stdout.write(`  ${health.summary}\n`);
				}
				return true;
			}

			case "list": {
				const result = await registry.list();
				if (json) printJson(result);
				else {
					if (result.entries.length === 0 && result.corrupt.length === 0) {
						process.stdout.write("(no remote targets)\n");
					}
					for (const target of result.entries) {
						process.stdout.write(
							`${target.targetId}  ${target.user}@${target.host}  ${target.platform}/${target.arch}\n`,
						);
					}
					for (const corrupt of result.corrupt) {
						process.stdout.write(chalk.yellow(`${corrupt.targetId}  [CORRUPT] ${corrupt.diagnostic}\n`));
					}
				}
				return true;
			}

			default:
				return false;
		}
	} catch (error) {
		renderError(error);
		process.exitCode = 1;
		return true;
	}
}
