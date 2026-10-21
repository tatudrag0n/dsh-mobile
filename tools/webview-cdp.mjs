/**
 * Evaluate JavaScript inside the WebView of the DSH Mobile app on an
 * emulator or a real phone.
 *
 * The WebView exposes a DevTools socket; adb forwards it to the host, and
 * this script talks to it over the DevTools protocol.
 *
 * Usage: node tools/webview-cdp.mjs "<expression>"
 */
import { execFileSync } from "node:child_process";

const adb = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const expression = process.argv[2] ?? "document.title";
const packageName = process.argv[3] ?? "dev.tatudrag0n.dshmobile";

const run = (args) => execFileSync(adb, args, { encoding: "utf8" });

/** The pid of the app, needed for the DevTools socket name. */
const pid = run(["shell", "pidof", packageName]).trim();
if (!pid) throw new Error(`the app ${packageName} is not running`);
const socket = `webview_devtools_remote_${pid}`;

try {
	run(["forward", "--remove", "tcp:9222"]);
} catch {}
run(["forward", "tcp:9222", `localabstract:${socket}`]);

const targets = JSON.parse(await (await fetch("http://127.0.0.1:9222/json")).text());
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("no page target in the WebView");

const socketClient = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socketClient.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	const resolver = pending.get(message.id);
	if (resolver) {
		pending.delete(message.id);
		resolver(message);
	}
});
await new Promise((resolve, reject) => {
	socketClient.addEventListener("open", resolve);
	socketClient.addEventListener("error", reject);
});

const send = (method, params = {}) => new Promise((resolve) => {
	const id = nextId++;
	pending.set(id, resolve);
	socketClient.send(JSON.stringify({ id, method, params }));
});

await send("Runtime.enable");
const result = await send("Runtime.evaluate", {
	expression,
	awaitPromise: true,
	returnByValue: true,
});
console.log(JSON.stringify(result.result?.result?.value ?? result.result, null, 2));
socketClient.close();
