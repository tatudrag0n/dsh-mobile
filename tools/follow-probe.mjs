/**
 * Follow a session over the DSH remote mux and report what comes back.
 *
 * Usage: node tools/follow-probe.mjs <sessionId> [host]
 */
import { readFileSync } from "node:fs";

const card = JSON.parse(readFileSync("C:\\Users\\tatud\\.dsh\\mobile-pair.json", "utf8"));
const token = new URL(card.lanUrl).searchParams.get("token");
const origin = process.argv[3] ?? "http://127.0.0.1:3080";
const sessionId = process.argv[2];
if (!sessionId) throw new Error("usage: node tools/follow-probe.mjs <sessionId> [host]");

// Get the session cookie the browser would receive.
const bootstrap = await fetch(`${origin}/?token=${token}`, { redirect: "manual" });
const cookie = (bootstrap.headers.getSetCookie?.() ?? []).map((entry) => entry.split(";")[0]).join("; ");
console.log(`cookie: ${cookie ? "yes" : "no"}`);

const socket = new WebSocket(`${origin.replace("http", "ws")}/api/remote.mux`, { headers: { cookie } });
let nextId = 1;
socket.addEventListener("message", (event) => {
	const text = typeof event.data === "string" ? event.data : "<binary>";
	console.log(`R ${text.slice(0, 700)}`);
});
socket.addEventListener("error", (event) => console.log(`error: ${event.message ?? "unknown"}`));
await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve);
	socket.addEventListener("error", reject);
});

const streamId = `probe-${nextId++}`;
const frame = {
	type: "open",
	streamId,
	endpoint: "session/follow",
	payload: { args: { request: { address: { kind: "session", sessionId } } } },
};
console.log(`S ${JSON.stringify(frame).slice(0, 300)}`);
socket.send(JSON.stringify(frame));

await new Promise((resolve) => setTimeout(resolve, 6000));
socket.close();
