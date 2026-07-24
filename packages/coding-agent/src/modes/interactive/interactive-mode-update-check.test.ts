import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseChannel } from "../../config.js";
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
	it("VU11: numeric semantic ordering", () => {
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

	it("VU11: remote older - 1.2.0 < 1.10.0", () => {
		expect(semverGt("1.10.0", "1.2.0")).toBe(true);
		expect(semverGt("1.2.0", "1.10.0")).toBe(false);
	});

	it("equal versions produce false", () => {
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
		const instruction = getUpdateInstruction("@apholdings/jensen-code", "latest");
		expect(instruction).toContain("npm install -g @apholdings/jensen-code");
		expect(instruction).not.toContain("@latest");
	});

	it("no channel argument produces untagged command", () => {
		const instruction = getUpdateInstruction("@apholdings/jensen-code");
		expect(instruction).toContain("npm install -g @apholdings/jensen-code");
		expect(instruction).not.toContain("@latest");
		expect(instruction).not.toContain("@fork");
	});
});

// =============================================================================
// VU: dev mode detection
// =============================================================================

describe("isDevMode", () => {
	it("VU09: returns true when running from source (src/ exists)", async () => {
		// The mock overrides isDevMode, so import the real implementation
		const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
		expect(actual.isDevMode()).toBe(true);
	});
});

// =============================================================================
// VU: releaseChannel resolution
// =============================================================================

