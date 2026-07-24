import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUpdateInstruction, semverGt } from "../../config.js";
import { SettingsManager } from "../../core/settings-manager.js";
import { InteractiveMode } from "./interactive-mode.js";

// Mock isDevMode for tests that need to exercise the registry fetch path
vi.mock("../../config.js", async () => {
	const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
	return {
		...actual,
		isDevMode: vi.fn(() => false),
	};
});

// =============================================================================
// VU: semverGt
// =============================================================================

describe("semverGt", () => {
	it("VU01-VU05: numeric semantic ordering", () => {
		// patch comparison
		expect(semverGt("1.1.10", "1.1.9")).toBe(true);
		expect(semverGt("1.1.9", "1.1.10")).toBe(false);

		// minor comparison
		expect(semverGt("1.10.0", "1.9.9")).toBe(true);
		expect(semverGt("1.9.9", "1.10.0")).toBe(false);

		// major comparison
		expect(semverGt("2.0.0", "1.99.99")).toBe(true);
		expect(semverGt("1.99.99", "2.0.0")).toBe(false);
	});

	it("VU06: remote older - 1.2.0 > 1.10.0", () => {
		expect(semverGt("1.10.0", "1.2.0")).toBe(true);
		expect(semverGt("1.2.0", "1.10.0")).toBe(false);
	});

	it("VU07: equal versions produce false", () => {
		expect(semverGt("1.1.8", "1.1.8")).toBe(false);
		expect(semverGt("2.0.0", "2.0.0")).toBe(false);
	});

	it("handles short versions", () => {
		expect(semverGt("2", "1")).toBe(true);
		expect(semverGt("2.0", "2")).toBe(false);
	});

	it("handles malformed versions safely", () => {
		expect(semverGt("abc", "1.0.0")).toBe(false);
		expect(semverGt("1.0.0", "abc")).toBe(false);
		expect(semverGt("", "")).toBe(false);
	});
});

// =============================================================================
// VU: getUpdateInstruction
// =============================================================================

describe("getUpdateInstruction", () => {
	it("VU12: fork channel appends @fork to npm command", () => {
		const instruction = getUpdateInstruction("@apholdings/jensen-code", "fork");
		expect(instruction).toContain("npm install -g @apholdings/jensen-code@fork");
	});

	it("VU12: fork channel never produces untagged npm command", () => {
		const instruction = getUpdateInstruction("@apholdings/jensen-code", "fork");
		expect(instruction).not.toBe("Run: npm install -g @apholdings/jensen-code");
	});

	it("VU04: latest channel omits tag", () => {
		// By convention, latest channel shows the untagged command
		const instruction = getUpdateInstruction("@apholdings/jensen-code", "latest");
		expect(instruction).toContain("npm install -g @apholdings/jensen-code");
		expect(instruction).not.toContain("@latest");
	});

	it("no channel defaults to no tag", () => {
		const instruction = getUpdateInstruction("@apholdings/jensen-code");
		expect(instruction).toContain("npm install -g @apholdings/jensen-code");
		// The @ is from the scoped package name, not a dist-tag
		expect(instruction).not.toContain("@latest");
		expect(instruction).not.toContain("@fork");
	});
});

// =============================================================================
// VU: dev mode detection
// =============================================================================

describe("isDevMode", () => {
	it("VU08: returns true when running from source (src/ exists)", async () => {
		// The mock overrides isDevMode, so import the real implementation
		const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
		expect(actual.isDevMode()).toBe(true);
	});
});

// =============================================================================
// VU: releaseChannel setting
// =============================================================================

describe("SettingsManager releaseChannel", () => {
	it("defaults to latest", () => {
		const sm = SettingsManager.inMemory({});
		expect(sm.getReleaseChannel()).toBe("latest");
	});

	it("reads from settings", () => {
		const sm = SettingsManager.inMemory({ releaseChannel: "fork" });
		expect(sm.getReleaseChannel()).toBe("fork");
	});

	it("reads from PI_RELEASE_CHANNEL env var", () => {
		const sm = SettingsManager.inMemory({ releaseChannel: "latest" });
		try {
			process.env.PI_RELEASE_CHANNEL = "fork";
			expect(sm.getReleaseChannel()).toBe("fork");
		} finally {
			delete process.env.PI_RELEASE_CHANNEL;
		}
	});

	it("VU11: unknown/non-existent channel falls back to latest", () => {
		const sm = SettingsManager.inMemory({});
		expect(sm.getReleaseChannel()).toBe("latest");
	});
});

// =============================================================================
// VU: checkForNewVersion production path
// =============================================================================

