/**
 * @local/dsh-mobile — browser half of the phone surface.
 *
 * The Web UI is the same app the PC uses; this half only makes it behave
 * like an app on a phone and makes the link to the PC visible:
 *
 *   - a phone layout: the session panel floats over the transcript, touch
 *     targets grow, iOS stops zooming when the composer gains focus, and the
 *     safe areas (notch, home indicator) stay clear;
 *   - a sync chip that shows the live state of the link to the PC Host and
 *     re-establishes it on tap;
 *   - an outbox: a message written while the PC is unreachable is kept and
 *     sent as soon as the link comes back, without the user retyping it;
 *   - installability: a service worker for the offline shell and the iOS
 *     home-screen metadata.
 *
 * The selectors below were taken from the running application, not guessed:
 * the shell exposes stable data attributes (`data-composer-input`,
 * `data-composer-card`, `data-composer-seat`, `data-conversation-region`)
 * while the rest of the class names are content hashes, so they are matched
 * by their local part only (`[class*="primary"]`).
 */
window.__ModuleLoader__.load({
	id: "@local/dsh-mobile",
	factory() {
		/** The viewports that count as a phone. */
		const PHONE_MEDIA = "(max-width: 1023px) and (pointer: coarse), (max-width: 600px)";
		/** Where the queued drafts live between reloads. */
		const OUTBOX_KEY = "dsh.mobile.outbox";
		/** The composer's editable surface. */
		const COMPOSER_INPUT = '[data-composer-input="true"]';
		/** The composer's send button. */
		const COMPOSER_SEND = '[data-conversation-region="composer"] [class*="primary"]';

		/**
		 * Whether the window is a phone-sized viewport.
		 * @returns the answer.
		 */
		function isPhone() {
			return window.matchMedia(PHONE_MEDIA).matches;
		}

		/**
		 * The stylesheet that adapts the shell to a phone.
		 * @returns the CSS text.
		 */
		function stylesheet() {
			return `
:root {
	--dsh-mobile-keyboard: 0px;
	--dsh-mobile-safe-top: env(safe-area-inset-top, 0px);
	--dsh-mobile-safe-bottom: env(safe-area-inset-bottom, 0px);
	--dsh-mobile-safe-left: env(safe-area-inset-left, 0px);
	--dsh-mobile-safe-right: env(safe-area-inset-right, 0px);
}

html { -webkit-text-size-adjust: 100%; }
body {
	overscroll-behavior-y: none;
	-webkit-tap-highlight-color: transparent;
	touch-action: manipulation;
}

/* The sync chip floats above the shell. */
.dsh-mobile-chip {
	position: fixed;
	top: calc(var(--dsh-mobile-safe-top) + 8px);
	right: calc(var(--dsh-mobile-safe-right) + 10px);
	z-index: 60;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	max-width: 60vw;
	padding: 5px 10px;
	border-radius: 999px;
	border: 1px solid var(--dsw-alias-border-l1, rgb(255 255 255 / 14%));
	background: var(--dsw-alias-bg-overlay, rgb(18 20 26 / 88%));
	color: var(--dsw-alias-label-primary, #e5e7eb);
	font: 500 12px/1.2 system-ui, -apple-system, "Hiragino Sans", sans-serif;
	box-shadow: 0 6px 18px rgb(0 0 0 / 28%);
	-webkit-backdrop-filter: blur(8px);
	backdrop-filter: blur(8px);
	cursor: pointer;
	user-select: none;
	-webkit-user-select: none;
}
.dsh-mobile-chip-dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	flex: none;
	background: #22c55e;
}
.dsh-mobile-chip[data-state="connecting"] .dsh-mobile-chip-dot { background: #f59e0b; }
.dsh-mobile-chip[data-state="disconnected"] .dsh-mobile-chip-dot { background: #ef4444; }
.dsh-mobile-chip[data-pending="true"] .dsh-mobile-chip-dot { background: #f59e0b; }
.dsh-mobile-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* The pending-drafts sheet. */
.dsh-mobile-panel {
	position: fixed;
	left: 12px;
	right: 12px;
	bottom: calc(var(--dsh-mobile-safe-bottom) + 12px);
	z-index: 61;
	box-sizing: border-box;
	max-height: 60vh;
	overflow-y: auto;
	padding: 14px;
	border-radius: 14px;
	border: 1px solid var(--dsw-alias-border-l1, rgb(255 255 255 / 14%));
	background: var(--dsw-alias-bg-overlay, rgb(18 20 26 / 96%));
	color: var(--dsw-alias-label-primary, #e5e7eb);
	font: 13px/1.6 system-ui, -apple-system, "Hiragino Sans", sans-serif;
	box-shadow: 0 16px 40px rgb(0 0 0 / 40%);
}
.dsh-mobile-panel[hidden] { display: none; }
.dsh-mobile-panel-title { font-weight: 600; margin-bottom: 8px; }
.dsh-mobile-panel-item {
	padding: 8px 10px;
	margin-bottom: 8px;
	border-radius: 10px;
	background: var(--dsw-alias-bg-layer-2, rgb(255 255 255 / 6%));
	white-space: pre-wrap;
	word-break: break-word;
}
.dsh-mobile-panel-actions { display: flex; gap: 8px; }
.dsh-mobile-panel button {
	font: inherit;
	font-weight: 600;
	padding: 9px 14px;
	border-radius: 9px;
	border: 0;
	background: var(--dsw-alias-state-business-primary, #7c8cf8);
	color: #10131a;
}
.dsh-mobile-panel button.ghost { background: var(--dsw-alias-bg-layer-3, rgb(255 255 255 / 10%)); color: inherit; }

/* The install hint. */
.dsh-mobile-install {
	position: fixed;
	left: 12px;
	right: 12px;
	bottom: calc(var(--dsh-mobile-safe-bottom) + 12px);
	z-index: 59;
	box-sizing: border-box;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 12px;
	border-radius: 12px;
	border: 1px solid var(--dsw-alias-border-l1, rgb(255 255 255 / 14%));
	background: var(--dsw-alias-bg-overlay, rgb(18 20 26 / 94%));
	color: var(--dsw-alias-label-primary, #e5e7eb);
	font: 13px/1.5 system-ui, -apple-system, "Hiragino Sans", sans-serif;
	box-shadow: 0 12px 30px rgb(0 0 0 / 35%);
}
.dsh-mobile-install[hidden] { display: none; }
.dsh-mobile-install span { flex: 1; }
.dsh-mobile-install button {
	font: inherit;
	font-weight: 600;
	padding: 7px 12px;
	border-radius: 8px;
	border: 0;
	background: var(--dsw-alias-state-business-primary, #7c8cf8);
	color: #10131a;
}
.dsh-mobile-install button.ghost { background: transparent; color: inherit; padding: 7px; }

@media ${PHONE_MEDIA} {
	/* The 56px rail stays: it holds the button that opens the panel. The
	   panel itself floats over the transcript instead of squeezing it. */
	[class*="frame"] {
		grid-template-columns: 56px minmax(0, 1fr) 0px !important;
		box-sizing: border-box;
		padding-top: var(--dsh-mobile-safe-top);
	}
	[class*="centerCol"] { grid-column: 2 !important; }
	[class*="rightbarCol"] { grid-column: 3 !important; }
	[class*="frame"]:not([data-sidebar-collapsed]) > [class*="sidebarCol"] {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		z-index: 40;
		width: min(268px, 78vw) !important;
		box-shadow: 0 0 32px rgb(0 0 0 / 35%);
	}
	[class*="frame"]:not([data-sidebar-collapsed]) > [class*="sidebarCol"] > * { width: 100% !important; }
	[class*="frame"]:not([data-sidebar-collapsed]) [data-shell-overlay]::before {
		content: "";
		position: absolute;
		inset: 0;
		background: rgb(0 0 0 / 45%);
		pointer-events: auto;
	}
	[class*="frame"]:not([data-rightbar-collapsed]) > [class*="rightbarCol"] {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 40;
		width: min(320px, 86vw) !important;
		box-shadow: 0 0 32px rgb(0 0 0 / 35%);
	}
	/* iOS zooms any field below 16px when it gains focus. */
	input, textarea, select { font-size: 16px !important; }
	[data-composer-input="true"] { font-size: 16px !important; line-height: 1.5 !important; }
	/* Finger-sized controls, and room for the home indicator and keyboard. */
	[data-composer-seat] {
		padding-bottom: calc(var(--dsh-mobile-safe-bottom) + var(--dsh-mobile-keyboard)) !important;
	}
	[data-conversation-region="composer"] button { min-height: 40px; min-width: 40px; }
	[data-conversation-region="composer"] [class*="primary"] { width: 44px !important; height: 44px !important; }
	/* Column resize handles are pointer-only chrome. */
	[class*="handle"], [data-width-handle] { display: none !important; }
	.dsh-mobile-chip { top: calc(var(--dsh-mobile-safe-top) + 48px); }
}
`;
		}

		/**
		 * Install the stylesheet.
		 * @returns a disposer.
		 */
		function installStyles() {
			const style = document.createElement("style");
			style.id = "dsh-mobile-styles";
			style.textContent = stylesheet();
			document.head.append(style);
			return () => style.remove();
		}

		/**
		 * Replace the shipped viewport meta with one that covers the notch.
		 *
		 * The application already ships a viewport meta, so a second one would
		 * be ignored by the browser: the existing tag is rewritten instead.
		 * @returns a disposer.
		 */
		function installViewport() {
			let meta = document.querySelector('meta[name="viewport"]');
			const original = meta?.getAttribute("content") ?? null;
			if (meta === null) {
				meta = document.createElement("meta");
				meta.setAttribute("name", "viewport");
				document.head.append(meta);
			}
			meta.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover");
			return () => {
				if (original !== null) meta?.setAttribute("content", original);
				else meta?.remove();
			};
		}

		/**
		 * Add the metadata an installed home-screen app needs.
		 * @returns a disposer.
		 */
		function installAppMetadata() {
			const added = [];
			const ensure = (name, content) => {
				if (document.querySelector(`meta[name="${name}"]`) !== null) return;
				const meta = document.createElement("meta");
				meta.setAttribute("name", name);
				meta.setAttribute("content", content);
				document.head.append(meta);
				added.push(meta);
			};
			ensure("apple-mobile-web-app-capable", "yes");
			ensure("mobile-web-app-capable", "yes");
			ensure("apple-mobile-web-app-status-bar-style", "black-translucent");
			ensure("apple-mobile-web-app-title", "DSH");
			if (document.querySelector('link[rel="manifest"]') === null) {
				const link = document.createElement("link");
				link.setAttribute("rel", "manifest");
				link.setAttribute("href", "/mobile/manifest.webmanifest");
				document.head.append(link);
				added.push(link);
			}
			if (document.querySelector('link[rel="apple-touch-icon"]') === null) {
				const link = document.createElement("link");
				link.setAttribute("rel", "apple-touch-icon");
				link.setAttribute("href", "/mobile/icon-180.png");
				document.head.append(link);
				added.push(link);
			}
			return () => {
				for (const element of added) element.remove();
			};
		}

		/**
		 * Register the service worker that keeps the shell available offline.
		 *
		 * A service worker needs a secure context, so on a plain-HTTP LAN
		 * address the registration simply fails and the app keeps working.
		 * @returns a disposer.
		 */
		function installServiceWorker() {
			if (!("serviceWorker" in navigator)) return () => {};
			const registration = navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
				console.warn("[dsh-mobile] service worker registration failed:", error);
			});
			return () => {
				void registration;
			};
		}

		/**
		 * Track the on-screen keyboard so the composer can lift above it.
		 * @returns a disposer.
		 */
		function installKeyboardInset() {
			const viewport = window.visualViewport;
			if (viewport === null || viewport === undefined) return () => {};
			const update = () => {
				const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
				document.documentElement.style.setProperty("--dsh-mobile-keyboard", `${Math.round(inset)}px`);
			};
			viewport.addEventListener("resize", update);
			viewport.addEventListener("scroll", update);
			update();
			return () => {
				viewport.removeEventListener("resize", update);
				viewport.removeEventListener("scroll", update);
				document.documentElement.style.setProperty("--dsh-mobile-keyboard", "0px");
			};
		}

		/**
		 * Read the text the user has written in the composer.
		 * @returns the draft text.
		 */
		function readDraft() {
			const input = document.querySelector(COMPOSER_INPUT);
			if (input === null) return "";
			return (input.innerText ?? input.textContent ?? "").replace(/ /g, " ").trim();
		}

		/**
		 * The outbox: drafts written while the PC was unreachable.
		 *
		 * The composer owns the draft; the outbox only remembers that a
		 * send was attempted while the link was down, so the message can go
		 * out on its own once the link returns. The text itself stays in the
		 * composer, which is what the application restores after a failed
		 * send — so the user can still edit it before it leaves.
		 * @param services - the optional session services.
		 * @returns the outbox handle.
		 */
		function createOutbox(services) {
			const items = [];
			let timer;
			let lastEditAt = 0;
			/**
			 * How long the composer must stay quiet before an automatic send
			 * may interrupt it.
			 */
			const QUIET_MS = 1500;

			/**
			 * Persist the outbox.
			 */
			function save() {
				try {
					window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
				} catch {
					/* a private-mode browser simply keeps it in memory */
				}
			}

			/**
			 * Read the outbox back.
			 */
			function load() {
				try {
					const raw = window.localStorage.getItem(OUTBOX_KEY);
					const parsed = raw === null ? [] : JSON.parse(raw);
					if (Array.isArray(parsed)) items.push(...parsed.filter((entry) => typeof entry?.text === "string"));
				} catch {
					/* ignore a corrupt entry */
				}
			}

			/**
			 * Add a draft to the outbox.
			 * @param text - the draft text.
			 */
			function add(text) {
				if (text === "") return;
				items.push({ text, at: Date.now() });
				save();
			}

			/**
			 * Drop every queued draft.
			 */
			function clear() {
				items.length = 0;
				save();
			}

			/**
			 * Remember a send attempt made while the link was down.
			 *
			 * The application restores the draft after a failed send, so the
			 * text is read again a moment later: if it is still there, the
			 * message really is waiting.
			 */
			function rememberAttempt() {
				const before = readDraft();
				if (before === "") return;
				window.clearTimeout(timer);
				timer = window.setTimeout(() => {
					const after = readDraft();
					if (after === "") return;
					if (!items.some((entry) => entry.text === after)) add(after);
				}, 800);
			}

			/**
			 * Send what is waiting.
			 *
			 * The composer's own send button is used when the draft is still
			 * in the composer: the application then clears it on success and
			 * the user keeps the usual behaviour. When the composer is empty
			 * but the outbox is not, the message goes through the session
			 * service instead.
			 * @returns whether something was sent.
			 */
			function flush() {
				const draft = readDraft();
				if (draft !== "") {
					const send = document.querySelector(COMPOSER_SEND);
					if (send !== null && !send.disabled) {
						send.click();
						clear();
						return true;
					}
				}
				const first = items[0];
				if (first === undefined) return false;
				const session = currentSession();
				if (session === undefined) return false;
				session.conversation.send(first.text).then(() => {
					items.shift();
					save();
				}).catch((error) => {
					console.warn("[dsh-mobile] outbox flush failed:", error);
				});
				return true;
			}

			/**
			 * Whether the composer has been quiet long enough to send.
			 * @returns the answer.
			 */
			function isQuiet() {
				return Date.now() - lastEditAt > QUIET_MS;
			}

			/**
			 * The session the phone is looking at.
			 * @returns the scoped session context, or undefined.
			 */
			function currentSession() {
				const sessions = services.sessions;
				const uiSession = services.uiSession;
				if (sessions === undefined || uiSession === undefined) return undefined;
				const id = uiSession.current?.value?.key;
				if (id === undefined) return undefined;
				return sessions.scope(id);
			}

			load();
			return { items, add, clear, flush, rememberAttempt, readDraft, isQuiet, touch: () => { lastEditAt = Date.now(); } };
		}

		/**
		 * Watch for send attempts made while the link is down.
		 * @param outbox - the outbox handle.
		 * @param state - the current connection state.
		 * @returns a disposer.
		 */
		function installOutbox(outbox, state) {
			const onClick = (event) => {
				if (state() === "connected") return;
				const target = event.target;
				if (target === null || typeof target.closest !== "function") return;
				if (target.closest(COMPOSER_SEND) === null) return;
				outbox.rememberAttempt();
			};
			const onKeyDown = (event) => {
				if (state() === "connected") return;
				if (event.key !== "Enter" || event.shiftKey) return;
				const target = event.target;
				if (target === null || typeof target.closest !== "function") return;
				if (target.closest(COMPOSER_INPUT) === null) return;
				outbox.rememberAttempt();
			};
			const onInput = (event) => {
				const target = event.target;
				if (target === null || typeof target.closest !== "function") return;
				if (target.closest(COMPOSER_INPUT) === null) return;
				outbox.touch();
			};
			document.addEventListener("click", onClick, true);
			document.addEventListener("keydown", onKeyDown, true);
			document.addEventListener("input", onInput, true);
			return () => {
				document.removeEventListener("click", onClick, true);
				document.removeEventListener("keydown", onKeyDown, true);
				document.removeEventListener("input", onInput, true);
			};
		}

		/**
		 * Build the sync chip and the pending-drafts sheet.
		 * @param ctx - the client context.
		 * @param outbox - the outbox handle.
		 * @param state - the current connection state.
		 * @returns a disposer.
		 */
		function installStatus(ctx, outbox, state) {
			const chip = document.createElement("div");
			chip.className = "dsh-mobile-chip";
			chip.setAttribute("role", "status");
			chip.innerHTML = '<span class="dsh-mobile-chip-dot"></span><span class="dsh-mobile-chip-label"></span>';
			const label = chip.querySelector(".dsh-mobile-chip-label");
			let retry;

			const panel = document.createElement("div");
			panel.className = "dsh-mobile-panel";
			panel.hidden = true;

			/**
			 * The label for the current state.
			 * @returns the text.
			 */
			function describe() {
				const pending = outbox.items.length;
				const current = state();
				if (current === "disconnected") return pending > 0 ? `オフライン・未送信${pending}件` : "オフライン";
				if (current === "connecting") return "接続中…";
				return pending > 0 ? `未送信${pending}件` : "同期中";
			}

			/**
			 * Repaint the chip and the sheet.
			 */
			function render() {
				const current = state();
				chip.setAttribute("data-state", current);
				chip.setAttribute("data-pending", outbox.items.length > 0 ? "true" : "false");
				if (label !== null) label.textContent = describe();
				if (panel.hidden) return;
				const rows = outbox.items.map((item) => {
					const row = document.createElement("div");
					row.className = "dsh-mobile-panel-item";
					row.textContent = item.text;
					return row;
				});
				panel.replaceChildren();
				const title = document.createElement("div");
				title.className = "dsh-mobile-panel-title";
				title.textContent = "送信待ちのメッセージ";
				panel.append(title, ...rows);
				const actions = document.createElement("div");
				actions.className = "dsh-mobile-panel-actions";
				const send = document.createElement("button");
				send.type = "button";
				send.textContent = "今すぐ送信";
				send.addEventListener("click", () => {
					outbox.flush();
					render();
				});
				const discard = document.createElement("button");
				discard.type = "button";
				discard.className = "ghost";
				discard.textContent = "破棄";
				discard.addEventListener("click", () => {
					outbox.clear();
					render();
				});
				const close = document.createElement("button");
				close.type = "button";
				close.className = "ghost";
				close.textContent = "閉じる";
				close.addEventListener("click", () => {
					panel.hidden = true;
				});
				actions.append(send, discard, close);
				panel.append(actions);
			}

			chip.addEventListener("click", () => {
				const current = state();
				if (current === "disconnected") {
					ctx.connection.reconnect();
					return;
				}
				if (outbox.items.length > 0) {
					panel.hidden = !panel.hidden;
					render();
					return;
				}
				ctx.connection.reconnect();
			});

			document.body.append(chip, panel);
			render();

			const unsubscribe = ctx.connection.state.subscribe(() => {
				render();
				if (state() !== "connected") return;
				// The link is back: send what was waiting. The composer must
				// be quiet first, so a half-written message is never cut off.
				window.clearTimeout(retry);
				const attempt = () => {
					if (state() !== "connected") return;
					if (outbox.items.length === 0) return;
					if (!outbox.isQuiet()) {
						retry = window.setTimeout(attempt, 1000);
						return;
					}
					outbox.flush();
					render();
				};
				attempt();
			});

			return () => {
				unsubscribe();
				window.clearTimeout(retry);
				chip.remove();
				panel.remove();
			};
		}

		/**
		 * Offer to install the app on the phone's home screen.
		 * @returns a disposer.
		 */
		function installInstallHint() {
			const banner = document.createElement("div");
			banner.className = "dsh-mobile-install";
			banner.hidden = true;
			const text = document.createElement("span");
			const install = document.createElement("button");
			install.type = "button";
			install.textContent = "追加";
			const dismiss = document.createElement("button");
			dismiss.type = "button";
			dismiss.className = "ghost";
			dismiss.textContent = "閉じる";
			banner.append(text, install, dismiss);
			document.body.append(banner);

			const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
			let prompt = null;
			const onPrompt = (event) => {
				event.preventDefault();
				prompt = event;
				if (standalone) return;
				text.textContent = "この画面をホーム画面に追加すると、アプリのように使えます。";
				banner.hidden = false;
			};
			window.addEventListener("beforeinstallprompt", onPrompt);
			install.addEventListener("click", () => {
				if (prompt === null) return;
				prompt.prompt();
				void prompt.userChoice;
				prompt = null;
				banner.hidden = true;
			});
			dismiss.addEventListener("click", () => {
				banner.hidden = true;
			});
			// iOS has no install prompt; it is told what to do instead.
			if (!standalone && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
				text.textContent = "Safariの「共有」→「ホーム画面に追加」でアプリとして使えます。";
				banner.hidden = false;
			}
			return () => {
				window.removeEventListener("beforeinstallprompt", onPrompt);
				banner.remove();
			};
		}

		return {
			inject: ["connection"],
			/**
			 * Mount the phone half.
			 * @param ctx - the client context.
			 */
			apply(ctx) {
				const state = () => ctx.connection.state.getSnapshot() ?? "disconnected";
				// The session services are optional: without them the outbox can
				// still use the composer's own send button.
				const services = { sessions: undefined, uiSession: undefined };
				ctx.effect(() => ctx.inject(["sessions", "uiSession"], (scope) => {
					services.sessions = scope.get("sessions");
					services.uiSession = scope.get("uiSession");
				}), "dsh-mobile: session services");
				const outbox = createOutbox(services);
				ctx.effect(() => installStyles(), "dsh-mobile: styles");
				ctx.effect(() => installViewport(), "dsh-mobile: viewport");
				ctx.effect(() => installAppMetadata(), "dsh-mobile: app metadata");
				ctx.effect(() => installServiceWorker(), "dsh-mobile: service worker");
				ctx.effect(() => installKeyboardInset(), "dsh-mobile: keyboard inset");
				ctx.effect(() => installOutbox(outbox, state), "dsh-mobile: outbox");
				ctx.effect(() => installStatus(ctx, outbox, state), "dsh-mobile: sync status");
				ctx.effect(() => installInstallHint(), "dsh-mobile: install hint");
				// A native wrapper (the Android app) has no access to the client
				// context, so the state is readable from the page as well.
				ctx.effect(() => {
					globalThis.__DSH_MOBILE_STATE__ = () => ({ state: state(), pending: outbox.items.length });
					return () => {
						delete globalThis.__DSH_MOBILE_STATE__;
					};
				}, "dsh-mobile: state bridge");
			},
		};
	},
});
