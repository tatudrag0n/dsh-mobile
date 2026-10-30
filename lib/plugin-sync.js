/**
 * Plugin synchronization helpers for same-Wi-Fi sync.
 *
 * Plugins are identified by id. A device advertises the list of plugin ids it
 * has installed together with a version string per plugin. Sync produces a
 * manifest of what each side should install/remove so both end up with the same
 * set, without transferring binaries (each device installs from its own source).
 */

/**
 * Normalize a plugin descriptor into the canonical shape.
 * @param {unknown} raw - the incoming descriptor.
 * @returns {{ id: string, version: string } | null}
 */
export function normalizePlugin(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (id === "") return null;
	const version = typeof raw.version === "string" ? raw.version : "";
	return { id, version };
}

/**
 * Normalize a list of plugin descriptors.
 * @param {unknown} raw - the incoming list.
 * @returns {Array<{ id: string, version: string }>}
 */
export function normalizePluginList(raw) {
	if (!Array.isArray(raw)) return [];
	const result = [];
	for (const entry of raw) {
		const normalized = normalizePlugin(entry);
		if (normalized !== null) result.push(normalized);
	}
	return result;
}

/**
 * Build a map from plugin id to version for quick lookup.
 * @param {Array<{ id: string, version: string }>} plugins - the plugin list.
 * @returns {Map<string, string>} the version map.
 */
export function pluginVersionMap(plugins) {
	const map = new Map();
	for (const plugin of Array.isArray(plugins) ? plugins : []) {
		const normalized = normalizePlugin(plugin);
		if (normalized !== null) map.set(normalized.id, normalized.version);
	}
	return map;
}

/**
 * Diff two plugin sets and produce a sync manifest.
 *
 * @param {Array<{ id: string, version?: string }>} local - our plugins.
 * @param {Array<{ id: string, version?: string }>} remote - the peer's plugins.
 * @returns {{
 *   toInstall: string[],
 *   toRemove: string[],
 *   toUpdate: Array<{ id: string, from: string, to: string }>,
 *   inSync: string[]
 * }} the manifest.
 */
export function pluginSyncManifest(local, remote) {
	const localMap = pluginVersionMap(local);
	const remoteMap = pluginVersionMap(remote);
	const toInstall = [];
	const toRemove = [];
	const toUpdate = [];
	const inSync = [];
	for (const [id, remoteVersion] of remoteMap) {
		if (!localMap.has(id)) {
			toInstall.push(id);
		} else if (localMap.get(id) !== remoteVersion) {
			toUpdate.push({ id, from: localMap.get(id), to: remoteVersion });
		} else {
			inSync.push(id);
		}
	}
	for (const id of localMap.keys()) {
		if (!remoteMap.has(id)) toRemove.push(id);
	}
	return { toInstall, toRemove, toUpdate, inSync };
}

/**
 * Merge two plugin sets, preferring the higher version when both have an id.
 * Versions are compared as strings (semver-lite: numeric segments).
 *
 * @param {Array<{ id: string, version?: string }>} local - our plugins.
 * @param {Array<{ id: string, version?: string }>} remote - the peer's plugins.
 * @returns {Array<{ id: string, version: string }>} the merged set.
 */
export function mergePluginSets(local, remote) {
	const localMap = pluginVersionMap(local);
	const remoteMap = pluginVersionMap(remote);
	const merged = new Map(localMap);
	for (const [id, version] of remoteMap) {
		if (!merged.has(id) || compareVersions(version, merged.get(id)) > 0) {
			merged.set(id, version);
		}
	}
	return [...merged.entries()].map(([id, version]) => ({ id, version }));
}

/**
 * Compare two version strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 * Falls back to lexical comparison when segments are not numeric.
 * @param {string} a - first version.
 * @param {string} b - second version.
 * @returns {number} the comparison result.
 */
export function compareVersions(a, b) {
	const sa = String(a ?? "").split(".");
	const sb = String(b ?? "").split(".");
	const len = Math.max(sa.length, sb.length);
	for (let i = 0; i < len; i += 1) {
		const pa = sa[i] ?? "0";
		const pb = sb[i] ?? "0";
		const na = Number(pa);
		const nb = Number(pb);
		if (Number.isFinite(na) && Number.isFinite(nb)) {
			if (na !== nb) return na - nb;
		} else {
			if (pa !== pb) return pa < pb ? -1 : 1;
		}
	}
	return 0;
}