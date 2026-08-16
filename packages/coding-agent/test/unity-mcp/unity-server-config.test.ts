/**
 * Unity MCP Vertical Slice — server configuration tests (2.13.0).
 */

import { describe, expect, it } from "vitest";
import {
	buildUnityMcpServerDefinition,
	LOTG_UNITY_TARGET,
	unityRelayCommand,
} from "../../src/core/unity-mcp/unity-server-config.js";

describe("Unity MCP server configuration", () => {
	it("builds a secret-free SSH stdio definition for the LOTG endpoint", () => {
		const definition = buildUnityMcpServerDefinition(LOTG_UNITY_TARGET);

		expect(definition.id).toBe("unity-lotg-blackpearl");
		expect(definition.command).toBe("ssh");
		expect(definition.args).toBeDefined();
		const args = definition.args as string[];
		expect(args).toContain("-T");
		expect(args).toContain("BatchMode=yes");
		expect(args).toContain("sparrow@blackpearl");
		const relay = args[args.length - 1];
		expect(relay).toContain("--mcp");
		expect(relay).toContain("--project-path");
		expect(relay).toContain("light-of-the-galaxy");
		// No credential material is embedded anywhere.
		expect(JSON.stringify(definition)).not.toMatch(/password|secret|token|BEGIN .*KEY/iu);
	});

	it("resolves the Windows username through %USERPROFILE%, not a hardcoded account", () => {
		const relay = unityRelayCommand(LOTG_UNITY_TARGET);
		expect(relay).toContain("%USERPROFILE%");
		expect(relay).not.toContain("C:\\Users\\");
	});

	it("supports explicit editor pid disambiguation", () => {
		const relay = unityRelayCommand({ ...LOTG_UNITY_TARGET, editorPid: 15676 });
		expect(relay).toContain("--instance-id");
		expect(relay).toContain("15676");
	});

	it("rejects an incomplete target", () => {
		expect(() =>
			buildUnityMcpServerDefinition({ serverId: "", sshTarget: "sparrow@blackpearl", unityProjectPath: "D:\\x" }),
		).toThrow(/serverId/);
	});
});