describe("SettingsManager releaseChannel", () => {
	afterEach(() => {
		delete process.env.PI_RELEASE_CHANNEL;
		delete process.env.JENSEN_RELEASE_CHANNEL;
	});

	// VU01 + VU08: default is fork (Apholdings fork default)
	it("VU01, VU08: defaults to fork when no env or persisted override", () => {
		const sm = SettingsManager.inMemory({});
		expect(sm.getReleaseChannel()).toBe("fork");
	});

	// VU03: explicit fork via env
	it("VU03: explicit fork via PI_RELEASE_CHANNEL env", () => {
		const sm = SettingsManager.inMemory({});
		try {
			process.env.PI_RELEASE_CHANNEL = "fork";
			expect(sm.getReleaseChannel()).toBe("fork");
		} finally {
			delete process.env.PI_RELEASE_CHANNEL;
		}
	});

	// VU04: explicit latest via env
	it("VU04: explicit latest via PI_RELEASE_CHANNEL env", () => {
		const sm = SettingsManager.inMemory({ releaseChannel: "fork" });
		try {
			process.env.PI_RELEASE_CHANNEL = "latest";
			expect(sm.getReleaseChannel()).toBe("latest");
		} finally {
			delete process.env.PI_RELEASE_CHANNEL;
		}
	});

	// VU05: persisted fork
	it("VU05: persisted releaseChannel=fork honored when no env", () => {
		const sm = SettingsManager.inMemory({ releaseChannel: "fork" });
		expect(sm.getReleaseChannel()).toBe("fork");
	});

	// VU06: invalid env override fails closed, does NOT fall through to persisted
	it("VU06: invalid env override (unknown) fails closed, ignores persisted fork", () => {
		const sm = SettingsManager.inMemory({ releaseChannel: "fork" });
		try {
			process.env.PI_RELEASE_CHANNEL = "unknown";
			expect(sm.getReleaseChannel()).toBeUndefined();
		} finally {
			delete process.env.PI_RELEASE_CHANNEL;
		}
	});

	// Also test empty string env
	it("VU06: empty string env override fails closed", () => {
		const sm = SettingsManager.inMemory({ releaseChannel: "fork" });
		try {
			process.env.PI_RELEASE_CHANNEL = "";
			expect(sm.getReleaseChannel()).toBeUndefined();
		} finally {
			delete process.env.PI_RELEASE_CHANNEL;
		}
	});

	// Also test beta env
	it("VU06: unsupported channel env (beta) fails closed", () => {
		const sm = SettingsManager.inMemory({ releaseChannel: "fork" });
		try {
			process.env.PI_RELEASE_CHANNEL = "beta";
			expect(sm.getReleaseChannel()).toBeUndefined();
		} finally {
			delete process.env.PI_RELEASE_CHANNEL;
		}
	});

	// VU07: invalid persisted setting fails closed
	it("VU07: invalid persisted releaseChannel fails closed, no fallback", () => {
		const sm = SettingsManager.inMemory({ releaseChannel: "unknown" as ReleaseChannel });
		expect(sm.getReleaseChannel()).toBeUndefined();
	});

	// Env takes precedence over persisted
	it("JENSEN_RELEASE_CHANNEL env var honored", () => {
		const sm = SettingsManager.inMemory({ releaseChannel: "fork" });
		try {
			process.env.JENSEN_RELEASE_CHANNEL = "latest";
			expect(sm.getReleaseChannel()).toBe("latest");
		} finally {
			delete process.env.JENSEN_RELEASE_CHANNEL;
		}
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
		delete process.env.PI_RELEASE_CHANNEL;
		delete process.env.JENSEN_RELEASE_CHANNEL;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		delete process.env.PI_RELEASE_CHANNEL;
		delete process.env.JENSEN_RELEASE_CHANNEL;
	});

	function createHarness(settings: { releaseChannel?: ReleaseChannel } = {}): CheckHarness {
		const sm = SettingsManager.inMemory(settings);
		const mockSession = { settingsManager: sm };
		return Object.assign(Object.create(InteractiveMode.prototype), {
			version: "1.1.8",
			session: mockSession,
		}) as CheckHarness;
	}

	// VU01: The initial reported incident — default fork channel, current == remote
	it("VU01: reported incident - fork default, current == fork remote, no update", async () => {
		const mode = createHarness({});
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

	// VU02: Future default fork update
	it("VU02: future fork update - default channel, current < fork remote", async () => {
		const mode = createHarness({});
		mode.version = "1.1.8";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.9" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBe("1.1.9");
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining("/@apholdings/jensen-code/fork"),
			expect.any(Object),
		);
	});

	// VU03: Explicit fork channel
	it("VU03: explicit fork via persisted, current < remote → update shown", async () => {
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

	it("VU03: explicit fork via env, current < remote → update shown", async () => {
		process.env.PI_RELEASE_CHANNEL = "fork";
		const mode = createHarness({});
		mode.version = "1.1.7";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.8" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBe("1.1.8");
		delete process.env.PI_RELEASE_CHANNEL;
	});

	// VU04: Explicit latest channel
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

	// VU06: Invalid environment override — fail closed
	it("VU06: invalid env (unknown) → no registry query, no update", async () => {
		process.env.PI_RELEASE_CHANNEL = "unknown";
		const mode = createHarness({});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		delete process.env.PI_RELEASE_CHANNEL;
	});

	it("VU06: invalid env (shell metacharacters) → no registry query", async () => {
		process.env.PI_RELEASE_CHANNEL = "latest;rm";
		const mode = createHarness({});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		delete process.env.PI_RELEASE_CHANNEL;
	});

	it("VU13: env containing slash rejected", async () => {
		process.env.PI_RELEASE_CHANNEL = "fork/evil";
		const mode = createHarness({});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		delete process.env.PI_RELEASE_CHANNEL;
	});

	it("VU13: env containing @ rejected", async () => {
		process.env.PI_RELEASE_CHANNEL = "@latest";
		const mode = createHarness({});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		delete process.env.PI_RELEASE_CHANNEL;
	});

	it("VU13: env containing space rejected", async () => {
		process.env.PI_RELEASE_CHANNEL = "fork latest";
		const mode = createHarness({});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		delete process.env.PI_RELEASE_CHANNEL;
	});

	it("VU13: env containing newline rejected", async () => {
		process.env.PI_RELEASE_CHANNEL = "fork\nlatest";
		const mode = createHarness({});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		delete process.env.PI_RELEASE_CHANNEL;
	});

	// VU07: Invalid persisted setting — fail closed
	it("VU07: invalid persisted releaseChannel → no registry query", async () => {
		const mode = createHarness({ releaseChannel: "unknown" as ReleaseChannel });

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// VU09: Development/source mode
	it("VU09: dev mode always returns undefined, no fetch", async () => {
		const { isDevMode: isDevModeMock } = await import("../../config.js");
		(isDevModeMock as ReturnType<typeof vi.fn>).mockReturnValue(true);

		try {
			const mode = createHarness({});

			fetchSpy.mockResolvedValue({
				ok: true,
				json: async () => ({ version: "9.9.9" }),
			});

			const result = await mode.checkForNewVersion();
			expect(result).toBeUndefined();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			(isDevModeMock as ReturnType<typeof vi.fn>).mockReturnValue(false);
		}
	});

	// VU10: Registry failures
	it("VU10: registry error (non-ok response) - no update, no crash", async () => {
		const mode = createHarness({});

		fetchSpy.mockResolvedValue({
			ok: false,
			status: 500,
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU10: registry timeout (fetch throws) - no update, no crash", async () => {
		const mode = createHarness({});

		fetchSpy.mockRejectedValue(new Error("timeout"));

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU10: missing version field - no update", async () => {
		const mode = createHarness({});

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ name: "some-package" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU10: malformed version field - no update", async () => {
		const mode = createHarness({});

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "not-a-version" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU10: null version field - no update", async () => {
		const mode = createHarness({});

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: null }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	// VU11: Semantic ordering
	it("VU11: 1.1.10 > 1.1.9 produces update", async () => {
		const mode = createHarness({ releaseChannel: "latest" });
		mode.version = "1.1.9";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.10" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBe("1.1.10");
	});

	it("VU11: 1.10.0 > 1.9.9 produces update", async () => {
		const mode = createHarness({ releaseChannel: "latest" });
		mode.version = "1.9.9";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.10.0" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBe("1.10.0");
	});

	it("VU11: 1.2.0 < 1.10.0 produces no update", async () => {
		const mode = createHarness({ releaseChannel: "latest" });
		mode.version = "1.10.0";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.2.0" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	it("VU11: equal versions produce no update", async () => {
		const mode = createHarness({ releaseChannel: "latest" });
		mode.version = "1.1.6";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.6" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
	});

	// VU12: Command integrity
	it("VU12: fork update command contains @fork", () => {
		const instruction = getUpdateInstruction("@apholdings/jensen-code", "fork");
		expect(instruction).toContain("@fork");
		expect(instruction).toContain("npm install -g");
	});

	// Regression: reported incident exact scenario
	it("regression: 1.1.8 on fork vs stale 1.1.6 on latest", async () => {
		// fork user running 1.1.8, latest dist-tag is 1.1.6.
		// Default channel must be fork, so we never see latest's stale version.
		const mode = createHarness({});
		mode.version = "1.1.8";

		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.1.8" }),
		});

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();
		// Must have queried fork, not latest
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining("/@apholdings/jensen-code/fork"),
			expect.any(Object),
		);
	});

	it("PI_SKIP_VERSION_CHECK suppresses check", async () => {
		const mode = createHarness({});
		process.env.PI_SKIP_VERSION_CHECK = "1";

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();

		delete process.env.PI_SKIP_VERSION_CHECK;
	});

	it("PI_OFFLINE suppresses check", async () => {
		const mode = createHarness({});
		process.env.PI_OFFLINE = "1";

		const result = await mode.checkForNewVersion();
		expect(result).toBeUndefined();

		delete process.env.PI_OFFLINE;
	});
});
