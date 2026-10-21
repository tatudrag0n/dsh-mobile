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

/**
 * Normalize the configured options into the shape the routes read.
 * @param {object} config - the resolved row config.
 * @returns {object} the effective options.
 */
export function resolveOptions(config) {
	const rawPath = typeof config?.pairPath === "string" && config.pairPath !== "" ? config.pairPath : DEFAULT_PAIR_PATH;
	const pairPath = `/${rawPath.replace(/^\/+/, "").replace(/\/+$/, "")}`;
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
 * @returns {string[]} the addresses.
 */
export function lanAddresses() {
	const found = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family !== "IPv4" && entry.family !== 4) continue;
			if (entry.internal) continue;
			found.push(entry.address);
		}
	}
	return [...new Set(found)].sort((left, right) => rankAddress(left) - rankAddress(right) || left.localeCompare(right));
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
