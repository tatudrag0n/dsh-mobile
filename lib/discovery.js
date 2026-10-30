import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/**
 * We use a tiny UDP broadcast instead of mDNS so the plugin stays free of
 * native dependencies (mDNS bindings are platform-specific and would break the
 * "zero dependency" APK story). Each host periodically broadcasts a small
 * JSON announcement on a fixed port; every host listens on the same port and
 * collects the announcements it hears.
 *
 * The wire format and the validation rules live here as pure functions so
 * they can be unit tested without opening a socket.
 */

/** The UDP port every host listens on and broadcasts to. */
export const DISCOVERY_PORT = 41234;
/** The broadcast address used on IPv4 LANs. */
export const BROADCAST_ADDRESS = "255.255.255.255";

/**
 * Build the announcement payload a host sends.
 * @param {object} info - host facts.
 * @returns {string} the JSON text to broadcast.
 */
export function buildAnnouncement(info) {
	const payload = {
		type: "dsh-host",
		version: 1,
		deviceId: typeof info?.deviceId === "string" ? info.deviceId : "",
		name: typeof info?.name === "string" ? info.name : "",
		port: Number.isSafeInteger(info?.port) ? info.port : 0,
		protocol: info?.protocol === "https" ? "https" : "http",
	};
	return JSON.stringify(payload);
}

/**
 * Parse and validate an announcement received over UDP.
 * @param {string|Buffer} raw - the raw datagram.
 * @returns {object|null} the validated announcement, or null if invalid.
 */
export function parseAnnouncement(raw) {
	let text = raw;
	if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
	if (typeof text !== "string") return null;
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	if (parsed.type !== "dsh-host") return null;
	if (typeof parsed.deviceId !== "string" || parsed.deviceId.trim() === "") return null;
	const port = parsed.port;
	if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return null;
	return {
		type: "dsh-host",
		version: Number.isSafeInteger(parsed.version) ? parsed.version : 1,
		deviceId: parsed.deviceId.trim(),
		name: typeof parsed.name === "string" ? parsed.name : "",
		port,
		protocol: parsed.protocol === "https" ? "https" : "http",
	};
}

/**
 * Turn an announcement + sender address into a reachable origin URL.
 * @param {object} announcement - a validated announcement.
 * @param {string} senderAddress - the IP the datagram came from.
 * @returns {string} the origin URL.
 */
export function announcementOrigin(announcement, senderAddress) {
	const host = typeof senderAddress === "string" && senderAddress !== "" ? senderAddress : "127.0.0.1";
	const scheme = announcement.protocol === "https" ? "https" : "http";
	return `${scheme}://${host}:${announcement.port}`;
}

/**
 * De-duplicate a list of discovered peers by deviceId, keeping the most recent.
 * @param {Array<{ deviceId: string, seenAt: number }>} peers - the peer list.
 * @returns {Array<{ deviceId: string, seenAt: number }>} de-duplicated peers.
 */
export function dedupePeers(peers) {
	if (!Array.isArray(peers)) return [];
	const byId = new Map();
	for (const peer of peers) {
		if (peer === null || typeof peer !== "object") continue;
		if (typeof peer.deviceId !== "string" || peer.deviceId === "") continue;
		const existing = byId.get(peer.deviceId);
		if (existing === undefined || (typeof peer.seenAt === "number" && peer.seenAt > existing.seenAt)) {
			byId.set(peer.deviceId, peer);
		}
	}
	return [...byId.values()];
}

/**
 * Create a live discovery node that broadcasts announcements and collects peers.
 *
 * This is the only part of this module that touches the network. It is kept
 * separate from the pure helpers above so those stay trivially testable. The
 * node is intentionally dumb: it broadcasts on an interval and emits parsed
 * peers via the callbacks. Callers own the peer list and the TTL pruning.
 *
 * @param {object} options - configuration.
 * @param {string} options.deviceId - this host's device id.
 * @param {number} options.port - this host's HTTP port.
 * @param {string} [options.name] - a human label.
 * @param {function(object):void} [options.onPeer] - called with each peer seen.
 * @param {number} [options.intervalMs] - broadcast interval.
 * @returns {{ stop: function():void }} a handle.
 */
export function startDiscovery(options) {
	const dgram = requireDgram();
	if (dgram === null) return { stop() {} };
	const deviceId = typeof options?.deviceId === "string" ? options.deviceId : "";
	const port = Number.isSafeInteger(options?.port) ? options.port : 0;
	const name = typeof options?.name === "string" ? options.name : "";
	const onPeer = typeof options?.onPeer === "function" ? options.onPeer : () => {};
	const intervalMs = Number.isFinite(options?.intervalMs) ? options.intervalMs : 5000;

	const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
	let broadcastTimer = null;
	let stopped = false;

	socket.on("message", (msg, rinfo) => {
		const announcement = parseAnnouncement(msg);
		if (announcement === null) return;
		if (announcement.deviceId === deviceId) return; // ignore self
		onPeer({
			...announcement,
			address: rinfo.address,
			origin: announcementOrigin(announcement, rinfo.address),
			seenAt: Date.now(),
		});
	});

	socket.on("error", () => { /* best-effort; discovery is optional */ });

	try {
		socket.bind(DISCOVERY_PORT, () => {
			try { socket.setBroadcast(true); } catch { /* ignore */ }
		});
	} catch {
		return { stop() {} };
	}

	const announce = () => {
		if (stopped) return;
		const text = buildAnnouncement({ deviceId, name, port, protocol: "http" });
		const buf = Buffer.from(text, "utf8");
		try {
			socket.send(buf, 0, buf.length, DISCOVERY_PORT, BROADCAST_ADDRESS);
		} catch { /* ignore */ }
	};
	announce();
	broadcastTimer = setInterval(announce, intervalMs);

	return {
		stop() {
			stopped = true;
			if (broadcastTimer !== null) clearInterval(broadcastTimer);
			try { socket.close(); } catch { /* ignore */ }
		},
	};
}

function requireDgram() {
	try {
		return require("node:dgram");
	} catch {
		return null;
	}
}
/**
 * Prune peers that have not been seen within `ttlMs`.
 * @param {Array<{ seenAt: number }>} peers - the peer list.
 * @param {number} now - current timestamp in ms.
 * @param {number} ttlMs - time-to-live in ms.
 * @returns {Array<{ seenAt: number }>} the surviving peers.
 */
export function pruneStalePeers(peers, now, ttlMs) {
	if (!Array.isArray(peers)) return [];
	const cutoff = now - (Number.isFinite(ttlMs) ? ttlMs : 0);
	return peers.filter((peer) => typeof peer?.seenAt === "number" && peer.seenAt >= cutoff);
}
