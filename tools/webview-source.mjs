/**
 * Find the script sources the phone app actually loaded.
 *
 * Usage: node tools/webview-source.mjs <needle>
 */
import { execFileSync } from "node:child_process";

const adb = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const run = (args) => execFileSync(adb, args, { encoding: "utf8" });
const needle = process.argv[2] ?? "__DSH_MOBILE_MIRROR__";

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
const parsed = [];
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
	if (message.method === "Debugger.scriptParsed") parsed.push(message.params);
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

await send("Debugger.enable");
await new Promise((resolve) => setTimeout(resolve, 1500));
const list = parsed;
console.log(`scripts: ${list.length}`);
for (const script of list) {
	if (!script.url.includes("/plugins/")) continue;
	const source = await send("Debugger.getScriptSource", { scriptId: script.scriptId });
	const text = source.result?.scriptSource ?? "";
	const has = text.includes(needle);
	console.log(`${has ? "HIT " : "    "} ${text.length} ${script.url.slice(-70)}`);
}
client.close();
