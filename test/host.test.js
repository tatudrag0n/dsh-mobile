/**
 * Unit tests of the host half's pure helpers.
 *
 * Run with: node --test test/
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_LOCKOUT_MINUTES,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_PAIR_PATH,
	generatePin,
	normalizeExtraUrl,
	pinMatches,
	rankAddress,
	renderTerminalQr,
	resolveOptions,
} from "../lib/host.js";

test("resolveOptions falls back to the documented defaults", () => {
	const options = resolveOptions(undefined);
	assert.equal(options.pairPath, DEFAULT_PAIR_PATH);
	assert.equal(options.pin, "");
	assert.equal(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
	assert.equal(options.lockoutMinutes, DEFAULT_LOCKOUT_MINUTES);
	assert.deepEqual(options.lanUrls, []);
});

test("resolveOptions normalizes the pair path", () => {
	assert.equal(resolveOptions({ pairPath: "phone/" }).pairPath, "/phone");
	assert.equal(resolveOptions({ pairPath: "//phone//" }).pairPath, "/phone");
	assert.equal(resolveOptions({ pairPath: "" }).pairPath, DEFAULT_PAIR_PATH);
});

test("resolveOptions only accepts a PIN that looks like one", () => {
	assert.equal(resolveOptions({ pin: "123456" }).pin, "123456");
	assert.equal(resolveOptions({ pin: "12" }).pin, "");
	assert.equal(resolveOptions({ pin: "abcdef" }).pin, "");
	assert.equal(resolveOptions({ pin: 123456 }).pin, "");
});

test("rankAddress prefers the routable private ranges", () => {
	assert.ok(rankAddress("192.168.0.166") < rankAddress("10.0.0.2"));
	assert.ok(rankAddress("10.0.0.2") < rankAddress("172.16.0.2"));
	assert.ok(rankAddress("172.16.0.2") < rankAddress("8.8.8.8"));
	assert.ok(rankAddress("8.8.8.8") < rankAddress("169.254.83.107"));
});

test("generatePin returns six digits", () => {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		assert.match(generatePin(), /^[0-9]{6}$/);
	}
});

test("pinMatches compares the presented PIN exactly", () => {
	assert.equal(pinMatches("123456", "123456"), true);
	assert.equal(pinMatches("123456", "654321"), false);
	assert.equal(pinMatches(undefined, "123456"), false);
});

test("normalizeExtraUrl completes the origin", () => {
	assert.equal(normalizeExtraUrl("pc.local", 3080), "http://pc.local:3080");
	assert.equal(normalizeExtraUrl("https://pc.example.ts.net", 3080), "https://pc.example.ts.net");
	assert.equal(normalizeExtraUrl("http://pc.local:9999/", 3080), "http://pc.local:9999");
	assert.equal(normalizeExtraUrl("pc.local:8080", 3080), "http://pc.local:8080");
});

test("renderTerminalQr draws a square block of ASCII", () => {
	const block = renderTerminalQr("http://192.168.0.166:3080/?token=abc");
	const lines = block.split("\n");
	assert.ok(lines.length > 10, "the block has a row per module");
	assert.equal(lines[0], lines[lines.length - 1], "the block is closed by a border");
	for (const line of lines) {
		assert.match(line, /^[# ]+$/, "the block uses only ASCII blocks and spaces");
	}
});
