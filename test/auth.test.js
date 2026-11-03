/**
 * Unit tests of the pairing door and of the pages the phone is served.
 *
 * These are the two places where "the phone cannot log in" was decided: a
 * lockout that never reset, and a page that posted to a path the host may not
 * be serving. The page is tested by running the script it actually ships, so a
 * comment cannot pass for behaviour.
 *
 * Run with: node --test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
	DEFAULT_LOCKOUT_MINUTES,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_PAIR_PATH,
	createPinGate,
	isVirtualInterface,
	normalizePairPath,
} from "../lib/host.js";
import { PAIR_PAGE, SERVICE_WORKER, manifestFor, renderPairPath } from "../assets/pages.js";

/**
 * A clock the test moves by hand.
 * @param start - the first reading, in milliseconds.
 * @returns the clock: `now()` and `advance(minutes)`.
 */
function manualClock(start = 1_000_000) {
	let current = start;
	return {
		now: () => current,
		advance(minutes) {
			current += minutes * 60_000;
		},
	};
}

/**
 * The gate the host half uses, over a hand-driven clock.
 * @param clock - the clock above.
 * @returns the gate.
 */
function gateOver(clock) {
	return createPinGate(
		{ pin: "123456", maxAttempts: DEFAULT_MAX_ATTEMPTS, lockoutMinutes: DEFAULT_LOCKOUT_MINUTES },
		clock.now,
	);
}

test("wrong PINs lock the pairing door and an expired lockout opens it", () => {
	const clock = manualClock();
	const gate = gateOver(clock);
	for (let attempt = 0; attempt < DEFAULT_MAX_ATTEMPTS - 1; attempt += 1) {
		assert.deepEqual(gate.check("10.0.0.2", "000000"), { ok: false, reason: "wrong" });
	}
	assert.deepEqual(gate.check("10.0.0.2", "000000"), { ok: false, reason: "locked" });
	assert.deepEqual(gate.check("10.0.0.2", "123456"), { ok: false, reason: "locked" });

	clock.advance(DEFAULT_LOCKOUT_MINUTES);
	assert.deepEqual(gate.check("10.0.0.2", "123456"), { ok: true });
	assert.equal(gate.attemptsFor("10.0.0.2"), 0);
});

test("one typo after a lockout is a typo, not another lockout", () => {
	const clock = manualClock();
	const gate = gateOver(clock);
	for (let attempt = 0; attempt < DEFAULT_MAX_ATTEMPTS; attempt += 1) gate.check("10.0.0.3", "000000");
	clock.advance(DEFAULT_LOCKOUT_MINUTES);

	// The record of the expired lockout must not be reused: the count starts
	// again at one, so the door answers "wrong" instead of shutting for another
	// full lockout on the first mistake.
	assert.deepEqual(gate.check("10.0.0.3", "000000"), { ok: false, reason: "wrong" });
	assert.equal(gate.attemptsFor("10.0.0.3"), 1);
	for (let attempt = 0; attempt < DEFAULT_MAX_ATTEMPTS - 2; attempt += 1) {
		assert.deepEqual(gate.check("10.0.0.3", "000000"), { ok: false, reason: "wrong" });
	}
	assert.deepEqual(gate.check("10.0.0.3", "000000"), { ok: false, reason: "locked" });
});

test("a correct PIN clears the count, and the count is per address", () => {
	const clock = manualClock();
	const gate = gateOver(clock);
	gate.check("10.0.0.4", "000000");
	assert.equal(gate.attemptsFor("10.0.0.4"), 1);
	assert.deepEqual(gate.check("10.0.0.4", "123456"), { ok: true });
	assert.equal(gate.attemptsFor("10.0.0.4"), 0);
	// A different phone is not punished for the first one's typos.
	assert.deepEqual(gate.check("10.0.0.5", "123456"), { ok: true });
});

/**
 * Run the pairing page's own script against a stub DOM.
 *
 * The page the host writes is what the phone receives, so running its script is
 * the only way to know that a failed request is reported instead of swallowed,
 * and that the PIN goes to the path this host actually serves.
 * @param page - the served page.
 * @param respond - what `fetch` answers with.
 * @returns the elements the page touched, the requests it made, and the stub
 *   factory the page would have used itself.
 */
