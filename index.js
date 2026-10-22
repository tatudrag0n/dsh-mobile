/**
 * @local/dsh-mobile — host half of the phone-facing surface.
 *
 * The phone is a client of the same DSH Host the PC uses, so "syncing" is not
 * a copy step: one Host owns the session store, and both clients read and
 * write it live. This half owns the way a phone gets into that Host and the
 * way a phone keeps working as an installed app:
 *
 *   GET  <pairPath>                 the pairing card (QR + PIN prompt)
 *   GET  <pairPath>/pair            pairing status for the requester
 *   POST <pairPath>/pair            exchange the pairing PIN for the URL
 *   GET  <pairPath>/qr.js           the QR encoder the card renders with
 *   GET  <pairPath>/icon.svg        the app icon
 *   GET  <pairPath>/offline.html    the service worker's offline fallback
 *   GET  /sw.js                     the service worker (root scope)
 *
 * Authentication has two doors, and they answer different questions. A request
 * that already carries the Host's browser cookie is the owner and may read the
 * launch URL directly. Any other request must present the pairing PIN, which
 * the owner reads off the PC screen; wrong PINs are counted and the door locks
 * for a while. The launch URL is the process's one-shot token, so the phone
 * trades it for a signed cookie that lasts `cookieMaxAgeDays` (30 by default).
 */
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST, OFFLINE_PAGE, PAIR_PAGE, SERVICE_WORKER } from "./assets/pages.js";
import {
	DEFAULT_PAIR_PATH,
	PAIR_FILE,
	dshHome,
	generatePin,
	lanAddresses,
	normalizeExtraUrl,
	renderTerminalQr,
	resolveOptions,
} from "./lib/host.js";

/** Stable plugin name. */
export const name = "dsh-mobile";
/** Services this half needs: the HTTP carrier and the authenticated channel. */
export const inject = ["webServer", "connection"];

/**
 * Read the whole request body as text.
 * @param request - the incoming request.
 * @returns the body text.
 */
/**
 * The service worker source, with a cache name that changes whenever the
 * client assets change.
 *
 * The worker caches the app shell cache-first, so a fixed cache name would
 * keep serving an outdated client.js to the phone forever. Hashing the
 * client assets into the cache name makes the browser install a new worker
 * (and drop the old cache) as soon as the plugin changes.
 *
 * @returns the service worker source.
 */
function serviceWorkerSource() {
	let version = "0";
	try {
		const hash = createHash("sha256");
		for (const file of ["client.js", "assets/pages.js"]) {
			hash.update(readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url))));
		}
		version = hash.digest("hex").slice(0, 12);
	} catch {
		// Fall back to a fixed version; the worker still works, just not versioned.
	}
	return SERVICE_WORKER.replace("__DSH_MOBILE_VERSION__", version);
}

async function readBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * The client address of a request, for the PIN attempt counter.
 * @param request - the incoming request.
 * @returns the address text.
 */
function clientAddress(request) {
	const forwarded = request.headers["x-forwarded-for"];
	if (typeof forwarded === "string" && forwarded !== "") return forwarded.split(",")[0].trim();
	return request.socket?.remoteAddress ?? "unknown";
}

/**
 * Mount the phone surface.
 * @param ctx - Host plugin context.
 * @param config - the resolved row config.
 */
