/**
 * Look into the running DSH desktop app: what the window shows right now and
 * which requests fail.
 *
 * Usage: node tools/desktop-probe.mjs
 */
const port = 9230;

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("no page target");

const client = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const events = [];

client.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id !== undefined) {
		const resolver = pending.get(message.id);
		if (resolver) {
			pending.delete(message.id);
			resolver(message);
		}
		return;
	}
	events.push(message);
});
await new Promise((resolve, reject) => {
	client.addEventListener("open", resolve);
	client.addEventListener("error", reject);
});

const send = (method, params = {}) => new Promise((resolve) => {
	const id = nextId++;
	pending.set(id, resolve);
	client.send(JSON.stringify({ id, method, params }));
});

await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");

const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	return result.result?.result?.value ?? result.result;
};

const view = await evaluate(`
	(() => {
		const text = document.body.innerText.replace(/\\n+/g, ' | ');
		const errors = [...document.querySelectorAll('[class*="error"], [role="alert"], [data-state="error"]')]
			.map((el) => el.textContent.trim().slice(0, 120)).filter(Boolean);
		const history = [...document.querySelectorAll('*')]
			.filter((el) => el.children.length === 0 && /履歴|history/i.test(el.textContent))
			.map((el) => el.textContent.trim().slice(0, 120)).slice(0, 10);
		return { url: location.href, text: text.slice(0, 1500), errors: errors.slice(0, 10), history };
	})()
`);

console.log("== view ==");
console.log(JSON.stringify(view, null, 2));

const logs = events
	.filter((event) => event.method === "Log.entryAdded" || event.method === "Runtime.consoleAPICalled" || event.method === "Runtime.exceptionThrown")
	.map((event) => JSON.stringify(event.params).slice(0, 400));
console.log("== logs ==");
console.log(logs.length ? logs.join("\n") : "(none)");

const failed = events
	.filter((event) => event.method === "Network.loadingFailed" || (event.method === "Network.responseReceived" && event.params?.response?.status >= 400))
	.map((event) => JSON.stringify(event.params).slice(0, 300));
console.log("== failed ==");
console.log(failed.length ? failed.join("\n") : "(none)");

client.close();
