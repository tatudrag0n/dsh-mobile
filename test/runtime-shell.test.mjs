import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// The standalone UI is the desktop UI unless the mobile shell reaches the
// browser. These tests guard the wiring that makes that happen: the profile row
// that makes the Harness serve the bundle, the package metadata the Harness
// reads, and the copy step in the runtime build.

const repo = join(import.meta.dirname, "..");
const shell = join(repo, "runtime", "plugins", "mobile-shell");
const read = (relative) => readFileSync(join(repo, relative), "utf8");

test("the shell package declares the client half the Harness looks for", () => {
	const manifest = JSON.parse(readFileSync(join(shell, "package.json"), "utf8"));
	assert.equal(manifest.exports["./client"], "./client.js");
	assert.equal(manifest.dsh.client.platform, "web");
	assert.equal(manifest.dsh.client.immediately, true);
	assert.ok(Array.isArray(manifest.dsh.client.inject));
	assert.ok(manifest.dsh.client.inject.length > 0);
});

test("the standalone profile mounts the shell with a row", () => {
	const patch = read(join("runtime", "profile", "cordis.patch.yml"));
	assert.match(patch, /id: mobile-shell/);
	assert.match(patch, /name: '\{\{pluginsDir\}\}\/mobile-shell\/index\.js'/);
});

test("the host half of the shell loads and starts nothing", async () => {
	const host = await import(new URL("../runtime/plugins/mobile-shell/index.js", import.meta.url));
	assert.equal(typeof host.apply, "function");
	const resolved = host.apply({});
	assert.equal(resolved, undefined);
});

test("the runtime build copies the one client bundle into the shell package", () => {
	const build = read(join("scripts", "build-runtime.mjs"));
	assert.match(build, /cpSync\(path\.join\(repo, 'client\.js'\), path\.join\(bundle, 'plugins', 'mobile-shell', 'client\.js'\)\)/);
});

test("the shell package name matches the id client.js registers", () => {
	const manifest = JSON.parse(readFileSync(join(shell, "package.json"), "utf8"));
	// The Harness matches the factory a bundle registers via __ModuleLoader__.load
	// against the package name it expects. A mismatch fails the boot with
	// "loaded without registering …", so the two must stay identical.
	const registered = read("client.js").match(/id:\s*"([^"]+)"/);
	assert.ok(registered, "client.js must register an id");
	assert.equal(manifest.name, registered[1]);
});

test("the standalone profile points the workspace controller at the app's directory", () => {
	const patch = read(join("runtime", "profile", "cordis.patch.yml"));
	// Without this the workspace controller looks for a desktop "Documents"
	// directory, fails on Android, and the composer never leaves
	// "Choose a workspace to start".
	assert.match(patch, /- id: workspace-controller/);
	assert.match(patch, /documentsDirectory: '\{\{workspace\}\}'/);
});

test("the app substitutes every placeholder the profile uses", () => {
	const source = read(join("android", "app", "src", "main", "java", "dev", "tatudrag0n", "dshmobile", "RuntimeStore.java"));
	const patch = read(join("runtime", "profile", "cordis.patch.yml"));
	const used = new Set([...patch.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]));
	assert.ok(used.size > 0);
	for (const name of used) {
		assert.match(source, new RegExp(`\\{\\{${name}\\}\\}`), `RuntimeStore must substitute {{${name}}}`);
	}
});

test("client.js is a self-contained browser bundle", () => {
	const source = read("client.js");
	// The browser build has no module graph: the Harness loads the file as-is and
	// hands it `window.__ModuleLoader__`. A stray import would 404 on the device.
	assert.doesNotMatch(source, /^\s*import\s/m);
	assert.match(source, /__ModuleLoader__/);
	assert.ok(existsSync(join(repo, "client.js")));
});
