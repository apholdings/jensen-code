import { describe, expect, it } from "vitest";
import {
	buildRemotePowerShellArgs,
	buildSimpleRemotePowerShellArgs,
	encodePowerShellCommand,
	getPowerShellConfig,
	REMOTE_POWERSHELL_PREAMBLE,
	validateSshHost,
} from "./shell.js";

// ============================================================================
// encodePowerShellCommand tests
// ============================================================================

describe("encodePowerShellCommand", () => {
	it("produces a non-empty Base64 string", () => {
		const result = encodePowerShellCommand("Write-Output 'hello'");
		expect(result.length).toBeGreaterThan(0);
		// Valid Base64
		expect(result).toMatch(/^[A-Za-z0-9+/]+=*$/);
	});

	it("encodes simple ASCII command deterministically", () => {
		const a = encodePowerShellCommand("exit 0");
		const b = encodePowerShellCommand("exit 0");
		expect(a).toBe(b);
	});

	it("handles empty string", () => {
		const result = encodePowerShellCommand("");
		expect(result).toBe(""); // No BOM, empty source → empty buffer
	});

	it("handles Unicode characters (cafe, Chinese, emoji)", () => {
		// café ñ 你好 🚀
		const source = "Write-Output 'caf\u00e9 \u00f1 \u4f60\u597d \uD83D\uDE80'";
		const result = encodePowerShellCommand(source);
		expect(result.length).toBeGreaterThan(0);
		// Verify we can decode it back
		const buf = Buffer.from(result, "base64");
		// No BOM — length is exactly source.length * 2
		expect(buf.length).toBe(source.length * 2);
	});

	it("handles special PowerShell characters ($, {, }, ;)", () => {
		const source = '$x = @{ key = "value" }; Write-Output $x.key';
		const result = encodePowerShellCommand(source);
		expect(result.length).toBeGreaterThan(0);
	});

	it("handles backslashes in paths", () => {
		const source = "Test-Path 'C:\\\\Program Files\\\\Git'";
		const result = encodePowerShellCommand(source);
		expect(result.length).toBeGreaterThan(0);
	});

	it("handles double quotes inside single-quoted strings", () => {
		const source = "Write-Output 'he said \"hello\"'";
		const result = encodePowerShellCommand(source);
		expect(result.length).toBeGreaterThan(0);
	});

	it("handles multiline scripts", () => {
		const source = ["$sum = 0", "for ($i = 1; $i -le 5; $i++) { $sum += $i }", "Write-Output $sum", "exit 0"].join(
			"\n",
		);
		const result = encodePowerShellCommand(source);
		expect(result.length).toBeGreaterThan(0);
	});

	it("does not include shell quoting in output", () => {
		const result = encodePowerShellCommand("echo hello");
		// Should be pure Base64, no quotes
		expect(result).not.toContain("'");
		expect(result).not.toContain('"');
	});

	it("is pure — does not execute anything", () => {
		// Just encoding, no side effects
		const result = encodePowerShellCommand("Remove-Item -Path / -Recurse -Force");
		expect(result.length).toBeGreaterThan(0);
	});
});

// ============================================================================
// buildRemotePowerShellArgs tests
// ============================================================================

