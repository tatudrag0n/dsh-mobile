import assert from "node:assert/strict";
import { test } from "node:test";
import {
	normalizePlugin,
	normalizePluginList,
	pluginVersionMap,
	pluginSyncManifest,
	mergePluginSets,
	compareVersions,
} from "../lib/plugin-sync.js";

test("normalizePlugin rejects empty id", () => {
	assert.equal(normalizePlugin(null), null);
	assert.equal(normalizePlugin({ id: "  " }), null);
	assert.deepEqual(normalizePlugin({ id: "p1", version: "1.0" }), { id: "p1", version: "1.0" });
});

test("normalizePluginList filters bad entries", () => {
	const list = normalizePluginList([{ id: "a" }, { id: "" }, null, { id: "b", version: "2" }]);
	assert.equal(list.length, 2);
});

test("pluginSyncManifest computes diff", () => {
	const manifest = pluginSyncManifest(
		[{ id: "a", version: "1.0" }, { id: "b", version: "2.0" }],
		[{ id: "a", version: "1.1" }, { id: "c", version: "3.0" }]
	);
	assert.deepEqual(manifest.toInstall, ["c"]);
	assert.deepEqual(manifest.toRemove, ["b"]);
	assert.equal(manifest.toUpdate.length, 1);
	assert.equal(manifest.toUpdate[0].id, "a");
	assert.deepEqual(manifest.inSync, []);
});

test("mergePluginSets prefers higher version", () => {
	const merged = mergePluginSets(
		[{ id: "a", version: "1.0" }],
		[{ id: "a", version: "1.5" }, { id: "b", version: "2.0" }]
	);
	assert.equal(merged.length, 2);
	const a = merged.find((p) => p.id === "a");
	assert.equal(a.version, "1.5");
});

test("compareVersions handles numeric segments", () => {
	assert.ok(compareVersions("1.2.3", "1.2.2") > 0);
	assert.ok(compareVersions("1.0", "1.0.0") === 0);
	assert.ok(compareVersions("2.0", "10.0") < 0);
});