/**
 * The pure helpers of the host half.
 *
 * They live apart from the plugin entry so they can be unit tested without
 * booting a Host: the routing, the pairing card and the address ranking are
 * where the mistakes would hurt.
 */
import { randomInt } from "node:crypto";
import { networkInterfaces } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** QR encoder (qrcode-generator, MIT) vendored under `vendor/`. */
export const qrcode = require("../vendor/qrcode.js");

/** Default prefix of every pairing route. */
export const DEFAULT_PAIR_PATH = "/mobile";
/** File inside the Harness home that carries the pairing card for the PC. */
export const PAIR_FILE = "mobile-pair.json";
/** Wrong PINs allowed before the pairing door locks. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Minutes a locked pairing door stays shut. */
export const DEFAULT_LOCKOUT_MINUTES = 10;
/** The port the Host serves the Web UI on unless it is configured otherwise. */
export const DEFAULT_PORT = 3080;

/**
 * Interface names that belong to a container, a virtual machine or a tunnel.
 *
 * They carry an address the phone usually cannot reach (a Docker bridge, the
 * WSL switch), so they are ranked after every physical adapter. They are not
 * dropped: a Tailscale or WireGuard address is the only way in when the phone
 * is on the same tailnet and not on the same Wi-Fi.
 */
const VIRTUAL_INTERFACE = /^(?:docker|veth|virbr|br-|vmnet|vboxnet|veethernet|hyper-v|virtualbox|wsl|loopback|tun|tap|utun|wg|tailscale|zt|zerotier|npcap|hamachi|radmin|bluetooth|pan)/i;

/**
 * Characters a pairing path may contain.
 *
 * The path becomes a route, an HTML attribute and a string literal inside the
 * page, so anything that could close an attribute or a quote is dropped before
 * it can reach a page.
 */
const UNSAFE_PAIR_PATH = /[^A-Za-z0-9/._~-]/g;

/**
 * Whether a network interface is a virtual one.
 * @param {string} name - the interface name from `os.networkInterfaces()`.
 * @returns {boolean} true when it is a tunnel or a virtual adapter.
 */
export function isVirtualInterface(name) {
	return typeof name === "string" && VIRTUAL_INTERFACE.test(name);
}

/**
 * Bring a configured pairing path into the shape the routes are registered
 * with: one leading slash, no trailing slash, and nothing that could break out
 * of an HTML attribute or a script string.
 * @param {string} input - the configured path.
 * @returns {string} the route prefix, never a bare "/".
 */
export function normalizePairPath(input) {
	const cleaned = `/${String(input).replace(/^\/+/, "").replace(/\/+$/, "").replace(UNSAFE_PAIR_PATH, "")}`;
	// The root belongs to the Harness itself, so a path that sanitizes down to
	// it is not a pairing prefix at all.
	return cleaned === "/" ? DEFAULT_PAIR_PATH : cleaned;
}

/**
 * Normalize the configured options into the shape the routes read.
 * @param {object} config - the resolved row config.
 * @returns {object} the effective options.
 */
export function resolveOptions(config) {
	const rawPath = typeof config?.pairPath === "string" && config.pairPath !== "" ? config.pairPath : DEFAULT_PAIR_PATH;
	const pairPath = normalizePairPath(rawPath);
	const pin = typeof config?.pin === "string" && /^[0-9]{4,8}$/.test(config.pin) ? config.pin : "";
	return {
		pairPath,
		pin,
		maxAttempts: Number.isSafeInteger(config?.maxFailedPinAttempts) ? config.maxFailedPinAttempts : DEFAULT_MAX_ATTEMPTS,
		lockoutMinutes: Number.isSafeInteger(config?.lockoutMinutes) ? config.lockoutMinutes : DEFAULT_LOCKOUT_MINUTES,
		lanUrls: Array.isArray(config?.lanUrls) ? config.lanUrls.filter((entry) => typeof entry === "string") : [],
	};
}

/**
 * Rank an IPv4 address by how likely a phone on the same network is to reach
 * it. A routable private range beats a link-local address, which on Windows
 * is what a virtual adapter hands out.
 * @param {string} address - an IPv4 address.
 * @returns {number} the sort rank, lower is better.
 */
export function rankAddress(address) {
	if (/^192\.168\./.test(address)) return 0;
	if (/^10\./.test(address)) return 1;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(address)) return 2;
	if (address.startsWith("169.254.")) return 9;
	return 5;
}

/**
 * Every routable IPv4 address of this machine, best candidate first.
 *
 * A physical adapter always beats a tunnel: on a developer machine the Docker
 * bridge and the WSL switch sort as well as the Wi-Fi adapter, and the phone
 * then gets an address only this machine can route to. The tunnels stay at the
 * end rather than disappear, because Tailscale is a legitimate way in.
 * @returns {string[]} the addresses.
 */