export function apply(ctx, config) {
	const options = resolveOptions(config);
	const pin = options.pin === "" ? generatePin() : options.pin;
	const failures = new Map();
	// This Host build serves plain HTTP. A TLS front end (a reverse proxy, or
	// `tailscale serve`) is what turns the LAN address into an https:// one.
	const protocol = "http";
	const bindHost = ctx.webServer.host;
	const addresses = lanAddresses();
	/**
	 * The live facts about the listener. They are read on demand because the
	 * port settles only after the server finished listening, which can happen
	 * after this plugin mounts.
	 * @returns the listener facts.
	 */
	function listener() {
		const current = ctx.webServer.port ?? ctx.webServer.config?.port;
		const loopback = `${protocol}://127.0.0.1:${String(current)}`;
		const lan = addresses[0] === undefined ? undefined : `${protocol}://${addresses[0]}:${String(current)}`;
		return {
			port: current,
			loopback,
			lan,
			launchUrl: ctx.connection.authenticatedUrl(loopback),
			lanLaunchUrl: lan === undefined ? undefined : ctx.connection.authenticatedUrl(lan),
			extra: options.lanUrls.map((entry) => normalizeExtraUrl(entry, current, protocol)),
		};
	}

	/**
	 * The pairing card, also written next to the Harness home so the PC side
	 * can print it without reading this process's output.
	 * @returns the card object.
	 */
	function card() {
		const current = listener();
		return {
			version: 1,
			pin,
			port: current.port,
			protocol,
			bindHost,
			lanAddresses: addresses,
			extraUrls: current.extra,
			url: current.launchUrl,
			lanUrl: current.lanLaunchUrl,
			pairUrl: current.lan === undefined ? undefined : `${current.lan}${options.pairPath}`,
			generatedAt: new Date().toISOString(),
		};
	}

	/**
	 * Write the pairing card to the Harness home.
	 * @returns the write promise.
	 */
	async function writeCard() {
		const target = join(dshHome(), PAIR_FILE);
		try {
			const temporary = `${target}.tmp`;
			await writeFile(temporary, `${JSON.stringify(card(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(temporary, target);
		} catch (error) {
			ctx.logger.warn(`dsh-mobile: cannot write ${target}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Whether this requester may read the launch URL without the PIN.
	 * @param request - the incoming request.
	 * @returns true when the request carries a valid Host session.
	 */
	function isOwner(request) {
		const admission = ctx.connection.admit(request);
		return !("rejection" in admission);
	}

	/**
	 * The response body for a pairing request.
	 * @param request - the incoming request.
	 * @returns the payload object.
	 */
	function pairingPayload() {
		const current = listener();
		return {
			status: "ok",
			url: current.lan === undefined ? current.launchUrl : current.lanLaunchUrl,
			host: current.lan ?? `127.0.0.1:${String(current.port)}`,
			alternatives: current.extra.map((entry) => ctx.connection.authenticatedUrl(entry)),
			pinRequired: false,
		};
	}

	/**
	 * Check a presented PIN against the lockout counter.
	 * @param address - the client address.
	 * @param presented - the PIN the client sent.
	 * @returns `{ ok: true }` or `{ ok: false, reason }`.
	 */
	function checkPin(address, presented) {
		const record = failures.get(address);
		const now = Date.now();
		if (record !== undefined && record.lockedUntil > now) return { ok: false, reason: "locked" };
		if (record !== undefined && record.lockedUntil <= now) failures.delete(address);
		if (presented !== pin) {
			const next = (record?.attempts ?? 0) + 1;
			if (next >= options.maxAttempts) {
				failures.set(address, { attempts: next, lockedUntil: now + options.lockoutMinutes * 60_000 });
				return { ok: false, reason: "locked" };
			}
			failures.set(address, { attempts: next, lockedUntil: 0 });
			return { ok: false, reason: "wrong" };
		}
		failures.delete(address);
		return { ok: true };
	}

	/**
	 * Send a JSON body.
	 * @param response - the response to write.
	 * @param status - the status code.
	 * @param payload - the body object.
	 */
	function sendJson(response, status, payload) {
		const body = JSON.stringify(payload);
		response.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"content-length": Buffer.byteLength(body),
		});
		response.end(body);
	}

	/**
	 * Send a static body.
	 * @param response - the response to write.
	 * @param status - the status code.
	 * @param contentType - the content type.
	 * @param body - the body text.
	 */
	function sendText(response, status, contentType, body) {
		response.writeHead(status, {
			"content-type": contentType,
			"cache-control": "no-store",
			"content-length": Buffer.byteLength(body),
		});
		response.end(body);
	}

	// The pairing card and the static surfaces.
	const qrLibrary = readFile(fileURLToPath(new URL("./vendor/qrcode.js", import.meta.url)), "utf8").catch(() => "");
	const iconSvg = readFile(fileURLToPath(new URL("./assets/icon.svg", import.meta.url)), "utf8").catch(() => "");
	// The PNG icons are what iOS and Android put on the home screen; the SVG
	// is the fallback for the manifest.
	const iconBuffers = new Map();
	for (const [size, file] of [[180, "icon-180.png"], [192, "icon-192.png"], [512, "icon-512.png"]]) {
		try {
			iconBuffers.set(size, readFileSync(fileURLToPath(new URL(`./assets/${file}`, import.meta.url))));
		} catch {
			/* a missing icon only costs the home-screen picture */
		}
	}

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: options.pairPath,
		handler: (request, response) => {
			sendText(response, 200, "text/html; charset=utf-8", PAIR_PAGE);
		},
	}), "dsh-mobile: pairing page");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${options.pairPath}/pair`,
		handler: async (request, response) => {
			if (request.method === "GET") {
				if (isOwner(request)) {
					sendJson(response, 200, pairingPayload());
					return;
				}
				sendJson(response, 200, { status: "pin-required" });
				return;
			}
			if (request.method !== "POST") {
				sendJson(response, 405, { status: "error", reason: "method" });
				return;
			}
			let presented = "";
			try {
				const body = JSON.parse(await readBody(request));
				if (typeof body?.pin === "string") presented = body.pin.trim();
			} catch {
				presented = "";
			}
			const verdict = checkPin(clientAddress(request), presented);
			if (!verdict.ok) {
				sendJson(response, 403, { status: "error", reason: verdict.reason });
				return;
			}
			sendJson(response, 200, pairingPayload());
		},
	}), "dsh-mobile: pairing exchange");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${options.pairPath}/qr.js`,
		handler: async (request, response) => {
			const body = await qrLibrary;
			if (body === "") {
				sendText(response, 404, "text/plain; charset=utf-8", "qr library unavailable");
				return;
			}
			sendText(response, 200, "text/javascript; charset=utf-8", body);
		},
	}), "dsh-mobile: qr library");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${options.pairPath}/icon.svg`,
		handler: async (request, response) => {
			const body = await iconSvg;
			if (body === "") {
				sendText(response, 404, "text/plain; charset=utf-8", "icon unavailable");
				return;
			}
			sendText(response, 200, "image/svg+xml", body);
		},
	}), "dsh-mobile: icon");

	for (const size of iconBuffers.keys()) {
		const buffer = iconBuffers.get(size);
		ctx.effect(() => ctx.webServer.register({
			kind: "exact",
			path: `${options.pairPath}/icon-${String(size)}.png`,
			handler: (request, response) => {
				response.writeHead(200, {
					"content-type": "image/png",
					"cache-control": "public, max-age=86400",
					"content-length": buffer.length,
				});
				response.end(buffer);
			},
		}), `dsh-mobile: icon ${String(size)}`);
	}

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${options.pairPath}/offline.html`,
		handler: (request, response) => {
			sendText(response, 200, "text/html; charset=utf-8", OFFLINE_PAGE);
		},
	}), "dsh-mobile: offline page");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${options.pairPath}/manifest.webmanifest`,
		handler: (request, response) => {
			sendJson(response, 200, MANIFEST);
		},
	}), "dsh-mobile: manifest");

	// The service worker answers to the origin root so its scope covers the
	// whole app; the shipped SPA fallback would otherwise answer with the
	// index page.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/sw.js",
		handler: (request, response) => {
			sendText(response, 200, "text/javascript; charset=utf-8", serviceWorkerSource());
		},
	}), "dsh-mobile: service worker");

	// The client half reads this global: the pair path it offers, the LAN
	// addresses to show, and whether this Host is reachable off the loopback.
	ctx.on("webserver/index-inject", (table) => {
		const current = listener();
		table.push({
			kind: "global",
			name: "__DSH_MOBILE__",
			value: {
				pairPath: options.pairPath,
				port: current.port,
				protocol,
				bindHost,
				lanAddresses: addresses,
				extraUrls: current.extra,
				lanReachable: current.lan !== undefined,
			},
		});
	});

	// The owner reads the PIN off the PC screen; the terminal card is the
	// reliable channel, and the card file is the fallback for a Host whose
	// output nobody sees (the desktop app).
	void writeCard();
	const current = listener();
	console.log("dsh-mobile: phone pairing ready");
	console.log(`dsh-mobile:   PIN   ${pin}`);
	console.log(`dsh-mobile:   URL   ${current.lan === undefined ? current.launchUrl : current.lanLaunchUrl}`);
	if (current.lan !== undefined) console.log(`dsh-mobile:   PIN page ${current.lan}${options.pairPath}`);
	if (current.lan === undefined) {
		console.log("dsh-mobile:   no LAN address found; bind the webserver to 0.0.0.0 to reach this host from a phone");
	} else {
		console.log(renderTerminalQr(current.lanLaunchUrl));
	}
	for (const extra of current.extra) {
		console.log(`dsh-mobile:   alt   ${ctx.connection.authenticatedUrl(extra)}`);
	}
}
