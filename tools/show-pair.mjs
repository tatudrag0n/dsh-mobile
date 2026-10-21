/**
 * Print the pairing card of a running DSH Mobile host.
 *
 * The host writes the card to $DSH_HOME/mobile-pair.json; this reads it back
 * and prints it the way the host itself did, QR included.
 *
 * Usage: node tools/show-pair.mjs [pair-file]
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const qrcode = require("../vendor/qrcode.js");

const target = process.argv[2] ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "mobile-pair.json");

/**
 * Render text as a terminal QR block.
 * @param {string} text - the payload.
 * @returns {string} the block.
 */
function renderTerminalQr(text) {
	const qr = qrcode(0, "M");
	qr.addData(text, "Byte");
	qr.make();
	const count = qr.getModuleCount();
	const border = "  ".repeat(count + 4);
	const lines = [border];
	for (let row = 0; row < count; row += 1) {
		let line = "  ";
		for (let column = 0; column < count; column += 1) line += qr.isDark(row, column) ? "##" : "  ";
		lines.push(`${line}  `);
	}
	lines.push(border);
	return lines.join("\n");
}

let card;
try {
	card = JSON.parse(await readFile(target, "utf8"));
} catch (error) {
	console.error(`dsh-mobile: no pairing card at ${target} (${error instanceof Error ? error.message : String(error)})`);
	process.exit(1);
}

console.log("dsh-mobile: phone pairing ready");
console.log(`dsh-mobile:   PIN   ${card.pin}`);
console.log(`dsh-mobile:   URL   ${card.lanUrl ?? card.url}`);
if (card.pairUrl !== undefined) console.log(`dsh-mobile:   PIN page ${card.pairUrl}`);
console.log(`dsh-mobile:   card  ${target}`);
if (typeof card.lanUrl === "string") console.log(renderTerminalQr(card.lanUrl));