export function lanAddresses() {
	const found = [];
	for (const [name, entries] of Object.entries(networkInterfaces())) {
		const virtual = isVirtualInterface(name);
		for (const entry of entries ?? []) {
			if (entry.family !== "IPv4" && entry.family !== 4) continue;
			if (entry.internal) continue;
			found.push({ address: entry.address, virtual });
		}
	}
	// One address can sit on several adapters; a physical one wins.
	const unique = new Map();
	for (const entry of found) {
		const previous = unique.get(entry.address);
		if (previous === undefined || (previous.virtual && !entry.virtual)) unique.set(entry.address, entry);
	}
	return [...unique.values()]
		.sort((left, right) => Number(left.virtual) - Number(right.virtual)
			|| rankAddress(left.address) - rankAddress(right.address)
			|| left.address.localeCompare(right.address))
		.map((entry) => entry.address);
}

/**
 * A fresh six-digit pairing PIN.
 * @returns {string} the PIN text.
 */
export function generatePin() {
	return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * The Harness home directory.
 * @returns {string} its absolute path.
 */
export function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * Bring an advertised address into the shape the card prints: an origin.
 *
 * An entry with its own scheme is left alone (a TLS front end usually serves
 * the default port of that scheme). An entry without one is completed with
 * the host's scheme and port.
 * @param {string} entry - the configured address.
 * @param {number} port - the port the host listens on.
 * @param {string} scheme - the scheme to assume when the entry has none.
 * @returns {string} the origin.
 */
export function normalizeExtraUrl(entry, port, scheme = "http") {
	const trimmed = entry.trim().replace(/\/+$/, "");
	const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
	const withScheme = explicit ? trimmed : `${scheme}://${trimmed}`;
	try {
		const parsed = new URL(withScheme);
		if (!explicit && parsed.port === "") parsed.port = String(port);
		return parsed.origin;
	} catch {
		return withScheme;
	}
}

/**
 * Render text as a terminal QR block, two columns per module.
 * @param {string} text - the payload.
 * @returns {string} the block text.
 */
export function renderTerminalQr(text) {
	const qr = qrcode(0, "M");
	qr.addData(text, "Byte");
	qr.make();
	const count = qr.getModuleCount();
	const border = "  ".repeat(count + 4);
	const lines = [border];
	// Plain ASCII blocks: the host's console may not be able to print the
	// Unicode half blocks a terminal QR usually uses.
	for (let row = 0; row < count; row += 1) {
		let line = "  ";
		for (let column = 0; column < count; column += 1) line += qr.isDark(row, column) ? "##" : "  ";
		lines.push(`${line}  `);
	}
	lines.push(border);
	return lines.join("\n");
}

/**
 * Decide whether a presented PIN may open the pairing door.
 * @param {string} presented - the PIN the client sent.
 * @param {string} expected - the host's PIN.
 * @returns {boolean} the answer.
 */
export function pinMatches(presented, expected) {
	return typeof presented === "string" && presented === expected;
}

/**
 * The wrong-PIN counter and the lockout that guards the pairing door.
 *
 * A lockout that has expired starts from a clean slate. The record it leaves
 * behind must not be reused: keeping its count made the first typo after every
 * lockout lock the door again at once, so a single mistake cost another full
 * lockout and the phone never got in.
 *
 * @param {object} options - the effective options from {@link resolveOptions}.
 * @param {() => number} [clock] - the clock, injectable for tests.
 * @returns {object} the gate: `check(address, presented)` and `attemptsFor(address)`.
 */
export function createPinGate(options, clock = () => Date.now()) {
	const failures = new Map();
	return {
		/**
		 * Check a presented PIN against the lockout counter.
		 * @param address - the client address the counter belongs to.
		 * @param presented - the PIN the client sent.
		 * @returns `{ ok: true }` or `{ ok: false, reason }`.
		 */
		check(address, presented) {
			const now = clock();
			const record = failures.get(address);
			if (record !== undefined && record.lockedUntil > now) return { ok: false, reason: "locked" };
			// Only a record that is still counting carries over. The one an
			// expired lockout left behind is spent, and reusing its count is the
			// bug that made the first typo after a lockout lock the door again.
			const previous = record !== undefined && record.lockedUntil === 0 ? record.attempts : 0;
			if (record !== undefined) failures.delete(address);
			if (!pinMatches(presented, options.pin)) {
				const next = previous + 1;
				if (next >= options.maxAttempts) {
					failures.set(address, { attempts: next, lockedUntil: now + options.lockoutMinutes * 60_000 });
					return { ok: false, reason: "locked" };
				}
				failures.set(address, { attempts: next, lockedUntil: 0 });
				return { ok: false, reason: "wrong" };
			}
			return { ok: true };
		},
		/**
		 * The failures an address currently carries.
		 * @param address - the client address.
		 * @returns the count, zero when it is not locked out.
		 */
		attemptsFor(address) {
			return failures.get(address)?.attempts ?? 0;
		},
	};
}
