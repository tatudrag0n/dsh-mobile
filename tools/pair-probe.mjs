/**
 * Check the pairing page from the owner's side: the PC, already holding the
 * Host session, must see the pairing card with the QR.
 *
 * Usage: node tools/pair-test.mjs <app-url> <pair-url>
 */
import { launch, sleep } from "./cdp.mjs";

const appUrl = process.argv[2];
const pairUrl = process.argv[3];
if (appUrl === undefined || pairUrl === undefined) throw new Error("usage: node tools/pair-test.mjs <app-url> <pair-url>");

const browser = await launch();
try {
	const page = await browser.newPage();
	await page.goto(appUrl);
	await sleep(6000);
	const pair = await browser.newPage();
	await pair.goto(pairUrl);
	await sleep(2500);
	const card = await pair.evaluate(`
		const canvas = document.querySelector('#qr-image canvas');
		const lead = document.getElementById('lead');
		const form = document.getElementById('pin-form');
		const url = document.getElementById('url');
		let payload = null;
		const response = await fetch('/mobile/pair');
		payload = await response.json();
		return {
			lead: lead?.textContent ?? null,
			formVisible: form !== null && !form.classList.contains('hidden'),
			qrCanvas: canvas === null ? null : { w: canvas.width, h: canvas.height },
			url: url?.textContent ?? null,
			pair: payload,
		};
	`);
	console.log(JSON.stringify(card, null, 2));
	await pair.screenshot("C:/root/dsh-mobile/tools/pair-owner.png");
} finally {
	await browser.close();
}
