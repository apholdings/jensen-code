/**
 * Remote runtime bundle — reproducibility tests.
 *
 * Proves the bundle is content-addressed (tarball SHA-256 = runtimeId suffix),
 * carries the manifest with commit/protocol/package identity, and is
 * deterministic for identical inputs (same tarball hash). Uses a synthetic
 * checkout + tiny third-party closure (no 600MB node_modules).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildRuntimeBundle,
	RUNTIME_BUNDLE_SCHEMA_VERSION,
	RUNTIME_PROTOCOL_VERSION,
} from "../../src/core/remote-execution/runtime-bundle.js";

function makeSyntheticCheckout(): string {
	const root = mkdtempSync(path.join(tmpdir(), "runtime-bundle-checkout-"));
	for (const [dir, npmName] of [
		["ai", "@apholdings/jensen-ai"],
		["agent", "@apholdings/jensen-agent-core"],
		["coding-agent", "@apholdings/jensen-code"],
		["tui", "@apholdings/jensen-tui"],
	] as const) {
		mkdirSync(path.join(root, "packages", dir, "dist"), { recursive: true });
		writeFileSync(path.join(root, "packages", dir, "dist", "index.js"), `// ${dir}\n`);
		writeFileSync(
			path.join(root, "packages", dir, "package.json"),
			JSON.stringify({ name: npmName, version: "2.1.0", type: "module", main: "./dist/index.js" }),
		);
	}
	mkdirSync(path.join(root, "node_modules", "chalk"), { recursive: true });
	writeFileSync(
		path.join(root, "node_modules", "chalk", "package.json"),
		JSON.stringify({ name: "chalk", version: "5.0.0" }),
	);
	return root;
}

describe("buildRuntimeBundle", () => {
	it("builds a content-addressed bundle with commit + protocol + package identity", async () => {
		const checkout = makeSyntheticCheckout();
		const outDir = mkdtempSync(path.join(tmpdir(), "runtime-bundle-out-"));
		const bundle = await buildRuntimeBundle({
			checkoutRoot: checkout,
			outDir,
			jensenCommit: "abcdef1234567890abcdef1234567890abcdef12",
		});

		expect(bundle.jensenCommit).toBe("abcdef1234567890abcdef1234567890abcdef12");
		expect(bundle.commitShort).toBe("abcdef123456");
		expect(bundle.runtimeId).toMatch(/^abcdef123456-[0-9a-f]{12}$/u);
		expect(bundle.tarballHash).toMatch(/^[0-9a-f]{64}$/u);
		expect(bundle.runtimeId.endsWith(bundle.tarballHash.slice(0, 12))).toBe(true);

		expect(existsSync(bundle.tarballPath)).toBe(true);
		expect(existsSync(bundle.manifestPath)).toBe(true);

		const tarball = readFileSync(bundle.tarballPath);
		expect(createHash("sha256").update(tarball).digest("hex")).toBe(bundle.tarballHash);

		const manifest = JSON.parse(readFileSync(bundle.manifestPath, "utf8"));
		expect(manifest.schemaVersion).toBe(RUNTIME_BUNDLE_SCHEMA_VERSION);
		expect(manifest.runtimeProtocolVersion).toBe(RUNTIME_PROTOCOL_VERSION);
		expect(manifest.runtimeId).toBe(bundle.runtimeId);
		expect(manifest.tarballHash).toBe(bundle.tarballHash);
		expect(manifest.packageVersions["@apholdings/jensen-code"]).toBe("2.1.0");
		expect(manifest.workspaceFiles.length).toBeGreaterThan(0);
		expect(manifest.workspaceFiles.every((f: { sha256: string }) => /^[0-9a-f]{64}$/u.test(f.sha256))).toBe(true);

		rmSync(checkout, { recursive: true, force: true });
		rmSync(outDir, { recursive: true, force: true });
	});

	it("is deterministic for identical inputs", async () => {
		const checkoutA = makeSyntheticCheckout();
		const checkoutB = makeSyntheticCheckout();
		const outA = mkdtempSync(path.join(tmpdir(), "runtime-bundle-a-"));
		const outB = mkdtempSync(path.join(tmpdir(), "runtime-bundle-b-"));

		const a = await buildRuntimeBundle({ checkoutRoot: checkoutA, outDir: outA, jensenCommit: "c" + "0".repeat(39) });
		const b = await buildRuntimeBundle({ checkoutRoot: checkoutB, outDir: outB, jensenCommit: "c" + "0".repeat(39) });

		expect(a.tarballHash).toBe(b.tarballHash);
		expect(a.runtimeId).toBe(b.runtimeId);

		rmSync(checkoutA, { recursive: true, force: true });
		rmSync(checkoutB, { recursive: true, force: true });
		rmSync(outA, { recursive: true, force: true });
		rmSync(outB, { recursive: true, force: true });
	});
});
