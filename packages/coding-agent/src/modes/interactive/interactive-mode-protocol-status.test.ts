import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@apholdings/jensen-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "./interactive-mode.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "jensen-interactive-protocol-status-"));
	tempDirs.push(dir);
	return dir;
}

describe("InteractiveMode /protocol-status command", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders Protocol marker and context status through the interactive command surface", () => {
		const rootDir = createTempDir();
		const workspaceDir = join(rootDir, "workspace");
		const appDir = join(workspaceDir, "app");
		const markerPath = join(workspaceDir, ".jensen", "JENSEN_PROTOCOL.md");
		mkdirSync(join(workspaceDir, ".jensen"), { recursive: true });
		mkdirSync(appDir, { recursive: true });
		writeFileSync(markerPath, "protocol\n", "utf8");

		const previousCwd = process.cwd();
		process.chdir(appDir);

		try {
			const mode = Object.assign(Object.create(InteractiveMode.prototype), {
				chatContainer: new Container(),
				ui: { requestRender: vi.fn() },
				session: {
					resourceLoader: {
						getAgentsFiles: () => ({ agentsFiles: [{ path: markerPath, content: "protocol\n" }] }),
					},
				},
			}) as unknown as {
				handleProtocolStatusCommand: () => void;
				chatContainer: Container;
			};

			mode.handleProtocolStatusCommand();

			expect(mode.chatContainer.children.at(-1)).toMatchObject({
				text: expect.stringContaining("Protocol workspace marker: detected"),
			});
			expect(mode.chatContainer.children.at(-1)).toMatchObject({
				text: expect.stringContaining(`Effective marker file: ${markerPath}`),
			});
		} finally {
			process.chdir(previousCwd);
		}
	});
});
