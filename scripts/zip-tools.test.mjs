import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("repository zip tools create and extract a safe archive", async () => {
	const root = await mkdtemp(join(tmpdir(), "jensen-zip-tools-"));
	try {
		const source = join(root, "source");
		const destination = join(root, "destination");
		const archive = join(root, "archive.zip");
		await execFileAsync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(join(source, "nested"))}, {recursive:true})`]);
		await writeFile(join(source, "nested", "data.txt"), "fixture");
		await execFileAsync(process.execPath, ["scripts/create-zip.mjs", "--source", source, "--output", archive]);
		await execFileAsync(process.execPath, ["scripts/extract-zip.mjs", "--archive", archive, "--destination", destination]);
		assert.equal(await readFile(join(destination, "nested", "data.txt"), "utf8"), "fixture");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
