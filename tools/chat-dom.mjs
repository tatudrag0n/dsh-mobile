/**
 * Inspect how the chat view renders the conversation in the phone WebView.
 *
 * Usage: node tools/chat-dom.mjs
 */
import { execFileSync } from "node:child_process";

const adb = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const run = (args) => execFileSync(adb, args, { encoding: "utf8" });

const pid = run(["shell", "pidof", "dev.tatudrag0n.dshmobile"]).trim();
try {
	run(["forward", "--remove", "tcp:9222"]);
} catch {
	// no listener yet
}
run(["forward", "tcp:9222", `localabstract:webview_devtools_remote_${pid}`]);
const targets = JSON.parse(await (await fetch("http://127.0.0.1:9222/json")).text());
const page = targets.find((target) => target.type === "page");

const client = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
client.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	const resolver = pending.get(message.id);
	if (resolver) {
		pending.delete(message.id);
		resolver(message);
	}
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

const expression = `(() => {
	const scroll = document.querySelector('[data-conversation-scroll]') ?? document.body;
	const walk = (node, depth) => {
		const lines = [];
		for (const child of node.children ?? []) {
			const cls = (child.getAttribute('class') ?? '').slice(0, 40);
			const slot = child.getAttribute('data-slot') ?? '';
			const part = child.getAttribute('data-chat-group-part') ?? '';
			lines.push('  '.repeat(depth) + child.tagName + ' slot=' + slot + ' part=' + part + ' cls=' + cls + ' text=' + JSON.stringify((child.innerText ?? '').trim().slice(0, 40)));
			if (depth < 3) lines.push(...walk(child, depth + 1));
		}
		return lines;
	};
	return JSON.stringify({ tree: walk(scroll, 0).slice(0, 40) }, null, 1);
})()`;

const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
console.log(result.result?.result?.value ?? JSON.stringify(result));
client.close();