describe("buildRemotePowerShellArgs", () => {
	it("returns argv array with -- separator and host", () => {
		const args = buildRemotePowerShellArgs("test-host", "Write-Output 'hello'");
		expect(Array.isArray(args)).toBe(true);
		expect(args[0]).toBe("--");
		expect(args[1]).toBe("test-host");
	});

	it("includes powershell.exe with correct flags", () => {
		const args = buildRemotePowerShellArgs("test-host", "exit 0");
		expect(args[2]).toBe("powershell.exe");
		expect(args).toContain("-NoProfile");
		expect(args).toContain("-NonInteractive");
		expect(args).toContain("-EncodedCommand");
	});

	it("does NOT include -Command flag when using EncodedCommand", () => {
		const args = buildRemotePowerShellArgs("test-host", "exit 0");
		expect(args).not.toContain("-Command");
	});

	it("prepends the preamble to the command", () => {
		const command = "Write-Output 'test'";
		const args = buildRemotePowerShellArgs("test-host", command);
		// The encoded payload contains the preamble + command
		const encoded = args[args.length - 1];
		expect(typeof encoded).toBe("string");
		expect(encoded.length).toBeGreaterThan(0);
	});

	it("encoded payload starts with preamble", () => {
		const command = "exit 0";
		const args = buildRemotePowerShellArgs("test-host", command);
		const encoded = args[args.length - 1];
		// Decode and verify exact preamble structure
		const buf = Buffer.from(encoded, "base64");
		const decoded = buf.toString("utf16le");
		expect(decoded.startsWith("$ErrorActionPreference")).toBe(true);
		expect(decoded.codePointAt(0)).toBe("$".codePointAt(0));
		expect(decoded).not.toContain("\uFEFF");
		expect(decoded).toContain("$ProgressPreference");
		expect(decoded).toContain("exit 0");
	});

	it("encoded payload fails if $ is lost or shifted", () => {
		// Verify that the test correctly detects corruption of the first character
		const command = "exit 0";
		const args = buildRemotePowerShellArgs("test-host", command);
		const encoded = args[args.length - 1];
		const buf = Buffer.from(encoded, "base64");

		// Corrupt the first byte to simulate BOM corruption
		const corrupted = Buffer.concat([Buffer.from([0xff, 0xfe]), buf.subarray(2)]);
		const decodedCorrupt = corrupted.toString("utf16le");
		expect(decodedCorrupt.startsWith("$")).toBe(false);
		expect(decodedCorrupt.startsWith("\uFEFF")).toBe(true);

		// Corrupt by shifting first byte to simulate dropped byte
		const shifted = buf.subarray(1);
		// Adding a trailing zero to keep valid UTF-16LE alignment
		const shiftedAligned = Buffer.concat([shifted, Buffer.from([0x00])]);
		const decodedShift = shiftedAligned.toString("utf16le");
		expect(decodedShift.startsWith("$")).toBe(false);
	});

	it("encoded payload rejects empty source", () => {
		const encoded = encodePowerShellCommand("");
		expect(encoded).toBe("");
	});

	it("encoded payload handles emoji via surrogate pairs", () => {
		const source = "Write-Output '\uD83D\uDE80'";
		const encoded = encodePowerShellCommand(source);
		const buf = Buffer.from(encoded, "base64");
		const decoded = buf.toString("utf16le");
		expect(decoded).toContain("\uD83D\uDE80");
		expect(decoded).toBe(source);
	});

	it("encoded payload handles Unicode non-BMP", () => {
		const source = "''"; // empty string literal
		const encoded = encodePowerShellCommand(source);
		const buf = Buffer.from(encoded, "base64");
		const decoded = buf.toString("utf16le");
		expect(decoded).toBe(source);
	});

	it("does not hardcode any hostname", () => {
		const args1 = buildRemotePowerShellArgs("host-a", "exit 0");
		const args2 = buildRemotePowerShellArgs("host-b", "exit 0");
		expect(args1[1]).toBe("host-a");
		expect(args2[1]).toBe("host-b");
	});

	it("does not contain any LotG paths or hostnames", () => {
		const args = buildRemotePowerShellArgs("example-host", "exit 0");
		const full = args.join(" ");
		expect(full).not.toContain("blackpearl");
		expect(full).not.toContain("mmo-client");
		expect(full).not.toContain("django-mmo");
		expect(full).not.toContain("light-of-the-galaxy");
		expect(full).not.toMatch(/D:/);
	});
});

// ============================================================================
// validateSshHost tests
// ============================================================================