function runPairPage(page, respond) {
	const script = /<script>([\s\S]*?)<\/script>/.exec(page);
	assert.ok(script !== null, "the page carries its own script");
	const elements = new Map();
	const requests = [];
	const element = (id) => {
		if (!elements.has(id)) {
			elements.set(id, {
				id,
				textContent: "",
				value: "",
				children: [],
				style: {},
				listeners: {},
				classList: {
					added: [],
					removed: [],
					add(name) {
						this.added.push(name);
					},
					remove(name) {
						this.removed.push(name);
					},
				},
				addEventListener(type, handler) {
					this.listeners[type] = handler;
				},
				appendChild(child) {
					this.children.push(child);
				},
			});
		}
		return elements.get(id);
	};
	const sandbox = {
		document: {
			getElementById: element,
			createElement: (tag) => ({
				tag,
				width: 0,
				height: 0,
				getContext: () => ({ fillStyle: "", fillRect() {} }),
			}),
		},
		fetch: (url, options) => {
			requests.push({ url, options });
			return respond(url, options);
		},
		location: { href: "" },
		window: {},
		JSON,
		setTimeout,
	};
	runInNewContext(script[1], sandbox);
	return { elements, requests, element };
}

test("the pairing page sends the PIN to the path this host serves", () => {
	const { requests } = runPairPage(renderPairPath(PAIR_PAGE, "/ops"), () =>
		Promise.resolve({ json: async () => ({ status: "pin-required" }) }));
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, "/ops/pair");
	assert.equal(requests[0].options.method, "GET");
});

test("a pairing request that never completes is reported on the page", async () => {
	const { elements } = runPairPage(renderPairPath(PAIR_PAGE, "/ops"), () => Promise.reject(new Error("offline")));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(elements.get("error").textContent, "ホストに接続できません。Wi-Fi と PC の DSH を確認してください。");
	// The form is what the phone can act on, so it has to come back.
	assert.ok(elements.get("pin-form").classList.removed.includes("hidden"));
});

test("a wrong PIN is answered with the wrong-PIN message", async () => {
	const view = runPairPage(renderPairPath(PAIR_PAGE, "/ops"), () =>
		Promise.resolve({ json: async () => ({ status: "error", reason: "wrong" }) }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	// The page reads the field when the form is submitted, so the field is made
	// the same way the page makes it.
	view.element("pin").value = "000000";
	await view.element("pin-form").listeners.submit({ preventDefault() {} });
	assert.equal(view.element("error").textContent, "PIN が違います。PC に表示されている PIN を確認してください。");
});

test("the offline fallback the worker caches follows the pairing path", () => {
	const worker = renderPairPath(SERVICE_WORKER, "/ops");
	const offline = /const OFFLINE = '([^']*)';/.exec(worker);
	assert.ok(offline !== null, "the worker names its offline page");
	assert.equal(offline[1], "/ops/offline.html");
});

test("the manifest names its icons under the pairing path", () => {
	const manifest = manifestFor("/ops");
	assert.deepEqual(manifest.icons.map((icon) => icon.src), [
		"/ops/icon-192.png",
		"/ops/icon-512.png",
		"/ops/icon.svg",
	]);
	// The app itself still owns the origin root.
	assert.equal(manifest.start_url, "/");
	assert.equal(manifest.scope, "/");
	assert.equal("icons" in manifest, true);
});

test("a pairing path is stripped down to something a page can hold", () => {
	// The path is written into an attribute and a string literal, so a quote or
	// an angle bracket must never survive.
	assert.equal(renderPairPath("__DSH_PAIR_PATH__", "/a\"b'c<d>e"), "/abcde");
	assert.equal(renderPairPath("__DSH_PAIR_PATH__", ""), DEFAULT_PAIR_PATH);
	assert.equal(renderPairPath("__DSH_PAIR_PATH__", "/ops"), "/ops");
});

test("a configured pairing path is normalised before it becomes a route", () => {
	assert.equal(normalizePairPath("mobile"), "/mobile");
	assert.equal(normalizePairPath("/ops/"), "/ops");
	assert.equal(normalizePairPath("//deep/ops//"), "/deep/ops");
	assert.equal(normalizePairPath("/a\"b"), "/ab");
	// The root belongs to the Harness itself, not to the pairing page.
	assert.equal(normalizePairPath("/"), DEFAULT_PAIR_PATH);
	assert.equal(normalizePairPath("///"), DEFAULT_PAIR_PATH);
});

test("virtual adapters are recognised by name", () => {
	for (const name of ["vEthernet (WSL)", "docker0", "veth1a2b", "br-9f0c", "tun0", "tap0", "utun3", "wg0", "Tailscale"]) {
		assert.equal(isVirtualInterface(name), true, name);
	}
	for (const name of ["Wi-Fi", "wlan0", "eth0", "en0", "Ethernet", "enp3s0"]) {
		assert.equal(isVirtualInterface(name), false, name);
	}
});

/**
 * A Host context just real enough to mount the plugin.
 * @param port - the port the fake carrier listens on.
 * @returns the context and the routes it registered.
 */
