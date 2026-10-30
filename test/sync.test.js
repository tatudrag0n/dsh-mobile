import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isValidDeviceId,
	normalizeCursor,
	missingEvents,
	mergeEvents,
	pluginDiff,
	shouldSync,
	validateSyncMessage,
	mergePeers,
} from "../lib/sync.js";

test("isValidDeviceId rejects empty/blank", () => {
	assert.equal(isValidDeviceId(""), false);
	assert.equal(isValidDeviceId("   "), false);
	assert.equal(isValidDeviceId(null), false);
	assert.equal(isValidDeviceId("dev-1"), true);
});

test("normalizeCursor rejects missing device id", () => {
	assert.equal(normalizeCursor(null), null);
	assert.equal(normalizeCursor({}), null);
	assert.equal(normalizeCursor({ deviceId: "   " }), null);
});

test("normalizeCursor fills defaults", () => {
	assert.deepEqual(normalizeCursor({ deviceId: "  d1  ", sessionId: "s1" }), {
		deviceId: "d1",
		sessionId: "s1",
		lastEventId: "",
	});
});

test("missingEvents returns tail after anchor", () => {
	const events = [{ id: "a" }, { id: "b" }, { id: "c" }];
	assert.deepEqual(missingEvents(events, "a"), [{ id: "b" }, { id: "c" }]);
	assert.deepEqual(missingEvents(events, ""), events);
});

test("missingEvents sends all when anchor unknown", () => {
	const events = [{ id: "a" }, { id: "b" }];
	assert.deepEqual(missingEvents(events, "zzz"), events);
});

test("mergeEvents dedups and sorts", () => {
	const merged = mergeEvents(
		[{ id: "a", ts: 2 }, { id: "b", ts: 1 }],
		[{ id: "a", ts: 2 }, { id: "c", ts: 3 }]
	);
	assert.equal(merged.length, 3);
	assert.deepEqual(merged.map((e) => e.id), ["b", "a", "c"]);
});

test("pluginDiff computes symmetric difference", () => {
	assert.deepEqual(pluginDiff(["a", "b"], ["b", "c"]), {
		toInstall: ["c"],
		toRemove: ["a"],
	});
});

test("shouldSync gates", () => {
	assert.equal(shouldSync({ syncing: true, paired: true, onWifi: true, foreground: true }), false);
	assert.equal(shouldSync({ paired: false, onWifi: true, foreground: true }), false);
	assert.equal(shouldSync({ paired: true, onWifi: false, foreground: true }), false);
	assert.equal(shouldSync({ paired: true, onWifi: true, foreground: false }), false);
	assert.equal(shouldSync({ paired: true, onWifi: true, foreground: true }), true);
	assert.equal(shouldSync({ paired: true, onWifi: true, foreground: false, manual: true }), true);
});

test("validateSyncMessage accepts valid messages", () => {
	const msg = validateSyncMessage({ type: "events", from: "d1", sessionId: "s1", events: [{ id: "a" }] });
	assert.equal(msg.type, "events");
	assert.equal(msg.from, "d1");
	assert.equal(msg.events.length, 1);
});

test("validateSyncMessage rejects bad messages", () => {
	assert.equal(validateSyncMessage(null), null);
	assert.equal(validateSyncMessage({ type: "unknown", from: "d1" }), null);
	assert.equal(validateSyncMessage({ type: "events", from: "" }), null);
});

test("mergePeers dedups by deviceId", () => {
	const merged = mergePeers(
		[{ deviceId: "d1", seenAt: 10 }],
		[{ deviceId: "d1", seenAt: 20 }, { deviceId: "d2", seenAt: 5 }]
	);
	assert.equal(merged.length, 2);
	const d1 = merged.find((p) => p.deviceId === "d1");
	assert.equal(d1.seenAt, 20);
});