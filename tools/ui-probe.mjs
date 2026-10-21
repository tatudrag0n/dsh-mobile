/**
 * Check the phone layout, the drawer, the service worker and the pairing page.
 *
 * Usage: node tools/ui-test.mjs <app-url> <pair-url>
 */
import { launch, sleep } from "./cdp.mjs";

const appUrl = process.argv[2];
const pairUrl = process.argv[3];
if (appUrl === undefined) throw new Error("usage: node tools/ui-test.mjs <app-url> <pair-url>");

const browser = await launch();
try {
	const page = await browser.newPage();
	await page.goto(appUrl);
	await sleep(8000);
	await page.evaluate(`
		const modal = document.querySelector('[role="dialog"]');
		if (modal === null) return 'none';
		const buttons = [...modal.querySelectorAll('button')];
		const button = buttons.find((entry) => /閉じる|close|OK|同意|確認|了解|続行|開始/i.test((entry.getAttribute('aria-label') ?? '') + ' ' + (entry.textContent ?? ''))) ?? buttons[buttons.length - 1];
		if (button !== undefined) button.click();
		return 'dismissed';
	`);
	await sleep(600);

	const closed = await page.evaluate(`
		const sidebar = document.querySelector('[class*="sidebarCol"]');
		const frame = document.querySelector('[class*="frame"]');
		const style = getComputedStyle(sidebar);
		return { position: style.position, width: Math.round(sidebar.getBoundingClientRect().width), collapsed: frame.getAttribute('data-sidebar-collapsed') };
	`);
	console.log("drawer closed:", JSON.stringify(closed));

	// Open the session panel from the rail.
	await page.click('button[aria-keyshortcuts="Control+Alt+B"]');
	await sleep(900);
	const opened = await page.evaluate(`
		const sidebar = document.querySelector('[class*="sidebarCol"]');
		const frame = document.querySelector('[class*="frame"]');
		const style = getComputedStyle(sidebar);
		const rect = sidebar.getBoundingClientRect();
		return {
			position: style.position,
			width: Math.round(rect.width),
			x: Math.round(rect.x),
			collapsed: frame.getAttribute('data-sidebar-collapsed'),
			columns: getComputedStyle(frame).gridTemplateColumns,
			overlayDim: getComputedStyle(frame.querySelector('[data-shell-overlay]'), '::before').content,
		};
	`);
	console.log("drawer open:  ", JSON.stringify(opened));
	await page.screenshot("C:/root/dsh-mobile/tools/drawer.png");

	const sw = await page.evaluate(`
		if (!('serviceWorker' in navigator)) return { supported: false, secure: window.isSecureContext };
		const registrations = await navigator.serviceWorker.getRegistrations();
		return { supported: true, secure: window.isSecureContext, count: registrations.length, scopes: registrations.map((entry) => entry.scope) };
	`);
	console.log("service worker:", JSON.stringify(sw));

	if (pairUrl !== undefined) {
		const pair = await browser.newPage();
		await pair.goto(pairUrl);
		await sleep(2500);
		const card = await pair.evaluate(`
			const canvas = document.querySelector('#qr-image canvas');
			const lead = document.getElementById('lead');
			const form = document.getElementById('pin-form');
			return {
				lead: lead?.textContent ?? null,
				formVisible: form !== null && !form.classList.contains('hidden'),
				qrCanvas: canvas === null ? null : { w: canvas.width, h: canvas.height },
				qrLibrary: typeof window.qrcode,
			};
		`);
		console.log("pair page:    ", JSON.stringify(card));
		await pair.screenshot("C:/root/dsh-mobile/tools/pair.png");
	}
} finally {
	await browser.close();
}
