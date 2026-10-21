/**
 * Reload the phone app and collect console output and exceptions.
 *
 * Usage: node tools/webview-log.mjs [seconds]
 */
import { execFileSync } from "node:child_process";

const adb = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const run = (args) => execFileSync(adb, args, { encoding: "utf8" });
const seconds = Number(process.argv[2] ?? 20);

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
const logs = [];
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
	if (message.method === "Runtime.consoleAPICalled") {
		const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
		logs.push(`[${message.params.type}] ${text}`);
	}
	if (message.method === "Runtime.exceptionThrown") {
		const details = message.params.exceptionDetails;
		logs.push(`[exception] ${details.exception?.description ?? details.text}`);
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

await send("Runtime.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
console.log(logs.join("\n"));
client.close();