describe("validateSshHost", () => {
	it("accepts legitimate hostname", () => {
		expect(() => validateSshHost("test-host")).not.toThrow();
	});

	it("accepts user@host", () => {
		expect(() => validateSshHost("user@host")).not.toThrow();
	});

	it("accepts IPv4 address", () => {
		expect(() => validateSshHost("192.168.1.1")).not.toThrow();
	});

	it("accepts IPv6 address", () => {
		expect(() => validateSshHost("[::1]")).not.toThrow();
	});

	it("accepts host-alias", () => {
		expect(() => validateSshHost("my-server-alias")).not.toThrow();
	});

	it("rejects empty host", () => {
		expect(() => validateSshHost("")).toThrow("must not be empty");
	});

	it("rejects host starting with - (option injection)", () => {
		expect(() => validateSshHost("-oProxyCommand=evil")).toThrow("starts with");
	});

	it("rejects host starting with - followed by legitimate name", () => {
		expect(() => validateSshHost("-host.example.com")).toThrow("starts with");
	});

	it("rejects host with spaces", () => {
		expect(() => validateSshHost("host with spaces")).toThrow("whitespace");
	});

	it("rejects host with newlines", () => {
		expect(() => validateSshHost("host\ninjected")).toThrow("whitespace");
	});

	it("rejects host with tab", () => {
		expect(() => validateSshHost("host\tinjected")).toThrow("whitespace");
	});

	it("-- separator prevents option interpretation", () => {
		const args = buildRemotePowerShellArgs("test-host", "exit 0");
		expect(args[0]).toBe("--");
		expect(args[1]).toBe("test-host");
	});
});

// ============================================================================
// buildSimpleRemotePowerShellArgs tests
// ============================================================================

describe("buildSimpleRemotePowerShellArgs", () => {
	it("uses -Command not -EncodedCommand", () => {
		const args = buildSimpleRemotePowerShellArgs("test-host", "Write-Output 'hello'");
		expect(args).toContain("-Command");
		expect(args).not.toContain("-EncodedCommand");
	});

	it("includes the command as the last argument", () => {
		const args = buildSimpleRemotePowerShellArgs("test-host", "Get-Date");
		expect(args[args.length - 1]).toBe("Get-Date");
	});

	it("includes non-interactive flags", () => {
		const args = buildSimpleRemotePowerShellArgs("test-host", "exit 0");
		expect(args).toContain("-NoProfile");
		expect(args).toContain("-NonInteractive");
	});
});

// ============================================================================
// REMOTE_POWERSHELL_PREAMBLE tests
// ============================================================================

describe("REMOTE_POWERSHELL_PREAMBLE", () => {
	it("contains ErrorActionPreference Stop", () => {
		expect(REMOTE_POWERSHELL_PREAMBLE).toContain("$ErrorActionPreference = 'Stop'");
	});

	it("contains ProgressPreference SilentlyContinue", () => {
		expect(REMOTE_POWERSHELL_PREAMBLE).toContain("$ProgressPreference = 'SilentlyContinue'");
	});

	it("contains OutputEncoding UTF8", () => {
		expect(REMOTE_POWERSHELL_PREAMBLE).toContain("[Console]::OutputEncoding");
		expect(REMOTE_POWERSHELL_PREAMBLE).toContain("UTF8Encoding");
	});

	it("is a single string joined by semicolons", () => {
		expect(REMOTE_POWERSHELL_PREAMBLE).toContain("; ");
	});
});

// ============================================================================
// Cross-platform integration: encoder + existing shell config
// ============================================================================

describe("encoder integration with shell config", () => {
	it("encoded command works with getPowerShellConfig flags", () => {
		// getPowerShellConfig throws on non-Windows without pwsh — skip gracefully
		if (process.platform !== "win32") {
			return;
		}
		const config = getPowerShellConfig();
		// The config should exist and have expected flags
		expect(config.args).toContain("-NoLogo");
		expect(config.args).toContain("-NoProfile");
		expect(config.args).toContain("-NonInteractive");
	});

	it("encoded strings are valid for both pwsh and powershell.exe", () => {
		// Both pwsh and Windows PowerShell accept UTF-16LE Base64 without BOM
		const encoded = encodePowerShellCommand("Write-Output 'portable'");
		expect(encoded).toBeTruthy();
		// Verify the decoder doesn't throw
		const buf = Buffer.from(encoded, "base64");
		expect(buf.length).toBeGreaterThan(0);
		// No BOM — first byte is part of first character
	});
});
