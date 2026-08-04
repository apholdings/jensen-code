import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

function option(args, name) {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const directory = resolve(option(args, "--directory") ?? ".");
const output = resolve(option(args, "--output") ?? "binary-manifest.json");
const version = option(args, "--version");
const commit = option(args, "--commit");
if (!version || !commit) throw new Error("--version and --commit are required");

const names = (await readdir(directory))
	.filter((name) => /\.(tar\.gz|zip)$/.test(name))
	.sort();
if (names.length === 0) throw new Error(`no binary archives found in ${directory}`);

const assets = [];
for (const name of names) {
	const path = resolve(directory, name);
	const contents = await readFile(path);
	const info = await stat(path);
	const match = name.match(/^[^-]+-(darwin|linux|windows)-(arm64|x64)\.(?:tar\.gz|zip)$/);
	if (!match) throw new Error(`unsupported binary asset name: ${name}`);
	assets.push({
		name,
		platform: match[1],
		arch: match[2],
		sha256: createHash("sha256").update(contents).digest("hex"),
		size: info.size,
	});
}

await writeFile(
	output,
	`${JSON.stringify({ version, commit, generatedAt: new Date().toISOString(), assets }, null, 2)}\n`,
);
console.log(`wrote ${basename(output)} with ${assets.length} assets`);
