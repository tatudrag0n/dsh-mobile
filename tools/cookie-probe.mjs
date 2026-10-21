/**
 * Check that the app works at the origin root once the browser holds the
 * Host session cookie, i.e. without the launch token in the URL.
 *
 * The Android app relies on this: it stores the host address and reopens the
 * root, and the cookie alone has to authorize it.
 *
 * Usage: node tools/cookie-probe.mjs <app-url-with-token> <root-url>
 */
import { launch, sleep } from "./cdp.mjs";

const withToken = process.argv[2];
const root = process.argv[3];
if (withToken === undefined || root === undefined) throw new Error("usage: node tools/cookie-probe.mjs <app-url> <root-url>");

const browser = await launch();
try {
	const page = await browser.newPage();
	await page.goto(withToken);
	await sleep(7000);
	const first = await page.evaluate(`
		const chip = document.querySelector('.dsh-mobile-chip');
		return { url: location.href, chip: chip?.textContent ?? null, state: chip?.getAttribute('data-state') ?? null };
	`);
	console.log("with token:  ", JSON.stringify(first));

	await page.goto(root);
	await sleep(7000);
	const second = await page.evaluate(`
		const chip = document.querySelector('.dsh-mobile-chip');
		return { url: location.href, chip: chip?.textContent ?? null, state: chip?.getAttribute('data-state') ?? null };
	`);
	console.log("root+cookie: ", JSON.stringify(second));
	console.log(second.state === "connected" ? "RESULT: the cookie alone authorizes the app" : "RESULT: the root needs the token");
} finally {
	await browser.close();
}
