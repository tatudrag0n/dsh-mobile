/**
 * A minimal Chrome DevTools Protocol driver.
 *
 * The DSH Web UI is a single-page app whose composer is built with Lexical,
 * so the only trustworthy way to learn its DOM is to look at the real page.
 * This driver opens a page in a phone-sized viewport, evaluates JavaScript in
 * it, and takes screenshots.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** Wait for a condition, polling. */
async function until(predicate, timeoutMs = 20_000, stepMs = 150) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	throw new Error("timeout while waiting for the page");
}

/** One page inside the browser. */
class Page {
	constructor(socket, sessionId, allocateId) {
		this.socket = socket;
		this.sessionId = sessionId;
		this.allocateId = allocateId;
		this.pending = new Map();
		this.events = new Map();
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined) {
				const entry = this.pending.get(message.id);
				if (entry === undefined) return;
				this.pending.delete(message.id);
				if (message.error) entry.reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? {})})`));
				else entry.resolve(message.result);
				return;
			}
			const listeners = this.events.get(message.method) ?? [];
			for (const listener of listeners) listener(message.params);
		});
	}

	/** Send one CDP command. */
	send(method, params = {}) {
		const id = this.allocateId();
		const payload = JSON.stringify({ id, method, params, sessionId: this.sessionId });
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(payload);
		});
	}

	/** Listen to a page event for as long as the page lives. */
	on(method, listener) {
		const listeners = this.events.get(method) ?? [];
		listeners.push(listener);
		this.events.set(method, listeners);
	}

	/** Wait for one page event. */
	once(method, timeoutMs = 20_000) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.events.delete(method);
				reject(new Error(`timeout waiting for ${method}`));
			}, timeoutMs);
			const listener = (params) => {
				clearTimeout(timer);
				const listeners = this.events.get(method) ?? [];
				this.events.set(method, listeners.filter((entry) => entry !== listener));
				resolve(params);
			};
			this.events.set(method, [...(this.events.get(method) ?? []), listener]);
		});
	}

	/** Navigate and wait for the load event. */
	async goto(url) {
		const loaded = this.once("Page.loadEventFired", 30_000);
		await this.send("Page.navigate", { url });
		await loaded;
	}

	/** Evaluate an expression in the page and return its JSON value. */
	async evaluate(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression: `(async () => { ${expression} })()`,
			returnByValue: true,
			awaitPromise: true,
		});
		if (result.exceptionDetails) {
			const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
			throw new Error(`page evaluation failed: ${text}`);
		}
		return result.result.value;
	}

	/** Take a screenshot and write it to a file. */
	async screenshot(path) {
		const shot = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
		await writeFile(path, Buffer.from(shot.data, "base64"));
		return path;
	}

	/** Click an element the way a finger would. */
	async click(selector) {
		const box = await this.evaluate(`
			const element = document.querySelector(${JSON.stringify(selector)});
			if (element === null) return null;
			const rect = element.getBoundingClientRect();
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		`);
		if (box === null) throw new Error(`click: no element matches ${selector}`);
		for (const type of ["mousePressed", "mouseReleased"]) {
			await this.send("Input.dispatchMouseEvent", {
				type,
				x: box.x,
				y: box.y,
				button: "left",
				clickCount: 1,
			});
		}
		return box;
	}
}

/** A headless Chrome with one phone-sized page. */
export class Browser {
	constructor(process, socket, profileDir) {
		this.process = process;
		this.socket = socket;
		this.profileDir = profileDir;
	}

	/** Open a new phone-sized page. */
	async newPage({ width = 390, height = 844, scale = 3, mobile = true } = {}) {
		const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
		const page = new Page(this.socket, sessionId, () => this.nextId++);
		await page.send("Page.enable");
		await page.send("Runtime.enable");
		await page.send("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: scale,
			mobile,
			screenWidth: width,
			screenHeight: height,
		});
		await page.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 });
		await page.send("Emulation.setUserAgentOverride", { userAgent: IPHONE_UA });
		// Without this the headless page never reports itself as focused, and
		// synthetic text input is dropped.
		await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
		return page;
	}

	/** Send a browser-level CDP command. */
	send(method, params = {}) {
		this.nextId ??= 1;
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const listener = (event) => {
				const message = JSON.parse(event.data);
				if (message.id !== id) return;
				this.socket.removeEventListener("message", listener);
				if (message.error) reject(new Error(message.error.message));
				else resolve(message.result);
			};
			this.socket.addEventListener("message", listener);
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Close the browser and remove its profile. */
	async close() {
		try {
			this.process.kill();
		} catch {}
		try {
			await rm(this.profileDir, { recursive: true, force: true });
		} catch {}
	}
}

/**
 * Launch headless Chrome and connect to it.
 * @param options - the port to use.
 * @returns the browser handle.
 */
export async function launch(options = {}) {
	const port = options.port ?? 9333;
	const profileDir = await mkdtemp(join(tmpdir(), "dsh-mobile-cdp-"));
	const child = spawn(CHROME, [
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
		"--hide-scrollbars",
		`--remote-debugging-port=${String(port)}`,
		`--user-data-dir=${profileDir}`,
		"about:blank",
	], { stdio: "ignore" });
	const deadline = Date.now() + 20_000;
	let target;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
			if (response.ok) {
				target = await response.json();
				break;
			}
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	if (target === undefined) {
		child.kill();
		throw new Error("chrome did not expose a debugging endpoint");
	}
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	return new Browser(child, socket, profileDir);
}

/** Sleep helper. */
export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export { until };
