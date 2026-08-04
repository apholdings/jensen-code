import { describe, expect, it } from "vitest";
import { createReleaseConvergenceState, updateReleaseConvergenceState } from "../../src/core/evaluation/index.js";

function fullyPassed() {
	return {
		functionalEvaluation: "passed" as const,
		packageBuild: "passed" as const,
		npmPublication: "complete" as const,
		sourceTag: "created" as const,
		binaryBuild: "passed" as const,
		binarySmoke: "passed" as const,
		assetUpload: "complete" as const,
		assetVerification: "passed" as const,
		githubRelease: "published" as const,
		runtimeAcceptance: {
			source: "pass" as const,
			packedNpm: "pass" as const,
			registryNpm: "pass" as const,
			builtBinary: "pass" as const,
			downloadedBinary: "pass" as const,
		},
	};
}

describe("release convergence runtime acceptance", () => {
	it("starts every runtime acceptance state as pending", () => {
		const state = createReleaseConvergenceState("r", "1.8.3", "abc");
		expect(state.runtimeAcceptance).toEqual({
			source: "pending",
			packedNpm: "pending",
			registryNpm: "pending",
			builtBinary: "pending",
			downloadedBinary: "pending",
		});
		expect(state.finalVerdict).toBe("incomplete");
	});

	it("requires all runtime acceptance states to pass for final PASS", () => {
		const state = createReleaseConvergenceState("r", "1.8.3", "abc");
		const passed = updateReleaseConvergenceState(state, fullyPassed());
		expect(passed.finalVerdict).toBe("pass");
	});

	it("blocks when any runtime acceptance state fails", () => {
		const state = createReleaseConvergenceState("r", "1.8.3", "abc");
		const blocked = updateReleaseConvergenceState(state, {
			...fullyPassed(),
			runtimeAcceptance: { ...fullyPassed().runtimeAcceptance, downloadedBinary: "fail" },
		});
		expect(blocked.finalVerdict).toBe("blocked");
	});

	it("stays incomplete when downloaded binary acceptance is still pending despite basic smoke", () => {
		const state = createReleaseConvergenceState("r", "1.8.3", "abc");
		const incomplete = updateReleaseConvergenceState(state, {
			...fullyPassed(),
			runtimeAcceptance: { ...fullyPassed().runtimeAcceptance, downloadedBinary: "pending" },
		});
		// A basic --version smoke that never ran the downloaded binary sandbox
		// cannot yield a final PASS.
		expect(incomplete.finalVerdict).not.toBe("pass");
	});

	it("keeps a failed downloaded acceptance unrecoverable to pass", () => {
		const state = createReleaseConvergenceState("r", "1.8.3", "abc");
		const failed = updateReleaseConvergenceState(state, {
			...fullyPassed(),
			runtimeAcceptance: { ...fullyPassed().runtimeAcceptance, builtBinary: "fail" },
		});
		const retried = updateReleaseConvergenceState(failed, fullyPassed());
		expect(retried.finalVerdict).toBe("pass");
	});
});
