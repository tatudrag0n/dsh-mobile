/**
 * Report the geometry of the DSH shell at a phone viewport.
 *
 * Usage: node tools/layout.mjs <url>
 */
import { launch, sleep } from "./cdp.mjs";

const url = process.argv[2];
if (url === undefined) throw new Error("usage: node tools/layout.mjs <url>");

const browser = await launch();
try {
	const page = await browser.newPage();
	await page.goto(url);
	await sleep(7000);
	const report = await page.evaluate(`
		const box = (element) => {
			if (element === null) return null;
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return {
				tag: element.tagName,
				className: typeof element.className === 'string' ? element.className : '',
				attrs: Object.fromEntries([...element.attributes].map((a) => [a.name, a.value])),
				rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
				position: style.position,
				display: style.display,
				gridTemplateColumns: style.gridTemplateColumns,
				overflow: style.overflow,
			};
		};
		const center = document.querySelector('[class*="centerCol"]');
		const frame = center?.parentElement ?? null;
		const sidebar = document.querySelector('[class*="sidebarCol"]');
		const rightbar = document.querySelector('[class*="rightbarCol"]');
		const overlay = document.querySelector('[class*="overlayLayer"]');
		const header = document.querySelector('header[data-window-drag]');
		const seat = document.querySelector('[data-composer-seat]');
		const card = document.querySelector('[data-composer-card="true"]');
		const input = document.querySelector('[data-composer-input="true"]');
		const send = document.querySelector('[data-conversation-region="composer"] [class*="primary"]');
		return {
			innerWidth: innerWidth,
			innerHeight: innerHeight,
			frame: box(frame),
			center: box(center),
			sidebar: box(sidebar),
			rightbar: box(rightbar),
			overlay: box(overlay),
			header: box(header),
			seat: box(seat),
			card: box(card),
			input: box(input),
			send: box(send),
			scrollWidth: document.documentElement.scrollWidth,
			hasHorizontalOverflow: document.documentElement.scrollWidth > innerWidth,
		};
	`);
	console.log(JSON.stringify(report, null, 2));
} finally {
	await browser.close();
}
