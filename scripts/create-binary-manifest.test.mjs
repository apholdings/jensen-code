import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("create-binary-manifest records deterministic asset metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "jensen-binary-manifest-"));
	try {
		await writeFile(join(root, "pi-linux-x64.tar.gz"), "linux");
		await writeFile(join(root, "pi-windows-x64.zip"), "windows");
		const output = join(root, "manifest.json");
		await execFileAsync(process.execPath, [
			"scripts/create-binary-manifest.mjs",
			"--directory",
			root,
			"--output",
			output,
			"--version",
			"1.8.1",
			"--commit",
			"abc",
		]);
		const manifest = JSON.parse(await readFile(output, "utf8"));
		assert.equal(manifest.version, "1.8.1");
		assert.equal(manifest.commit, "abc");
		assert.deepEqual(
			manifest.assets.map((asset) => asset.name),
			["pi-linux-x64.tar.gz", "pi-windows-x64.zip"],
		);
		assert.equal(manifest.assets[0].size, 5);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
