/**
 * Verify the phone half of DSH Mobile against a live Host.
 *
 * Usage: node tools/verify.mjs <url> [screenshot]
 */
import { launch, sleep } from "./cdp.mjs";

const url = process.argv[2];
const shot = process.argv[3] ?? "C:/root/dsh-mobile/tools/verify.png";
if (url === undefined) throw new Error("usage: node tools/verify.mjs <url> [screenshot]");

const browser = await launch();
try {
	const page = await browser.newPage();
	const consoleErrors = [];
	page.socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
			consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
		}
	});
	await page.goto(url);
	await sleep(8000);
	const report = await page.evaluate(`
		const box = (element) => {
			if (element === null) return null;
			const rect = element.getBoundingClientRect();
			return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
		};
		const chip = document.querySelector('.dsh-mobile-chip');
		const frame = document.querySelector('[class*="frame"]');
		const center = document.querySelector('[class*="centerCol"]');
		const sidebar = document.querySelector('[class*="sidebarCol"]');
		const input = document.querySelector('[data-composer-input="true"]');
		const send = document.querySelector('[data-conversation-region="composer"] [class*="primary"]');
		const style = getComputedStyle(document.documentElement);
		return {
			viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
			chip: chip === null ? null : {
				text: chip.textContent,
				state: chip.getAttribute('data-state'),
				pending: chip.getAttribute('data-pending'),
				box: box(chip),
			},
			styleTag: document.getElementById('dsh-mobile-styles') !== null,
			manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
			appleIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null,
			appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content') ?? null,
			frame: { box: box(frame), columns: frame === null ? null : getComputedStyle(frame).gridTemplateColumns, paddingTop: frame === null ? null : getComputedStyle(frame).paddingTop },
			center: box(center),
			sidebar: box(sidebar),
			input: { box: box(input), fontSize: input === null ? null : getComputedStyle(input).fontSize },
			send: { box: box(send), size: send === null ? null : [getComputedStyle(send).width, getComputedStyle(send).height] },
			keyboardVar: style.getPropertyValue('--dsh-mobile-keyboard').trim(),
			overflow: document.documentElement.scrollWidth > innerWidth,
			globals: Object.keys(globalThis).filter((key) => key.startsWith('__DSH')).sort(),
			mobileGlobal: globalThis.__DSH_MOBILE__ ?? null,
		};
	`);
	const sw = await page.evaluate(`
		if (!('serviceWorker' in navigator)) return { supported: false };
		const registrations = await navigator.serviceWorker.getRegistrations();
		return { supported: true, count: registrations.length, scopes: registrations.map((entry) => entry.scope) };
	`);
	console.log(JSON.stringify({ ...report, serviceWorker: sw, consoleErrors }, null, 2));
	await page.screenshot(shot);
	console.log(`screenshot: ${shot}`);
} finally {
	await browser.close();
}
