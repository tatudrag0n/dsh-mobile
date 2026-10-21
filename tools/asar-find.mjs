/**
 * Find which file inside the packed DSH implementation mentions a string.
 *
 * Usage: node tools/asar-find.mjs <needle>
 */
import { readFileSync } from "node:fs";

const asar = "C:\\Users\\tatud\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const needle = process.argv[2];
if (!needle) throw new Error("usage: node tools/asar-find.mjs <needle>");

const buffer = readFileSync(asar);
const headerSize = buffer.readUInt32LE(4);
const jsonSize = buffer.readUInt32LE(12);
const header = JSON.parse(buffer.toString("utf8", 16, 16 + jsonSize));
const dataStart = 8 + headerSize;

const files = [];
const walk = (node, prefix) => {
	for (const [name, entry] of Object.entries(node.files ?? {})) {
		const path = prefix ? `${prefix}/${name}` : name;
		if (entry.files) walk(entry, path);
		else files.push({ path, offset: Number(entry.offset ?? 0), size: entry.size ?? 0 });
	}
};
walk(header, "");

for (const file of files) {
	if (file.size === 0 || file.size > 3_000_000) continue;
	const start = dataStart + file.offset;
	const text = buffer.toString("utf8", start, start + file.size);
	const index = text.indexOf(needle);
	if (index >= 0) {
		const context = text.slice(Math.max(0, index - 160), index + 220).replace(/\s+/g, " ");
		console.log(`${file.path}\n    ${context}\n`);
	}
}
