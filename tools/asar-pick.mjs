/**
 * Look inside the packed DSH implementation (app.asar) without unpacking it.
 *
 * Usage:
 *   node tools/asar-pick.mjs list <pattern>   list the files whose path matches
 *   node tools/asar-pick.mjs show <pattern>    print the first match
 */
import { readFileSync } from "node:fs";

const asar = "C:\\Users\\tatud\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const [mode = "list", pattern = "."] = process.argv.slice(2);

const buffer = readFileSync(asar);
const headerSize = buffer.readUInt32LE(4);
const jsonSize = buffer.readUInt32LE(12);
const header = JSON.parse(buffer.toString("utf8", 16, 16 + jsonSize));
const dataStart = 8 + headerSize;

/** Walk the header tree into a flat list of files. */
const files = [];
const walk = (node, prefix) => {
	for (const [name, entry] of Object.entries(node.files ?? {})) {
		const path = prefix ? `${prefix}/${name}` : name;
		if (entry.files) walk(entry, path);
		else files.push({ path, offset: Number(entry.offset ?? 0), size: entry.size ?? 0, unpacked: Boolean(entry.unpacked) });
	}
};
walk(header, "");

const matches = files.filter((file) => new RegExp(pattern, "i").test(file.path));
console.log(`matched ${matches.length} of ${files.length}`);
for (const file of matches.slice(0, 40)) {
	console.log(`${file.size}\t${file.unpacked ? "(unpacked)" : ""}\t${file.path}`);
}

if (mode === "show") {
	const file = matches[0];
	if (!file) process.exit(1);
	if (file.unpacked) {
		console.log("(unpacked file, read it directly)");
	} else {
		const start = dataStart + file.offset;
		console.log("----- content -----");
		console.log(buffer.toString("utf8", start, start + file.size));
	}
}
