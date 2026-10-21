/**
 * List the files inside the desktop app's asar that match a pattern.
 *
 * Usage: node tools/asar-list.mjs <pattern>
 */
import { readFileSync } from "node:fs";

const asarPath = "C:\\Users\\tatud\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const pattern = new RegExp(process.argv[2] ?? ".", "i");
const buffer = readFileSync(asarPath);
const headerSize = buffer.readUInt32LE(12);
const header = JSON.parse(buffer.toString("utf8", 16, 16 + headerSize));
const found = [];
const walk = (node, prefix) => {
	for (const [name, child] of Object.entries(node.files ?? {})) {
		const path = `${prefix}${name}`;
		if (child.files) {
			walk(child, `${path}/`);
			continue;
		}
		if (pattern.test(path)) found.push(path);
	}
};
walk(header, "");
console.log(found.join("\n"));