function fakeHost(port) {
	const routes = new Map();
	const ctx = {
		webServer: {
			host: "127.0.0.1",
			port,
			register(route) {
				routes.set(route.path, route);
				return () => {};
			},
		},
		connection: {
			admit: () => ({ rejection: "no cookie" }),
			authenticatedUrl: (url) => `${url}/?token=stub`,
		},
		logger: { warn() {} },
		effect: (run) => run(),
		on: () => {},
	};
	return { ctx, routes };
}

/**
 * Mount the plugin against a throwaway Harness home.
 * @param config - the row config to mount with.
 * @returns the context, its routes and the home to clean up.
 */
async function mountHost(config) {
	const home = await mkdtemp(join(tmpdir(), "dsh-mobile-"));
	const previousHome = process.env.DSH_HOME;
	const previousLog = console.log;
	process.env.DSH_HOME = home;
	// The mount prints the PIN and a QR block; these tests want the routes.
	console.log = () => {};
	const { ctx, routes } = fakeHost(3080);
	try {
		const { apply } = await import("../index.js");
		apply(ctx, config);
	} finally {
		console.log = previousLog;
		process.env.DSH_HOME = previousHome;
	}
	return { ctx, routes, home };
}

/**
 * Call a route handler and collect what it wrote.
 * @param route - the registered route.
 * @returns the status and the body.
 */
async function callRoute(route) {
	let status = 0;
	let body = "";
	await route.handler({ method: "GET", headers: {}, socket: {} }, {
		writeHead(code) {
			status = code;
		},
		end(chunk) {
			body += chunk === undefined ? "" : String(chunk);
		},
	});
	return { status, body };
}

test("the host serves its pages under the configured path", async () => {
	const { routes, home } = await mountHost({ pairPath: "/ops", pin: "123456" });
	try {
		// A renamed pairing path used to leave the phone posting at /mobile/pair,
		// where nothing listened.
		assert.ok(routes.has("/ops"));
		assert.ok(routes.has("/ops/pair"));
		assert.ok(routes.has("/ops/qr.js"));
		assert.ok(routes.has("/ops/offline.html"));
		assert.ok(routes.has("/ops/manifest.webmanifest"));
		assert.equal(routes.has("/mobile/pair"), false);

		const page = await callRoute(routes.get("/ops"));
		assert.equal(page.status, 200);
		// The served page posts where this host listens, not where /mobile was.
		const { requests } = runPairPage(page.body, () =>
			Promise.resolve({ json: async () => ({ status: "pin-required" }) }));
		assert.equal(requests[0].url, "/ops/pair");

		const manifest = await callRoute(routes.get("/ops/manifest.webmanifest"));
		assert.equal(manifest.status, 200);
		assert.deepEqual(JSON.parse(manifest.body).icons.map((icon) => icon.src), [
			"/ops/icon-192.png",
			"/ops/icon-512.png",
			"/ops/icon.svg",
		]);
	} finally {
		await rm(home, { recursive: true, force: true, maxRetries: 5 });
	}
});

test("the PIN door answers over a real loopback socket", async () => {
	const { routes, home } = await mountHost({ pairPath: "/ops", pin: "123456", maxFailedPinAttempts: 3 });
	const pair = routes.get("/ops/pair");
	const server = createServer((request, response) => {
		void pair.handler(request, response).catch(() => {
			response.statusCode = 500;
			response.end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${String(server.address().port)}/ops/pair`;
	const post = (pin, forwarded) => fetch(base, {
		method: "POST",
		headers: { "content-type": "application/json", ...(forwarded === undefined ? {} : { "x-forwarded-for": forwarded }) },
		body: JSON.stringify({ pin }),
	});
	try {
		// No cookie and no PIN yet: the page is told to ask for one.
		const read = await fetch(base);
		assert.equal(read.status, 200);
		assert.equal((await read.json()).status, "pin-required");

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const wrong = await post("000000");
			assert.equal(wrong.status, 403);
			assert.equal((await wrong.json()).reason, "wrong");
		}
		const locked = await post("000000");
		assert.equal(locked.status, 403);
		assert.equal((await locked.json()).reason, "locked");
		const stillLocked = await post("123456");
		assert.equal(stillLocked.status, 403);

		// Another phone is not punished for this one's typos, and the right PIN
		// hands it the launch URL.
		const accepted = await post("123456", "10.9.9.9");
		assert.equal(accepted.status, 200);
		const payload = await accepted.json();
		assert.equal(payload.status, "ok");
		assert.ok(payload.url.includes("token=stub"));
		assert.equal(payload.pinRequired, false);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await rm(home, { recursive: true, force: true, maxRetries: 5 });
	}
});
