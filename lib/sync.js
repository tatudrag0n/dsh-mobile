/**
 * Pure helpers for the same-Wi-Fi sync protocol.
 *
 * These live apart from the network code so they can be unit tested without
 * booting a host or opening a socket. The wire format and the merge rules are
 * the parts where a mistake would silently lose data, so they are kept here.
 */

/** A device id is an opaque string; we only require it to be non-empty. */
export function isValidDeviceId(value) {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * Normalize a raw sync cursor into the canonical shape.
 * @param {unknown} raw - the incoming cursor.
 * @returns {{ deviceId: string, sessionId: string, lastEventId: string } | null}
 */
export function normalizeCursor(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const deviceId = typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
	const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
	const lastEventId = typeof raw.lastEventId === "string" ? raw.lastEventId : "";
	if (deviceId === "") return null;
	return { deviceId, sessionId, lastEventId };
}

/**
 * Decide which events a peer still needs, given our cursor for them.
 *
 * Events are identified by their id. We return the events whose id is not
 * already acknowledged by the peer's cursor. The caller is responsible for
 * ordering the result before sending.
 *
 * @param {Array<{ id: string }>} events - our events for the session, oldest first.
 * @param {string} peerLastEventId - the last event id the peer acknowledged.
 * @returns {Array<{ id: string }>} the events the peer is missing.
 */
export function missingEvents(events, peerLastEventId) {
	if (!Array.isArray(events)) return [];
	if (peerLastEventId === "") return [...events];
	const index = events.findIndex((event) => event?.id === peerLastEventId);
	if (index === -1) {
		// We cannot anchor the peer's cursor; send everything to be safe.
		return [...events];
	}
	return events.slice(index + 1);
}

/**
 * Merge two event streams for the same session into one ordered stream.
 *
 * The merge is append-only: every event from both sides is kept. Events are
 * ordered by their timestamp when present, falling back to insertion order.
 * Duplicate ids are collapsed (first occurrence wins) so a re-sync does not
 * duplicate data.
 *
 * @param {Array<{ id: string, ts?: number }>} local - our events.
 * @param {Array<{ id: string, ts?: number }>} remote - the peer's events.
 * @returns {Array<{ id: string, ts?: number }>} the merged stream.
 */
export function mergeEvents(local, remote) {
	const seen = new Set();
	const result = [];
	const push = (event) => {
		if (event === null || typeof event !== "object") return;
		const id = typeof event.id === "string" ? event.id : "";
		if (id === "" || seen.has(id)) return;
		seen.add(id);
		result.push(event);
	};
	for (const event of Array.isArray(local) ? local : []) push(event);
	for (const event of Array.isArray(remote) ? remote : []) push(event);
	result.sort((left, right) => {
		const lt = typeof left.ts === "number" ? left.ts : 0;
		const rt = typeof right.ts === "number" ? right.ts : 0;
		if (lt !== rt) return lt - rt;
		return String(left.id).localeCompare(String(right.id));
	});
	return result;
}

/**
 * Build the list of plugin ids that differ between two devices.
 *
 * @param {string[]} local - plugin ids installed locally.
 * @param {string[]} remote - plugin ids installed on the peer.
 * @returns {{ toInstall: string[], toRemove: string[] }} the diff.
 */
export function pluginDiff(local, remote) {
	const localSet = new Set(Array.isArray(local) ? local : []);
	const remoteSet = new Set(Array.isArray(remote) ? remote : []);
	const toInstall = [...remoteSet].filter((id) => !localSet.has(id));
	const toRemove = [...localSet].filter((id) => !remoteSet.has(id));
	return { toInstall, toRemove };
}

/**
 * Validate a sync message received over the wire.
 * @param {unknown} raw - the parsed message.
 * @returns {object|null} the validated message, or null.
 */
export function validateSyncMessage(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const type = raw.type;
	if (type !== "events" && type !== "peers" && type !== "plugins") return null;
	if (typeof raw.from !== "string" || raw.from.trim() === "") return null;
	return {
		type,
		from: raw.from.trim(),
		sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
		events: Array.isArray(raw.events) ? raw.events : [],
		plugins: Array.isArray(raw.plugins) ? raw.plugins : [],
		peers: Array.isArray(raw.peers) ? raw.peers : [],
	};
}

/**
 * Merge a list of remote peers into our peer list, de-duplicating by deviceId
 * and keeping the most recently seen entry.
 * @param {Array<{ deviceId: string, seenAt: number }>} local - our peers.
 * @param {Array<{ deviceId: string, seenAt: number }>} remote - incoming peers.
 * @returns {Array<{ deviceId: string, seenAt: number }>} merged peers.
 */
export function mergePeers(local, remote) {
	const byId = new Map();
	const consider = (peer) => {
		if (peer === null || typeof peer !== "object") return;
		if (typeof peer.deviceId !== "string" || peer.deviceId === "") return;
		const existing = byId.get(peer.deviceId);
		const seenAt = typeof peer.seenAt === "number" ? peer.seenAt : 0;
		if (existing === undefined || seenAt > existing.seenAt) {
			byId.set(peer.deviceId, { ...peer, seenAt });
		}
	};
	for (const peer of Array.isArray(local) ? local : []) consider(peer);
	for (const peer of Array.isArray(remote) ? remote : []) consider(peer);
	return [...byId.values()];
}
/**
 * Sync runs only when we are on a known network, the device is paired, and
 * we are not already syncing. Manual triggers bypass the "foreground" gate.
 *
 * @param {object} state - the current sync state.
 * @returns {boolean} true when a sync should start.
 */
export function shouldSync(state) {
	if (state === null || typeof state !== "object") return false;
	if (state.syncing === true) return false;
	if (state.paired !== true) return false;
	if (state.onWifi !== true) return false;
	if (state.manual === true) return true;
	return state.foreground === true;
}
