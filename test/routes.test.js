/**
 * Integration tests of the running host.
 *
 * They need a booted Host, so they are skipped unless DSH_MOBILE_TEST_URL
 * points at one:
 *
 *   $env:DSH_MOBILE_TEST_URL = "http://127.0.0.1:3080"
 *   node --test test/
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const base = process.env.DSH_MOBILE_TEST_URL;
const pairFile = process.env.DSH_MOBILE_PAIR_FILE ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "mobile-pair.json");

/**
 * The pairing card of the running host.
 * @returns the parsed card.
 */
async function card() {
	return JSON.parse(await readFile(pairFile, "utf8"));
}

test("the pairing page is served", { skip: base === undefined }, async () => {
	const response = await fetch(`${base}/mobile`);
	assert.equal(response.status, 200);
	const body = await response.text();
	assert.match(body, /ペアリングPIN/);
});

test("the service worker is served at the origin root", { skip: base === undefined }, async () => {
	const response = await fetch(`${base}/sw.js`);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /javascript/);
});

test("the manifest and the icons are served", { skip: base === undefined }, async () => {
	const manifest = await fetch(`${base}/mobile/manifest.webmanifest`);
	assert.equal(manifest.status, 200);
	const parsed = await manifest.json();
	assert.equal(parsed.start_url, "/");
	assert.ok(parsed.icons.some((icon) => icon.sizes === "192x192"));
	for (const icon of parsed.icons) {
		const response = await fetch(`${base}${icon.src}`);
		assert.equal(response.status, 200, `${icon.src} is served`);
	}
});

test("a requester without a session is asked for the PIN", { skip: base === undefined }, async () => {
	const response = await fetch(`${base}/mobile/pair`);
	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.equal(payload.status, "pin-required");
	assert.equal(payload.url, undefined, "the launch URL stays behind the PIN");
});

test("a wrong PIN is refused", { skip: base === undefined }, async () => {
	const response = await fetch(`${base}/mobile/pair`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ pin: "000000" }),
	});
	assert.equal(response.status, 403);
});

test("the right PIN hands out the launch URL", { skip: base === undefined }, async () => {
	const current = await card();
	const response = await fetch(`${base}/mobile/pair`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ pin: current.pin }),
	});
	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.equal(payload.status, "ok");
	assert.match(payload.url, /\?token=/, "the URL carries the launch token");
	assert.equal(payload.pinRequired, false);
});
