/**
 * End-to-end test of the offline outbox.
 *
 * The browser is taken offline, a message is written and sent, and the link
 * is restored: the message must go out on its own, and the composer must end
 * up empty again.
 *
 * Usage: node tools/outbox-test.mjs <url>
 */
import { launch, sleep } from "./cdp.mjs";

const url = process.argv[2];
if (url === undefined) throw new Error("usage: node tools/outbox-test.mjs <url>");

const browser = await launch();
try {
	const page = await browser.newPage();
	await page.send("Network.enable");
	await page.goto(url);
	await sleep(8000);

	// The application may open a first-run notice; it blocks the composer.
	await page.evaluate(`
		const modal = document.querySelector('[role="dialog"]');
		if (modal === null) return 'none';
		const buttons = [...modal.querySelectorAll('button')];
		const button = buttons.find((entry) => /閉じる|close|OK|同意|確認|了解|続行|開始/i.test((entry.getAttribute('aria-label') ?? '') + ' ' + (entry.textContent ?? ''))) ?? buttons[buttons.length - 1];
		if (button !== undefined) button.click();
		return 'dismissed';
	`);
	await sleep(800);

	/**
	 * Read the state of the phone half.
	 * @returns the chip text, its state, the composer text and the pending count.
	 */
	const read = () => page.evaluate(`
		const chip = document.querySelector('.dsh-mobile-chip');
		const input = document.querySelector('[data-composer-input="true"]');
		let pending = 0;
		try { pending = JSON.parse(localStorage.getItem('dsh.mobile.outbox') ?? '[]').length; } catch {}
		return {
			chip: chip === null ? null : chip.textContent,
			state: chip === null ? null : chip.getAttribute('data-state'),
			pending,
			draft: input === null ? null : (input.innerText ?? '').trim(),
		};
	`);

	console.log("1. online          ", JSON.stringify(await read()));

	// Go offline: the WebSocket to the Host dies.
	await page.send("Network.emulateNetworkConditions", {
		offline: true,
		latency: 0,
		downloadThroughput: 0,
		uploadThroughput: 0,
	});
	for (let attempt = 0; attempt < 30; attempt += 1) {
		await sleep(1000);
		const state = await read();
		if (state.state === "disconnected") break;
	}
	console.log("2. offline         ", JSON.stringify(await read()));

	// Write a message and try to send it while the PC is unreachable.
	await page.click('[data-composer-input="true"]');
	await sleep(200);
	await page.send("Input.insertText", { text: "オフライン中のテスト送信" });
	await sleep(500);
	const beforeSend = await read();
	await page.evaluate(`
		const send = document.querySelector('[data-conversation-region="composer"] [class*="primary"]');
		send.click();
		return true;
	`);
	await sleep(2500);
	console.log("3. after send      ", JSON.stringify(beforeSend), "->", JSON.stringify(await read()));

	// Restore the link.
	await page.send("Network.emulateNetworkConditions", {
		offline: false,
		latency: 0,
		downloadThroughput: -1,
		uploadThroughput: -1,
	});
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await sleep(1000);
		const state = await read();
		if (state.state === "connected" && state.pending === 0 && state.draft === "") break;
	}
	console.log("4. link restored   ", JSON.stringify(await read()));
	const delivered = await page.evaluate(`
		const needle = 'オフライン中のテスト送信';
		const hits = [...document.querySelectorAll('*')].filter((element) => element.children.length === 0 && (element.textContent ?? '').includes(needle));
		return { occurrences: hits.length, first: hits[0]?.textContent?.slice(0, 80) ?? null };
	`);
	console.log("5. on the Host page", JSON.stringify(delivered));
} finally {
	await browser.close();
}
