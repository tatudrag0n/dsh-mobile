/**
 * Open the Harness web app and report what happens while it loads:
 * the console errors, the requests that failed, and what the session list
 * (the history) ends up containing.
 *
 * Usage: node tools/history-probe.mjs <url>
 */
import { launch, sleep } from "./cdp.mjs";

const url = process.argv[2];
if (!url) throw new Error("usage: node tools/history-probe.mjs <url>");

const browser = await launch();
try {
	const page = await browser.newPage();
	const console_ = [];
	const failures = [];
	const responses = [];
	const requests = [];
	const frames = [];

	page.on("Runtime.consoleAPICalled", (params) => {
		console_.push(`${params.type}: ${params.args.map((a) => a.value ?? a.description ?? a.type).join(" ")}`);
	});
	page.on("Runtime.exceptionThrown", (params) => {
		console_.push(`exception: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`);
	});
	page.on("Network.requestWillBeSent", (params) => {
		const request = params.request;
		if (!request) return;
		if (/\/api\//.test(request.url)) {
			requests.push(`${request.method} ${request.url} post=${(request.postData ?? "").slice(0, 200)}`);
		}
	});
	page.on("Network.responseReceived", (params) => {
		const { status, url: target } = params.response;
		responses.push(`${status} ${target}`);
		if (status >= 400) failures.push(`${status} ${target}`);
	});
	page.on("Network.loadingFailed", (params) => {
		failures.push(`failed ${params.errorText} ${params.type}`);
	});
	page.on("Network.webSocketCreated", (params) => {
		frames.push(`WS ${params.url}`);
	});
	page.on("Network.webSocketFrameSent", (params) => {
		frames.push(`S ${params.response.payloadData}`.slice(0, 600));
	});
	page.on("Network.webSocketFrameReceived", (params) => {
		frames.push(`R ${params.response.payloadData}`.slice(0, 600));
	});
	page.on("Network.webSocketFrameError", (params) => {
		failures.push(`ws error ${params.errorMessage}`);
	});

	await page.send("Network.enable");
	await page.send("Runtime.enable");
	await page.send("Log.enable");
	page.on("Log.entryAdded", (params) => {
		console_.push(`${params.entry.level}: ${params.entry.text}`);
	});

	await page.goto(url);
	await sleep(12000);

	const view = await page.evaluate(`
		const list = document.querySelector('[data-session-list], .dsh-session-list, [class*="session-list"]');
		const items = [...document.querySelectorAll('[data-session-id], [class*="session-item"], [class*="session-row"]')].map((el) => el.textContent.trim().slice(0, 40));
		const body = document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 1200);
		const session = document.querySelector('[data-slot="conversation.session"]');
		const groups = [...document.querySelectorAll('[data-chat-group-part]')].map((el) => el.innerText.trim().slice(0, 60));
		return {
			url: location.href,
			title: document.title,
			listFound: Boolean(list),
			listText: list ? list.textContent.trim().slice(0, 300) : null,
			items: items.slice(0, 10),
			conversationLength: session ? session.innerText.length : -1,
			conversationHead: session ? session.innerText.slice(0, 300) : null,
			groups: groups.length,
			groupSample: groups.slice(0, 3),
			body,
			chip: document.querySelector('.dsh-mobile-chip')?.getAttribute('data-state') ?? null,
			mobileState: window.__DSH_MOBILE_STATE__ ? window.__DSH_MOBILE_STATE__() : null,
		};
	`);

	const api = await page.evaluate(`
		const answer = {};
		try {
			const response = await fetch('/api/session/list', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			});
			const text = await response.text();
			answer.list = { status: response.status, length: text.length, head: text.slice(0, 600) };
		} catch (failure) {
			answer.list = { error: String(failure) };
		}
		return answer;
	`);

	console.log("== api ==");
	console.log(JSON.stringify(api, null, 2));
	console.log("== view ==");
	console.log(JSON.stringify(view, null, 2));
	console.log("== session requests ==");
	console.log(requests.length ? requests.join("\n") : "(none)");
	console.log("== failed requests ==");
	console.log(failures.length ? failures.join("\n") : "(none)");
	console.log("== websocket frames ==");
	console.log(frames.length ? frames.join("\n") : "(none)");
	console.log("== console ==");
	console.log(console_.length ? console_.join("\n") : "(none)");
	console.log("== responses ==");
	console.log(responses.join("\n"));
} finally {
	await browser.close();
}
