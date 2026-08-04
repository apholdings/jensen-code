import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

function u16(value) {
	const buffer = Buffer.alloc(2);
	buffer.writeUInt16LE(value, 0);
	return buffer;
}

function u32(value) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value >>> 0, 0);
	return buffer;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

function crc32(contents) {
	let value = 0xffffffff;
	for (const byte of contents) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

async function filesIn(directory, root = directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await filesIn(path, root)));
		else if (entry.isFile()) files.push({ path, name: relative(root, path).split("\\").join("/") });
		else throw new Error(`unsupported zip entry: ${relative(root, path)}`);
	}
	return files;
}

function option(args, name) {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const source = resolve(option(args, "--source") ?? ".");
const output = resolve(option(args, "--output") ?? "archive.zip");
const entries = await filesIn(source);
const localParts = [];
const centralParts = [];
let offset = 0;
for (const entry of entries) {
	const name = Buffer.from(entry.name);
	const contents = await readFile(entry.path);
	const crc = crc32(contents);
	const header = Buffer.concat([
		Buffer.from([0x50, 0x4b, 0x03, 0x04]),
		u16(20),
		u16(0),
		u16(0),
		u16(0),
		u16(0),
		u32(crc),
		u32(contents.length),
		u32(contents.length),
		u16(name.length),
		u16(0),
		name,
		contents,
	]);
	localParts.push(header);
	centralParts.push(
		Buffer.concat([
			Buffer.from([0x50, 0x4b, 0x01, 0x02]),
			u16(20),
			u16(20),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(crc),
			u32(contents.length),
			u32(contents.length),
			u16(name.length),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(0),
			u32(offset),
			name,
		]),
	);
	offset += header.length;
}
const local = Buffer.concat(localParts);
const central = Buffer.concat(centralParts);
const end = Buffer.concat([
	Buffer.from([0x50, 0x4b, 0x05, 0x06]),
	Buffer.alloc(4),
	u16(entries.length),
	u16(entries.length),
	u32(central.length),
	u32(local.length),
	u16(0),
]);
await writeFile(output, Buffer.concat([local, central, end]));
const outputStat = await stat(output);
console.log(`wrote ${output} (${outputStat.size} bytes)`);
