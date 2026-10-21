/**
 * Report where a button lives in the shell.
 *
 * Usage: node tools/ancestors.mjs <url> "<aria-label>"
 */
import { launch, sleep } from "./cdp.mjs";

const url = process.argv[2];
const label = process.argv[3] ?? "サイドバーを開く";
if (url === undefined) throw new Error("usage: node tools/ancestors.mjs <url> <aria-label>");

const browser = await launch();
try {
	const page = await browser.newPage();
	await page.goto(url);
	await sleep(7000);
	const report = await page.evaluate(`
		const wanted = ${JSON.stringify(label)};
		const button = [...document.querySelectorAll('button')].find((entry) => entry.getAttribute('aria-label') === wanted);
		if (button === undefined) return { found: false };
		const chain = [];
		let node = button;
		while (node !== null && node !== document.body) {
			const rect = node.getBoundingClientRect();
			chain.push({
				tag: node.tagName,
				className: typeof node.className === 'string' ? node.className : '',
				attrs: Object.fromEntries([...node.attributes].map((a) => [a.name, a.value])),
				rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
			});
			node = node.parentElement;
		}
		return { found: true, chain };
	`);
	console.log(JSON.stringify(report, null, 2));
} finally {
	await browser.close();
}
