import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DISCOVERY_PORT,
	BROADCAST_ADDRESS,
	buildAnnouncement,
	parseAnnouncement,
	announcementOrigin,
	dedupePeers,
	pruneStalePeers,
} from "../lib/discovery.js";

test("DISCOVERY_PORT is a valid port", () => {
	assert.ok(Number.isSafeInteger(DISCOVERY_PORT) && DISCOVERY_PORT > 0 && DISCOVERY_PORT <= 65535);
});

test("buildAnnouncement produces parseable JSON", () => {
	const text = buildAnnouncement({ deviceId: "d1", name: "phone", port: 3080, protocol: "http" });
	const parsed = JSON.parse(text);
	assert.equal(parsed.deviceId, "d1");
	assert.equal(parsed.port, 3080);
});

test("parseAnnouncement validates fields", () => {
	const text = buildAnnouncement({ deviceId: "d1", name: "phone", port: 3080 });
	assert.deepEqual(parseAnnouncement(text), {
		type: "dsh-host",
		version: 1,
		deviceId: "d1",
		name: "phone",
		port: 3080,
		protocol: "http",
	});
});

test("parseAnnouncement rejects bad input", () => {
	assert.equal(parseAnnouncement(""), null);
	assert.equal(parseAnnouncement("not json"), null);
	assert.equal(parseAnnouncement(JSON.stringify({ type: "other" })), null);
	assert.equal(parseAnnouncement(JSON.stringify({ type: "dsh-host", deviceId: "d1", port: 0 })), null);
	assert.equal(parseAnnouncement(JSON.stringify({ type: "dsh-host", deviceId: "", port: 3080 })), null);
});

test("announcementOrigin uses sender address", () => {
	const a = parseAnnouncement(buildAnnouncement({ deviceId: "d1", port: 3080 }));
	assert.equal(announcementOrigin(a, "192.168.0.5"), "http://192.168.0.5:3080");
});

test("dedupePeers keeps latest per device", () => {
	const peers = [
		{ deviceId: "d1", seenAt: 10 },
		{ deviceId: "d1", seenAt: 20 },
		{ deviceId: "d2", seenAt: 5 },
	];
	assert.equal(dedupePeers(peers).length, 2);
	const d1 = dedupePeers(peers).find((p) => p.deviceId === "d1");
	assert.equal(d1.seenAt, 20);
});

test("pruneStalePeers removes old peers", () => {
	const peers = [{ deviceId: "d1", seenAt: 100 }, { deviceId: "d2", seenAt: 900 }];
	const kept = pruneStalePeers(peers, 1000, 200);
	assert.equal(kept.length, 1);
	assert.equal(kept[0].deviceId, "d2");
});