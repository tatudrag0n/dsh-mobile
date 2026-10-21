/**
 * Dump the phone-viewport DOM of the DSH Web UI.
 *
 * Usage: node tools/inspect.mjs <url> [screenshot-path]
 */
import { launch, sleep } from "./cdp.mjs";

const url = process.argv[2];
const shot = process.argv[3] ?? "C:/root/dsh-mobile/tools/phone.png";
if (url === undefined) throw new Error("usage: node tools/inspect.mjs <url> [screenshot]");

const browser = await launch();
try {
	const page = await browser.newPage();
	await page.goto(url);
	await sleep(7000);
	const report = await page.evaluate(`
		const describe = (element) => element === null ? null : {
			tag: element.tagName,
			className: typeof element.className === 'string' ? element.className : '',
			attrs: Object.fromEntries([...element.attributes].map((a) => [a.name, a.value])),
		};
		const composer = document.querySelector('[data-conversation-region="composer"]');
		const card = document.querySelector('[data-composer-card]');
		const editable = document.querySelector('[data-composer-card] [contenteditable="true"]');
		const buttons = [...document.querySelectorAll('button')].map((button) => ({
			className: typeof button.className === 'string' ? button.className : '',
			ariaLabel: button.getAttribute('aria-label'),
			title: button.getAttribute('title'),
			disabled: button.disabled,
			text: (button.textContent ?? '').trim().slice(0, 24),
			insideComposer: composer !== null && composer.contains(button),
		}));
		const frame = document.querySelector('[class*="frame"]');
		const columns = frame === null ? [] : [...frame.children].map((child) => ({
			className: typeof child.className === 'string' ? child.className : '',
			attrs: Object.fromEntries([...child.attributes].map((a) => [a.name, a.value])),
		}));
		return {
			title: document.title,
			url: location.href,
			viewport: { width: innerWidth, height: innerHeight },
			hasComposer: composer !== null,
			composerTag: describe(composer),
			cardHtml: card === null ? null : card.outerHTML.slice(0, 6000),
			editableTag: describe(editable),
			editableText: editable === null ? null : editable.innerText,
			buttons,
			columns,
			header: describe(document.querySelector('header')),
			meta: [...document.querySelectorAll('meta')].map((m) => ({ name: m.name, content: m.content, property: m.getAttribute('property') })),
			globalKeys: Object.keys(globalThis).filter((key) => key.startsWith('__DSH')).map((key) => key + '=' + typeof globalThis[key]),
		};
	`);
	console.log(JSON.stringify(report, null, 2));
	await page.screenshot(shot);
	console.log(`screenshot: ${shot}`);
} finally {
	await browser.close();
}
