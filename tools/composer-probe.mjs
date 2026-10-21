/**
 * Debug the composer input: is it editable, and does text land in it?
 *
 * Usage: node tools/composer-test.mjs <url>
 */
import { launch, sleep } from "./cdp.mjs";

const url = process.argv[2];
if (url === undefined) throw new Error("usage: node tools/composer-test.mjs <url>");

const browser = await launch();
try {
	const page = await browser.newPage();
	await page.goto(url);
	await sleep(8000);
	const before = await page.evaluate(`
		const input = document.querySelector('[data-composer-input="true"]');
		return {
			exists: input !== null,
			contentEditable: input?.getAttribute('contenteditable'),
			isContentEditable: input?.isContentEditable,
			disabled: input?.getAttribute('disabled'),
			readOnly: input?.getAttribute('readonly'),
			phase: input?.getAttribute('data-phase'),
			childCount: input?.childNodes.length,
			rect: input === null ? null : input.getBoundingClientRect().toJSON(),
			html: input?.innerHTML.slice(0, 300),
		};
	`);
	console.log("before:", JSON.stringify(before, null, 2));
	const dialog = await page.evaluate(`
		const modal = document.querySelector('[role="dialog"]');
		if (modal === null) return { open: false };
		return {
			open: true,
			label: modal.getAttribute('aria-label'),
			buttons: [...modal.querySelectorAll('button')].map((button) => ({ label: button.getAttribute('aria-label'), text: (button.textContent ?? '').trim().slice(0, 30) })),
		};
	`);
	console.log("dialog:", JSON.stringify(dialog, null, 2));
	if (dialog.open) {
		await page.evaluate(`
			const modal = document.querySelector('[role="dialog"]');
			const buttons = [...modal.querySelectorAll('button')];
			const button = buttons.find((entry) => /閉じる|close|OK|同意|確認|了解|続行|開始/i.test((entry.getAttribute('aria-label') ?? '') + ' ' + (entry.textContent ?? ''))) ?? buttons[buttons.length - 1];
			if (button !== undefined) { button.click(); return 'clicked'; }
			return 'none';
		`);
		await sleep(800);
	}
	const hit = await page.evaluate(`
		const input = document.querySelector('[data-composer-input="true"]');
		const rect = input.getBoundingClientRect();
		const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
		return {
			at: at === null ? null : { tag: at.tagName, className: String(at.className), attrs: Object.fromEntries([...at.attributes].map((a) => [a.name, a.value])) },
			inputRect: rect.toJSON(),
			innerHeight: innerHeight,
			scrollY: scrollY,
		};
	`);
	console.log("hit test:", JSON.stringify(hit, null, 2));
	await page.click('[data-composer-input="true"]');
	await sleep(300);
	const focused = await page.evaluate(`
		const input = document.querySelector('[data-composer-input="true"]');
		const active = document.activeElement;
		return {
			active: active === null ? null : { tag: active.tagName, className: String(active.className), attrs: Object.fromEntries([...active.attributes].map((a) => [a.name, a.value])) },
			html: input.innerHTML.slice(0, 300),
			innerText: input.innerText,
		};
	`);
	console.log("after click:", JSON.stringify(focused, null, 2));
} finally {
	await browser.close();
}
