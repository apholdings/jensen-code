import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";

export const PROTOCOL_CONTEXT_FILE = "JENSEN_PROTOCOL.md";

export interface ProtocolStatusResourceLoader {
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
}

export interface ProtocolWorkspaceStatus {
	markerDetected: boolean;
	markerPath?: string;
	workspaceRoot?: string;
	contextAvailable: boolean;
	contextPath?: string;
}

export function findNearestProtocolContextFile(cwd: string): string | undefined {
	let currentDir = resolve(cwd);
	const root = resolve("/");

	while (true) {
		const protocolContextPath = join(currentDir, CONFIG_DIR_NAME, PROTOCOL_CONTEXT_FILE);
		if (existsSync(protocolContextPath)) {
			return protocolContextPath;
		}

		if (currentDir === root) {
			return undefined;
		}

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) {
			return undefined;
		}
		currentDir = parentDir;
	}
}

function findLoadedProtocolContextPath(resourceLoader?: ProtocolStatusResourceLoader): string | undefined {
	if (!resourceLoader) {
		return undefined;
	}

	const agentsFiles = resourceLoader.getAgentsFiles().agentsFiles;
	for (let index = agentsFiles.length - 1; index >= 0; index -= 1) {
		const file = agentsFiles[index];
		if (file?.path.endsWith(join(CONFIG_DIR_NAME, PROTOCOL_CONTEXT_FILE))) {
			return file.path;
		}
	}

	return undefined;
}

export function getProtocolWorkspaceStatus(options: {
	cwd: string;
	resourceLoader?: ProtocolStatusResourceLoader;
}): ProtocolWorkspaceStatus {
	const markerPath = findNearestProtocolContextFile(options.cwd);
	const contextPath = findLoadedProtocolContextPath(options.resourceLoader);

	return {
		markerDetected: markerPath !== undefined,
		markerPath,
		workspaceRoot: markerPath ? dirname(dirname(markerPath)) : undefined,
		contextAvailable: markerPath !== undefined && contextPath === markerPath,
		contextPath,
	};
}

export function formatProtocolStatusOutput(status: ProtocolWorkspaceStatus): string {
	const lines = ["Protocol status", ""];

	lines.push(`Protocol workspace marker: ${status.markerDetected ? "detected" : "not detected"}`);
	lines.push(`Effective marker file: ${status.markerPath ?? "none"}`);
	lines.push(`Workspace root: ${status.workspaceRoot ?? "none"}`);
	lines.push(`Protocol context in harness: ${status.contextAvailable ? "available" : "unavailable"}`);
	lines.push(`Loaded context file: ${status.contextPath ?? "none"}`);

	if (status.markerDetected && !status.contextAvailable) {
		lines.push("");
		lines.push(
			"Note: a Protocol marker exists on disk, but it is not currently loaded through the resource-loader context seam.",
		);
	}

	return lines.join("\n");
}
