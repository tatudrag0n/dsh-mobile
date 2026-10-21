/**
 * Read a file out of the desktop app's app.asar and print it.
 *
 * Usage: node tools/asar-read.mjs <path-inside-asar> [maxLines]
 */
import { readFileSync } from "node:fs";

const asarPath = `${process.env.LOCALAPPDATA}\\Programs\\DeepSeek Harness\\resources\\app.asar`;
const target = process.argv[2];
const maxLines = Number(process.argv[3] ?? 60);

const buffer = readFileSync(asarPath);
const headerSize = buffer.readUInt32LE(4);
const jsonSize = buffer.readUInt32LE(12);
const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString("utf8"));
const dataStart = 8 + headerSize;

function find(node, parts) {
	if (parts.length === 0) return node;
	const [head, ...rest] = parts;
	const child = node.files?.[head];
	return child ? find(child, rest) : null;
}

const entry = find(header, target.split("/").filter(Boolean));
if (!entry || !entry.size) {
	console.error("not found:", target);
	process.exit(1);
}
const content = buffer.subarray(dataStart + Number(entry.offset), dataStart + Number(entry.offset) + entry.size).toString("utf8");
console.log(content.split("\n").slice(0, maxLines).join("\n"));
