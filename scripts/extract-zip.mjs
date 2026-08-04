import extract from "extract-zip";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

function option(args, name) {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const archive = resolve(option(args, "--archive") ?? "archive.zip");
const destination = resolve(option(args, "--destination") ?? ".");
await mkdir(destination, { recursive: true });
await extract(archive, { dir: destination });
