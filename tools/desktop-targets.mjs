/**
 * List every DevTools target of the running desktop app, including the
 * renderer that shows the chat view.
 */
const port = 9230;
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
console.log(`browser: ${version.Browser}  ws=${version.webSocketDebuggerUrl}`);

const client = new WebSocket(version.webSocketDebuggerUrl);
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

const targets = await send("Target.getTargets");
for (const target of targets.result?.targetInfos ?? []) {
	console.log(`${target.type} | ${target.title} | ${target.url} | attached=${target.attached}`);
}
client.close();