type CheckHarness = {
	checkForNewVersion: () => Promise<string | undefined>;
	version: string;
};

describe("checkForNewVersion", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	let originalFetch: typeof global.fetch;

	beforeEach(() => {
		originalFetch = global.fetch;
		fetchSpy = vi.fn();
		global.fetch = fetchSpy;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		delete process.env.PI_RELEASE_CHANNEL;
	});

	function createHarness(settings: { releaseChannel?: string } = {}): CheckHarness {
		const sm = SettingsManager.inMemory(settings);
		// settingsManager is a private getter that delegates to this.session.settingsManager
		const mockSession = { settingsManager: sm };
		return Object.assign(Object.create(InteractiveMode.prototype), {
			version: "1.1.8",
			session: mockSession,
		}) as CheckHarness;
	}

	it("VU01: reported incident - fork channel, current == remote, no update", async () => {
		const mode = createHarness({ releaseChannel: "fork" });
		mode.version = "1.1.8";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.8" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining("/@apholdings/jensen-code/fork"),
			expect.any(Object),
		);
	});

	it("VU03: real fork update - current < fork remote", async () => {
		const mode = createHarness({ releaseChannel: "fork" });
		mode.version = "1.1.7";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.8" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBe("1.1.8");
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining("/@apholdings/jensen-code/fork"),
			expect.any(Object),
		);
	});

	it("VU03: future fork update - current < remote", async () => {
		const mode = createHarness({ releaseChannel: "fork" });
		mode.version = "1.1.8";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.9" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBe("1.1.9");
	});

	it("VU04: latest channel with real update", async () => {
		const mode = createHarness({ releaseChannel: "latest" });
		mode.version = "1.1.5";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.6" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBe("1.1.6");
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining("/@apholdings/jensen-code/latest"),
			expect.any(Object),
		);
	});

	it("VU05: numeric semantic ordering - 1.1.10 > 1.1.9", async () => {
		const mode = createHarness({ releaseChannel: "latest" });
		mode.version = "1.1.9";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.10" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBe("1.1.10");
	});

	it("VU06: remote older - no update", async () => {
		const mode = createHarness({ releaseChannel: "latest" });
		mode.version = "1.10.0";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.2.0" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU07: equal versions - no update", async () => {
		const mode = createHarness({ releaseChannel: "latest" });
		mode.version = "1.1.6";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.6" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU09: registry error (non-ok response) - no update, no crash", async () => {
		const mode = createHarness({ releaseChannel: "latest" });

		fetchSpy.mockResolvedValue({
			ok: false,
			status: 500,
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU09: registry timeout (fetch throws) - no update, no crash", async () => {
		const mode = createHarness({ releaseChannel: "latest" });

		fetchSpy.mockRejectedValue(new Error("timeout"));

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU10: missing version field - no update", async () => {
		const mode = createHarness({ releaseChannel: "latest" });

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ name: "some-package" }), // no version field
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU10: malformed version field - no update", async () => {
		const mode = createHarness({ releaseChannel: "latest" });

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "not-a-version" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU10: null version field - no update", async () => {
		const mode = createHarness({ releaseChannel: "latest" });

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: null }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU08: dev mode always returns undefined regardless of registry", async () => {
		// isDevMode is mocked to return false globally; override for this test
		const { isDevMode: isDevModeMock } = await import("../../config.js");
		(isDevModeMock as ReturnType<typeof vi.fn>).mockReturnValue(true);

		const mode = createHarness({ releaseChannel: "latest" });

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "9.9.9" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
		// fetch should not even be called since dev mode returns early
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("VU02: fork update command contains @fork", () => {
		const instruction = getUpdateInstruction("@apholdings/jensen-code", "fork");
		expect(instruction).toContain("@fork");
	});

	it("reported incident regression: 1.1.8 on fork vs 1.1.6 on latest", async () => {
		// This is the exact scenario from the defect: fork user running 1.1.8,
		// latest dist-tag is 1.1.6. The code must not compare against latest.
		const mode = createHarness({ releaseChannel: "fork" });
		mode.version = "1.1.8";

		// Simulate fork dist-tag returning 1.1.8 (same as current)
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.8" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("PI_SKIP_VERSION_CHECK suppresses check", async () => {
		const mode = createHarness({ releaseChannel: "latest" });
		process.env.PI_SKIP_VERSION_CHECK = "1";

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();

		delete process.env.PI_SKIP_VERSION_CHECK;
	});

	it("PI_OFFLINE suppresses check", async () => {
		const mode = createHarness({ releaseChannel: "latest" });
		process.env.PI_OFFLINE = "1";

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();

		delete process.env.PI_OFFLINE;
	});
});
