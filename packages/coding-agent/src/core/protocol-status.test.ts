import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatProtocolStatusOutput, getProtocolWorkspaceStatus } from "./protocol-status.js";

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), "jensen-protocol-status-"));
}

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
}

const tempDirs: string[] = [];

describe("protocol status", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports the nearest Protocol marker and loaded context path", () => {
		const rootDir = createTempDir();
		tempDirs.push(rootDir);

		const repoDir = join(rootDir, "repo");
		const nestedWorkspaceDir = join(repoDir, "apps", "nested");
		const appDir = join(nestedWorkspaceDir, "service");
		const repoMarkerPath = join(repoDir, ".jensen", "JENSEN_PROTOCOL.md");
		const nestedMarkerPath = join(nestedWorkspaceDir, ".jensen", "JENSEN_PROTOCOL.md");

		writeFile(repoMarkerPath, "repo protocol\n");
		writeFile(nestedMarkerPath, "nested protocol\n");
		mkdirSync(appDir, { recursive: true });

		const status = getProtocolWorkspaceStatus({
			cwd: appDir,
			resourceLoader: {
				getAgentsFiles: () => ({
					agentsFiles: [{ path: nestedMarkerPath, content: "nested protocol\n" }],
				}),
			},
		});

		expect(status).toEqual({
			markerDetected: true,
			markerPath: nestedMarkerPath,
			workspaceRoot: nestedWorkspaceDir,
			contextAvailable: true,
			contextPath: nestedMarkerPath,
		});

		const output = formatProtocolStatusOutput(status);
		expect(output).toContain("Protocol workspace marker: detected");
		expect(output).toContain(`Effective marker file: ${nestedMarkerPath}`);
		expect(output).toContain(`Workspace root: ${nestedWorkspaceDir}`);
		expect(output).toContain("Protocol context in harness: available");
	});

	it("reports when a Protocol marker exists on disk but is not loaded in harness context", () => {
		const rootDir = createTempDir();
		tempDirs.push(rootDir);

		const workspaceDir = join(rootDir, "workspace");
		const appDir = join(workspaceDir, "app");
		const markerPath = join(workspaceDir, ".jensen", "JENSEN_PROTOCOL.md");

		writeFile(markerPath, "protocol\n");
		mkdirSync(appDir, { recursive: true });

		const status = getProtocolWorkspaceStatus({
			cwd: appDir,
			resourceLoader: {
				getAgentsFiles: () => ({
					agentsFiles: [],
				}),
			},
		});

		expect(status.contextAvailable).toBe(false);
		expect(status.contextPath).toBeUndefined();
		expect(formatProtocolStatusOutput(status)).toContain(
			"Note: a Protocol marker exists on disk, but it is not currently loaded through the resource-loader context seam.",
		);
	});

	it("reports non-Protocol workspaces honestly", () => {
		const rootDir = createTempDir();
		tempDirs.push(rootDir);

		const appDir = join(rootDir, "repo", "app");
		mkdirSync(appDir, { recursive: true });

		const status = getProtocolWorkspaceStatus({
			cwd: appDir,
			resourceLoader: {
				getAgentsFiles: () => ({
					agentsFiles: [],
				}),
			},
		});

		expect(status).toEqual({
			markerDetected: false,
			markerPath: undefined,
			workspaceRoot: undefined,
			contextAvailable: false,
			contextPath: undefined,
		});

		const output = formatProtocolStatusOutput(status);
		expect(output).toContain("Protocol workspace marker: not detected");
		expect(output).toContain("Effective marker file: none");
		expect(output).toContain("Workspace root: none");
		expect(output).toContain("Protocol context in harness: unavailable");
	});
});
