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
		/** 単体モードでワークスペースを自動選択したか (二重に開かないための印)。 */
		let workspaceAutoSelected = false;
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
		 * The Host's pairing path prefix, as the pages serve it.
		 *
		 * pages.js / index.js take the prefix from configuration; the link tags
		 * this plugin adds must follow, or they 404 whenever the prefix moves.
		 * @returns the prefix, without a trailing slash.
		 */
		function mobilePrefix() {
			const configured = window.__DSH_MOBILE__?.pairPath;
			if (typeof configured === "string" && configured !== "") return configured.replace(/\/+$/, "");
			return "/mobile";
		}

		/**
		 * The stylesheet that adapts the shell to a phone.
		 * @returns the CSS text.
		 */
		function stylesheet() {
			return `
:root {
	--dsh-mobile-keyboard: 0px;
	--dsh-mobile-nav-height: 52px;
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

/* 下部ナビ: 新規セッション / セッション一覧 / 設定 を親指の届く位置に置く。
   レールのアイコンは 22dp 級でタッチターゲットとして小さく、片手では押せない。
   幅の広い画面ではレールが直接押せるので出さない (display は下の @media で切替)。 */
.dsh-mobile-nav {
	display: none;
	position: fixed;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 58;
	box-sizing: border-box;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	align-items: stretch;
	margin: 0;
	padding: 0 2px calc(var(--dsh-mobile-safe-bottom) + 2px);
	border-top: 1px solid var(--dsw-alias-border-l1, rgb(255 255 255 / 12%));
	background: var(--dsw-alias-bg-overlay, rgb(18 20 26 / 94%));
	-webkit-backdrop-filter: blur(12px);
	backdrop-filter: blur(12px);
	user-select: none;
	-webkit-user-select: none;
}
/* キーボードが出ている間はコンポーザに場所を譲る。 */
html[data-dsh-mobile-keyboard] .dsh-mobile-nav { display: none !important; }
.dsh-mobile-nav button {
	appearance: none;
	-webkit-appearance: none;
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 2px;
	min-height: calc(var(--dsh-mobile-nav-height) - 4px);
	margin: 0;
	padding: 4px 2px;
	border: 0;
	border-radius: 10px;
	background: transparent;
	color: var(--dsw-alias-label-secondary, #9aa2b1);
	font: 500 11px/1.2 system-ui, -apple-system, "Hiragino Sans", sans-serif;
	cursor: pointer;
}
.dsh-mobile-nav button:active { background: rgb(255 255 255 / 8%); }
.dsh-mobile-nav-glyph { font-size: 19px; line-height: 1; }

/* リモート接続時のアカウントログイン案内。ログインボタン自体は触らず、
   「ここでは使えない」ことだけを控えめに伝える。 */
.dsh-mobile-notice {
	position: fixed;
	left: 10px;
	right: 10px;
	bottom: calc(var(--dsh-mobile-safe-bottom) + var(--dsh-mobile-nav-height) + 8px);
	z-index: 59;
	box-sizing: border-box;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 10px;
	border-radius: 10px;
	border: 1px solid var(--dsw-alias-border-l1, rgb(255 255 255 / 14%));
	background: var(--dsw-alias-bg-overlay, rgb(18 20 26 / 94%));
	color: var(--dsw-alias-label-secondary, #c7ccd6);
	font: 12px/1.5 system-ui, -apple-system, "Hiragino Sans", sans-serif;
}
.dsh-mobile-notice[hidden] { display: none; }
.dsh-mobile-notice span { flex: 1; }
.dsh-mobile-notice button {
	flex: none;
	font: inherit;
	font-weight: 600;
	padding: 6px 8px;
	border: 0;
	border-radius: 8px;
	background: transparent;
	color: inherit;
}

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
		/* 実測 (411 CSS px) では 234 px までしか広がらず、右隣のリージョン
		   パネルの見出しが切れていた。画面幅いっぱいまで使う。 */
		width: min(92vw, 420px) !important;
		max-width: 420px !important;
		box-shadow: 0 0 32px rgb(0 0 0 / 35%);
	}
	/* サイドバー内で同じ "More" 行が二重に出る (… More / More) ときの片割れ。
	   文言で判定した重複にだけ印を付け、ここで消す。 */
	[data-dsh-mobile-dup="true"] { display: none !important; }
	/* 展開時に並べられるリージョンパネル (Automation tasks / Files / Terminal) は、
	   セッション一覧の右に置くと必ず切れる。狭い画面では重ねずに出さない。 */
	[class*="frame"]:not([data-sidebar-collapsed]) > [class*="sidebarCol"] [class*="regionArea"] {
		display: none !important;
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
		/* グリッドの 0px 列に残すと見出しが右端で切れるので、画面幅いっぱいの
		   オーバーレイにする。 */
		width: 100vw !important;
		background: var(--dsw-alias-bg-base, #15171c);
		box-shadow: 0 0 32px rgb(0 0 0 / 45%);
	}
	/* iOS zooms any field below 16px when it gains focus. */
	input, textarea, select { font-size: 16px !important; }
	[data-composer-input="true"] { font-size: 16px !important; line-height: 1.5 !important; }
	/* Finger-sized controls, and room for the home indicator, the keyboard and
	   the bottom bar this plugin adds (it would otherwise cover the composer). */
	[data-composer-seat] {
		padding-bottom: calc(var(--dsh-mobile-nav-height) + var(--dsh-mobile-safe-bottom) + var(--dsh-mobile-keyboard) + 6px) !important;
	}
	[data-conversation-region="composer"] button { min-height: 40px; min-width: 40px; }
	[data-conversation-region="composer"] [class*="primary"] { width: 44px !important; height: 44px !important; }
	/* Column resize handles are pointer-only chrome. */
	[class*="handle"], [data-width-handle] { display: none !important; }
	/* ヘッダー右上の "Preview" バッジと重なるため、チップはヘッダーから離して
	   右下 (下部ナビのすぐ上) に置く。ヘッダーの要素とは干渉しない。 */
	.dsh-mobile-chip {
		top: auto;
		right: calc(var(--dsh-mobile-safe-right) + 12px);
		bottom: calc(var(--dsh-mobile-safe-bottom) + var(--dsh-mobile-nav-height) + 12px);
		max-width: 60vw;
	}
	/* キーボードが出ている間はナビと一緒に引っ込める。 */
	html[data-dsh-mobile-keyboard] .dsh-mobile-chip { display: none !important; }

	/* DSH 側の本文カラムは clamp(680px, …) を下限にしていて、393 CSS px の
	   画面では縮められず、本文と composer が画面からはみ出す。ユーザー上書き用の
	   --dsh-chat-user-width を 100% にすれば、そこから導かれる
	   --dsh-chat-content-width / --dsh-composer-card-max-width も一緒に縮む。 */
	:root {
		--dsh-chat-user-width: 100% !important;
		--dsh-chat-content-width: 100% !important;
		/* DSH の本文は --dsh-content-font-size (既定 14px) で組まれている。 */
		--dsh-content-font-size: 16px !important;
		--dsh-content-font-delta: 2px !important;
	}

	/* 本文の文字を 16px 以上に。14px のままだと読みづらく、iOS では
	   フォーカス時に勝手にズームする。 */
	[data-conversation-region] { font-size: 16px !important; }
	[data-conversation-region] p,
	[data-conversation-region] li { line-height: 1.65 !important; }

	/* welcome (data-phase="hero") は縦中央寄せ + 32px の下余白で、電話では
	   上が大きく空いて「間延び」して見える。上寄せにして余白を詰める。 */
	[data-phase="hero"] [class*="scrollBody"],
	[data-content-phase="hero"] [class*="scrollBody"] {
		justify-content: flex-start !important;
		padding-top: 4px !important;
	}
	[data-phase="hero"] [class*="scrollBody"] > *,
	[data-content-phase="hero"] [class*="scrollBody"] > * {
		padding-bottom: 12px !important;
		margin-top: 0 !important;
	}

	/* 56px レールのアイコンは 22dp 級で押しにくい。折りたたみ時 (レール表示時)
	   だけ 44x44 のタッチターゲットに広げる。 */
	[class*="frame"][data-sidebar-collapsed] > [class*="sidebarCol"] button {
		min-width: 44px !important;
		min-height: 44px !important;
	}
	[class*="frame"][data-sidebar-collapsed] > [class*="sidebarCol"] button svg {
		width: 22px !important;
		height: 22px !important;
	}

	/* 下部ナビを出す。シート/ヒントはナビの上へ逃がす。 */
	.dsh-mobile-nav { display: grid; }
	.dsh-mobile-install {
		/* 右下のステータスチップ (ナビ + 12px) の上に逃がす。 */
		bottom: calc(var(--dsh-mobile-safe-bottom) + var(--dsh-mobile-nav-height) + 56px);
	}
	.dsh-mobile-panel { bottom: calc(var(--dsh-mobile-safe-bottom) + var(--dsh-mobile-nav-height) + 8px); }
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
				link.setAttribute("href", `${mobilePrefix()}/manifest.webmanifest`);
				document.head.append(link);
				added.push(link);
			}
			if (document.querySelector('link[rel="apple-touch-icon"]') === null) {
				const link = document.createElement("link");
				link.setAttribute("rel", "apple-touch-icon");
				link.setAttribute("href", `${mobilePrefix()}/icon-180.png`);
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
			if (!("serviceWorker" in navigator) || navigator.serviceWorker === undefined) return () => {};
			let cancelled = false;
			// 単体モードには /sw.js を配信するホストが居らず GET/HEAD が 404 に
			// なる。登録を試みる前に HEAD で確かめ、無ければ静かに諦める
			// (毎回コンソールに登録失敗を出さない)。オフライン用の仕組みが
			// 無くてもアプリは動く。
			fetch("/sw.js", { method: "HEAD", cache: "no-store" })
				.then((response) => {
					if (cancelled || response.ok !== true) return undefined;
					return navigator.serviceWorker.register("/sw.js", { scope: "/" });
				})
				.catch(() => {
					// 404・オフライン・非対応ブラウザ: 何もしない。
				});
			return () => {
				cancelled = true;
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

		/**
		 * Find the first control matching one of the selectors.
		 * @param selectors - the candidates, most specific first.
		 * @returns the element, or null.
		 */
		function findControl(selectors) {
			for (const selector of selectors) {
				const found = document.querySelector(selector);
				if (found !== null) return found;
			}
			return null;
		}

		/**
		 * Add the bottom bar: new session / session list / settings.
		 *
		 * The rail is a 56px column of 22dp icons, which a thumb cannot hit; the
		 * application exposes no API for these actions, so the bar clicks the
		 * existing controls — the same technique the outbox already uses.
		 * @returns a disposer.
		 */
		function installBottomNav() {
			const nav = document.createElement("nav");
			nav.className = "dsh-mobile-nav";
			nav.setAttribute("aria-label", "DSH モバイル操作");
			const entries = [
				{ glyph: "＋", label: "新規", selectors: ['[class*="newSession"]', '[aria-label*="新規"]'] },
				{ glyph: "☰", label: "一覧", selectors: ['[class*="sidebarCol"] [class*="toggle"]', '[class*="toggle"]', '[aria-label*="サイド"]', '[aria-label*="idebar"]'] },
				{ glyph: "⚙", label: "設定", selectors: ['[class*="settingsArea"] button', '[class*="settingsArea"] [role="button"]', '[aria-label*="設定"]', '[aria-label*="Settings"]'] },
			];
			for (const entry of entries) {
				const button = document.createElement("button");
				button.type = "button";
				button.setAttribute("aria-label", entry.label);
				const glyph = document.createElement("span");
				glyph.className = "dsh-mobile-nav-glyph";
				glyph.textContent = entry.glyph;
				const text = document.createElement("span");
				text.textContent = entry.label;
				button.append(glyph, text);
				button.addEventListener("click", () => {
					const target = findControl(entry.selectors);
					if (target === null) {
						console.warn("[dsh-mobile] bottom nav: no control for", entry.label);
						return;
					}
					target.click();
				});
				nav.append(button);
			}
			document.body.append(nav);

			// The bar steps aside while the keyboard is up: the composer needs the
			// room, and the CSS hides it off this attribute.
			const root = document.documentElement;
			const viewport = window.visualViewport;
			const syncKeyboard = () => {
				const height = viewport?.height ?? window.innerHeight;
				root.toggleAttribute("data-dsh-mobile-keyboard", height < window.innerHeight - 120);
			};
			viewport?.addEventListener("resize", syncKeyboard);
			viewport?.addEventListener("scroll", syncKeyboard);
			syncKeyboard();

			return () => {
				viewport?.removeEventListener("resize", syncKeyboard);
				viewport?.removeEventListener("scroll", syncKeyboard);
				root.removeAttribute("data-dsh-mobile-keyboard");
				nav.remove();
			};
		}

		/**
		 * Keep the phone keyboard out of password and API-key fields.
		 *
		 * Phone keyboards capitalise the first letter and "correct" words through
		 * the dictionary; in a key that silently produces a different, wrong value
		 * that looks identical. The attributes are added after the fact because the
		 * fields are rendered by the application, and surrounding whitespace — the
		 * usual paste accident — is dropped on blur.
		 * @returns a disposer.
		 */
		function installCredentialHygiene() {
			const SELECTOR = 'input[type="password"], input[autocomplete="off"], input[inputmode], textarea';
			const seen = new WeakSet();
			const harden = (field) => {
				if (seen.has(field)) return;
				seen.add(field);
				field.setAttribute("autocapitalize", "none");
				field.setAttribute("autocorrect", "off");
				field.setAttribute("spellcheck", "false");
				if (field.getAttribute("autocomplete") === null) field.setAttribute("autocomplete", "off");
			};
			const scan = (root) => {
				if (root instanceof Element && root.matches(SELECTOR)) harden(root);
				if (typeof root.querySelectorAll !== "function") return;
				for (const field of root.querySelectorAll(SELECTOR)) harden(field);
			};
			const onFocusIn = (event) => {
				if (event.target instanceof Element) scan(event.target);
			};
			const onBlur = (event) => {
				const field = event.target;
				if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) return;
				const value = field.value;
				if (typeof value !== "string") return;
				const trimmed = value.trim();
				if (trimmed === value) return;
				// React tracks the value it last rendered; writing through the
				// native setter keeps that tracker honest, so the input event
				// below is not swallowed as a no-op.
				const setter = Object.getOwnPropertyDescriptor(
					field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
					"value",
				)?.set;
				if (typeof setter === "function") setter.call(field, trimmed);
				else field.value = trimmed;
				// The application reads the value from its own state; tell it.
				field.dispatchEvent(new Event("input", { bubbles: true }));
			};
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					for (const node of record.addedNodes) {
						if (node instanceof Element) scan(node);
					}
				}
			});
			document.addEventListener("focusin", onFocusIn, true);
			document.addEventListener("focusout", onBlur, true);
			observer.observe(document.body, { childList: true, subtree: true });
			scan(document.body);
			return () => {
				document.removeEventListener("focusin", onFocusIn, true);
				document.removeEventListener("focusout", onBlur, true);
				observer.disconnect();
			};
		}

		/**
		 * Whether the page is served by a remote Host rather than this phone.
		 * @returns the answer.
		 */
		function isRemoteOrigin() {
			const host = window.location.hostname;
			if (host === "localhost" || host === "::1" || host === "[::1]") return false;
			return !/^127\./.test(host);
		}

		/**
		 * Tell the user that account sign-in only works on the phone itself.
		 *
		 * The account platform allows sign-in only when the Host origin is
		 * loopback http on an explicit port. A remote phone therefore cannot sign
		 * in at all: the button waits and then reports an expired attempt. The
		 * real cause (the Android WebView cannot open the browser window) is native
		 * and is fixed elsewhere; here it is only explained, never disabled.
		 * @returns a disposer.
		 */
		function installRemoteNotice() {
			const DISMISSED_KEY = "dsh.mobile.remoteNotice";
			if (isRemoteOrigin() !== true) return () => {};
			try {
				if (window.localStorage.getItem(DISMISSED_KEY) === "1") return () => {};
			} catch (error) {
				// A private-mode browser cannot remember it; showing it is harmless.
			}
			const banner = document.createElement("div");
			banner.className = "dsh-mobile-notice";
			const text = document.createElement("span");
			text.textContent = "アカウントログインはこのスマホ単体モードでのみ使えます。リモート接続では PC 側でログインしてください。";
			const close = document.createElement("button");
			close.type = "button";
			close.textContent = "閉じる";
			close.addEventListener("click", () => {
				banner.hidden = true;
				try {
					window.localStorage.setItem(DISMISSED_KEY, "1");
				} catch (error) {
					// Nothing to do: it simply shows again next time.
				}
			});
			banner.append(text, close);
			document.body.append(banner);
			return () => banner.remove();
		}

		/**
		 * 最後に開いていたセッションを端末に控える。
		 *
		 * 起動時に一覧 API がまだ空でも、この 1 件があれば「開き直す」ことが
		 * できる。起動のたびに新しいセッションが増えるのを止めるための要。
		 * @param services - the optional session services.
		 * @returns a disposer.
		 */
		function installLastSessionRecorder(services) {
			const KEY = "dsh.mobile.lastSession";
			let last = null;
			/**
			 * Remember the current Session whenever it changes.
			 *
			 * 空のセッションも覚える。Host 側で retain できず新規作成に落ちる
			 * ことがあるが、覚えておかないと「起動のたびに 1 本」から抜け出せ
			 * ないため、まず再利用率を優先する。
			 */
			const tick = () => {
				const current = services.uiSession?.current?.value?.key;
				if (typeof current !== "string" || current === "" || current === last) return;
				last = current;
				try {
					window.localStorage.setItem(KEY, current);
				} catch (error) {
					// 保存できない環境では何もしない。
				}
			};
			tick();
			// 信号の購読 API に依存せず、1 秒ごとに現在値を見るだけ (読み取りのみ)。
			if (typeof window.setInterval !== "function") return () => {};
			const timer = window.setInterval(tick, 1000);
			return () => window.clearInterval(timer);
		}

		/**
		 * 単体モードでワークスペースが未選択のまま起動したとき、Host が既に持って
		 * いる作業ディレクトリを自動で選ぶ。
		 *
		 * DSH の composer は「ワークスペース未選択」の間プレースホルダ
		 * ("Choose a workspace to start") を出すだけで入力を受け付けない。スマホの
		 * 単体モードでは候補が Host の作業ディレクトリ 1 つしかなく、選ばせても
		 * 意味がないので、起動時に一度だけ選ぶ。リモート接続では PC 側の選択に任せ、
		 * ディレクトリもファイルも作らない。
		 * @param services - the optional session services.
		 * @returns a disposer.
		 */
		function installWorkspaceAutoSelect(services) {
			// モジュールスコープのフラグ: 効果が張り直されても二重に開かない。
			if (workspaceAutoSelected === true) return () => {};
			// リモート (PC Host) では絶対に自動でセッションを作らない。
			if (isRemoteOrigin()) return () => {};
			const LAST_KEY = "dsh.mobile.lastSession";
			const WAIT_MS = 800;
			const MAX_WAIT = 15;
			const POLL_MS = 250;
			const POLL_MAX = 20;
			let stopped = false;
			let waited = 0;
			let polls = 0;
			let workspaceId = null;
			let timer = 0;
			/**
			 * Spend the one automatic selection (success or not: never again).
			 */
			const finish = () => {
				workspaceAutoSelected = true;
			};
			/**
			 * The Session this device opened last.
			 * @returns the Session id, or null.
			 */
			const readLast = () => {
				try {
					const value = window.localStorage.getItem(LAST_KEY);
					return typeof value === "string" && value !== "" ? value : null;
				} catch (error) {
					return null;
				}
			};
			/**
			 * Forget a Session id the Host no longer accepts.
			 */
			const forgetLast = () => {
				try {
					window.localStorage.removeItem(LAST_KEY);
				} catch (error) {
					// Nothing to do.
				}
			};
			/**
			 * The most recently used root Session the Host knows about.
			 * @param snapshot - the sessions list snapshot.
			 * @returns the Session id, or null when there is none.
			 */
			const latestSession = (snapshot) => {
				const byId = snapshot.byId ?? null;
				if (byId === null) return null;
				const entries = typeof byId.values === "function" ? [...byId.values()] : Object.values(byId);
				let best = null;
				for (const entry of entries) {
					if (entry === null || entry === undefined) continue;
					// サブエージェントのセッションは開かない。
					if (entry.parentSessionId !== undefined && entry.parentSessionId !== null) continue;
					const stamp = Number(entry.updatedAt ?? 0);
					if (best === null || stamp > best.stamp) best = { id: String(entry.sessionId ?? ""), stamp };
				}
				if (best === null || best.id === "") return null;
				return best.id;
			};
			/**
			 * Open a Session (never creates one).
			 * @param uiWorkspace - the workspace navigation service.
			 * @param id - the Session to open.
			 */
			const open = (uiWorkspace, id) => {
				try {
					const opened = uiWorkspace.openSession?.(id);
					if (opened !== undefined && typeof opened.catch === "function") {
						opened.catch((error) => console.debug("[dsh-mobile] openSession failed:", error?.message ?? error));
					}
				} catch (error) {
					console.debug("[dsh-mobile] openSession failed:", error?.message ?? error);
				}
			};
			/**
			 * Start one Session in the Workspace; older builds only have openWorkspace.
			 * @param uiWorkspace - the workspace navigation service.
			 * @param id - the Workspace to use, or undefined to inherit the current one.
			 */
			const start = (uiWorkspace, id) => {
				try {
					const started = id === null || id === undefined ? uiWorkspace.startSession() : uiWorkspace.startSession(id);
					if (started !== undefined && typeof started.catch === "function") {
						started.catch((error) => console.debug("[dsh-mobile] startSession failed:", error?.message ?? error));
					}
					return;
				} catch (error) {
					// Fall through to the older entry point below.
				}
				try {
					void uiWorkspace.openWorkspace?.(id)?.catch?.((error) => console.debug("[dsh-mobile] openWorkspace failed:", error?.message ?? error));
				} catch (error) {
					// The Host refused the selection; the picker stays as it is.
					console.debug("[dsh-mobile] workspace auto-select gave up:", error?.message ?? error);
				}
			};
			/**
			 * Whether the composer accepts input without a Session.
			 * @returns the answer.
			 */
			const composerReady = () => {
				const input = document.querySelector(COMPOSER_INPUT);
				if (input === null) return false;
				if (input.disabled === true || input.readOnly === true) return false;
				if (typeof input.getAttribute === "function" && input.getAttribute("contenteditable") === "false") return false;
				const seat = document.querySelector("[data-composer-seat]") ?? document.body;
				const hint = `${seat.textContent ?? ""}`.slice(0, 400);
				if (/choose a workspace|select a workspace|ワークスペースを選択|选择一个工作区/i.test(hint)) return false;
				return true;
			};
			/**
			 * 最後の手段: セッションを 1 本だけ作る。
			 * @param uiWorkspace - the workspace navigation service.
			 */
			const createOnce = (uiWorkspace) => {
				finish();
				start(uiWorkspace, workspaceId);
			};
			/**
			 * composer が使えるようになるまで様子を見る。使えるならセッションは
			 * 作らない (最初の送信で DSH 自身が作る)。
			 * @param uiWorkspace - the workspace navigation service.
			 */
			const watchComposer = (uiWorkspace) => {
				if (stopped || workspaceAutoSelected) return;
				if (composerReady() === true) {
					finish();
					return;
				}
				polls += 1;
				if (polls < POLL_MAX) {
					timer = window.setTimeout(() => watchComposer(uiWorkspace), POLL_MS);
					return;
				}
				createOnce(uiWorkspace);
			};
			/**
			 * ワークスペースを用意するだけ。セッションは作らない。
			 * @param uiWorkspace - the workspace navigation service.
			 */
			const prepareWorkspace = (uiWorkspace) => {
				const holder = uiWorkspace.workspaces;
				const snapshot = holder?.list?.getSnapshot?.() ?? null;
				if (snapshot === null) {
					schedule(uiWorkspace, () => prepareWorkspace(uiWorkspace));
					return;
				}
				const first = (snapshot.items ?? [])[0];
				if (first !== undefined) {
					workspaceId = first.id;
					watchComposer(uiWorkspace);
					return;
				}
				if (typeof holder?.initializeDefault !== "function") {
					watchComposer(uiWorkspace);
					return;
				}
				// Host の既定ワークスペースを再利用する (ディレクトリは作られない)。
				holder
					.initializeDefault()
					.then((view) => {
						if (stopped) return;
						if (view !== undefined && view !== null) workspaceId = view.id;
						watchComposer(uiWorkspace);
					})
					.catch((error) => {
						if (stopped) return;
						console.debug("[dsh-mobile] workspace prepare skipped:", error?.message ?? error);
						watchComposer(uiWorkspace);
					});
			};
			/**
			 * 記憶したセッション → 一覧の最新 → ワークスペースだけ用意 の順。
			 * @param uiWorkspace - the workspace navigation service.
			 */
			const resume = (uiWorkspace) => {
				if (stopped || workspaceAutoSelected) return;
				const sessionsService = services.sessions;
				const snapshot = sessionsService?.list?.getSnapshot?.() ?? null;
				const existing = snapshot === null ? null : latestSession(snapshot);
				if (existing !== null) {
					finish();
					open(uiWorkspace, existing);
					return;
				}
				prepareWorkspace(uiWorkspace);
			};
			/**
			 * Wait a little and try again (the Host link is still coming up).
			 * @param uiWorkspace - the workspace navigation service.
			 * @param again - what to retry.
			 */
			const schedule = (uiWorkspace, again) => {
				if (stopped) return;
				waited += 1;
				if (waited >= MAX_WAIT) {
					if (uiWorkspace !== undefined && uiWorkspace !== null) resume(uiWorkspace);
					return;
				}
				timer = window.setTimeout(again, WAIT_MS);
			};
			/**
			 * b) 記憶したセッション → c) 一覧の最新 → d) ワークスペースだけ用意。
			 */
			const choose = () => {
				timer = 0;
				if (stopped || workspaceAutoSelected) return;
				// すでにセッションが開いていれば選択済み。何もしない。
				if (services.uiSession?.current?.value?.key) {
					finish();
					return;
				}
				const uiWorkspace = services.uiWorkspace;
				if (uiWorkspace === undefined || uiWorkspace === null) {
					schedule(undefined, choose);
					return;
				}
				const remembered = readLast();
				if (remembered === null) {
					resume(uiWorkspace);
					return;
				}
				// b: 前回のセッション。開けたかどうかは少し待って確かめる。
				open(uiWorkspace, remembered);
				timer = window.setTimeout(() => {
					if (stopped || workspaceAutoSelected) return;
					if (services.uiSession?.current?.value?.key) {
						finish();
						return;
					}
					// 空セッションは Host に永続化されず retain できない。控えを捨てる。
					forgetLast();
					resume(uiWorkspace);
				}, 1500);
			};
			timer = window.setTimeout(choose, 1200);
			return () => {
				stopped = true;
				window.clearTimeout(timer);
			};
		}

	/**
	 * 展開したサイドバーで "More" 行が二重に出るとき、後から出た方を隠す。
	 *
	 * DSH のサイドバーは同じ「もっと見る」を複数の区画に描くことがあり、狭い
	 * 画面では両方が縦に並んで重複して見える。文言で判定し、同じサイドバー内で
	 * 最初の 1 つだけ残す (印は CSS の [data-dsh-mobile-dup] が消す)。
	 * @returns a disposer.
	 */
	function installSidebarDedupe() {
		const DUPLICATE = /^(?:…|\.\.\.)?\s*(?:more|もっと見る|さらに表示|すべて表示|显示更多)$/i;
		const HEADINGISH = /section|heading|group|title/i;
		let timer = 0;
		/**
		 * Whether the row sits in a heading / group label rather than in the
		 * clickable list (the duplicate "More" with the grid icon is the label).
		 * @param row - the candidate row.
		 * @returns the answer.
		 */
		const headingLike = (row) => {
			let node = row;
			let depth = 0;
			while (node !== null && node !== undefined && depth < 4) {
				if (/^H[1-6]$/.test(node.tagName ?? "")) return true;
				if (typeof node.getAttribute === "function" && node.getAttribute("role") === "heading") return true;
				const name = typeof node.className === "string" ? node.className : "";
				if (name !== "" && HEADINGISH.test(name)) return true;
				node = node.parentElement;
				depth += 1;
			}
			return false;
		};
		/**
		 * Keep the clickable navigation row; hide the heading duplicate, and when
		 * both are plain rows keep only the first.
		 */
		const sweep = () => {
			timer = 0;
			for (const sidebar of document.querySelectorAll('[class*="sidebarCol"]')) {
				const rows = [];
				for (const row of sidebar.querySelectorAll('button, [role="button"], a')) {
					const text = (row.textContent ?? "").replace(/\s+/g, " ").trim();
					if (text.length === 0 || text.length > 24) continue;
					if (DUPLICATE.test(text)) rows.push(row);
				}
				const headings = rows.filter((row) => headingLike(row) === true);
				const plain = rows.filter((row) => headings.includes(row) === false);
				// 構造で見分けられない場合も「同じ文言が 2 回見えない」ことを優先し、
				// 押せる項目 (無ければ最後の行) だけを残す = DOM 順で先の重複を消す。
				const keep = plain.length > 0 ? plain[plain.length - 1] : rows[rows.length - 1];
				rows.forEach((row) => {
					row.toggleAttribute("data-dsh-mobile-dup", row !== keep);
				});
			}
		};
		const schedule = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(sweep, 150);
		};
		const observer = new MutationObserver(schedule);
		observer.observe(document.body, { childList: true, subtree: true });
		sweep();
		return () => {
			observer.disconnect();
			window.clearTimeout(timer);
			for (const row of document.querySelectorAll("[data-dsh-mobile-dup]")) row.removeAttribute("data-dsh-mobile-dup");
		};
	}

	/**
	 * 一度 Continue した "Preview Notice" が毎回また出るのを抑える。
	 *
	 * 本来の閉じる処理は Host の設定に保存される (settings controller の
	 * acknowledge)。スマホの WebView ではその保存が通らず、毎回同じ案内が
	 * 出てくる。ここでは「この端末でこの文面を閉じた」ことを localStorage に
	 * 控えておき、次に出てきたら同じボタンを自動で押す。それでも消えないときだけ
	 * ダイアログを隠す。文面の指紋をキーに含めているので、DSH が更新されて
	 * 案内文が変われば新しい通知として一度だけ出る。
	 * DSH 側の保存が直れば不要になる応急処置。
	 * @returns a disposer.
	 */
	function installPreviewNoticeGuard() {
		const KEY = "dsh.mobile.notice";
		const TITLE = /preview notice|プレビュー通知|预览通知|プレビュー/i;
		const ACCEPT = /continue|i understand|agree|accept|got it|続け|理解|了解|同意|開始|知道了|继续/i;
		/**
		 * 閉じた通知の指紋 (文面のハッシュ) を読む。
		 * @returns the fingerprints seen on this device.
		 */
		const readSeen = () => {
			try {
				const raw = window.localStorage.getItem(KEY);
				if (raw === null) return [];
				const parsed = JSON.parse(raw);
				return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
			} catch (error) {
				return [];
			}
		};
		/**
		 * 文面から指紋を作る。バージョンが上がって文面が変われば別物になる。
		 * @param dialog - the notice dialog.
		 * @returns the fingerprint.
		 */
		const fingerprint = (dialog) => {
			const text = (dialog.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
			let hash = 0x811c9dc5;
			for (let index = 0; index < text.length; index += 1) {
				hash ^= text.charCodeAt(index);
				hash = Math.imul(hash, 0x01000193) >>> 0;
			}
			return hash.toString(36);
		};
		/**
		 * 覚えておく。失敗しても表示には影響しない。
		 * @param value - the fingerprint.
		 */
		const remember = (value) => {
			try {
				const seen = readSeen();
				if (seen.includes(value)) return;
				window.localStorage.setItem(KEY, JSON.stringify([...seen, value].slice(-8)));
			} catch (error) {
				// Private mode: it will simply show again next launch.
			}
		};
		/**
		 * The accept button of the notice, if the dialog is the notice.
		 * @param dialog - the candidate dialog.
		 * @returns the button, or null.
		 */
		const acceptButton = (dialog) => {
			const primary = dialog.querySelector('[class*="primary"]');
			if (primary !== null) return primary;
			const buttons = [...dialog.querySelectorAll("button")];
			return buttons.find((button) => ACCEPT.test(button.textContent ?? "")) ?? null;
		};
		/**
		 * Find the notice among the open dialogs / portals.
		 * @returns the dialog, or null.
		 */
		const findDialog = () => {
			const candidates = document.querySelectorAll(
				'[class*="Onboarding"], [role="dialog"], [role="alertdialog"], [class*="modal"], [class*="Modal"], [class*="overlay"], [class*="Overlay"]',
			);
			for (const dialog of candidates) {
				const text = dialog.textContent ?? "";
				if (text.length > 4000) continue;
				const title = dialog.querySelector("h1, h2, h3, [class*='title'], [class*='Title']");
				if (TITLE.test(`${title?.textContent ?? ""} ${text.slice(0, 120)}`)) return dialog;
			}
			// どのクラス名にも当たらない場合の保険: 主ボタンから親をたどり、
			// 案内文を持つ一番内側のまとまりをダイアログとみなす。
			for (const button of document.querySelectorAll('[class*="primary"]')) {
				let node = button.parentElement;
				let depth = 0;
				while (node !== null && node !== document.body && depth < 8) {
					const text = node.textContent ?? "";
					if (text.length > 0 && text.length <= 4000 && TITLE.test(text.slice(0, 160))) return node;
					node = node.parentElement;
					depth += 1;
				}
			}
			return null;
		};
		/**
		 * Hide the notice's outermost portal so it stops blocking the phone.
		 * @param dialog - the notice dialog.
		 */
		const hide = (dialog) => {
			let node = dialog;
			while (node.parentElement !== null && node.parentElement !== document.body) node = node.parentElement;
			node.style.display = "none";
		};
		let timer = 0;
		/**
		 * Handle the notice whenever it (re)appears in the DOM.
		 */
		const handle = () => {
			const dialog = findDialog();
			if (dialog === null) return;
			const mark = fingerprint(dialog);
			if (!readSeen().includes(mark)) return;
			const button = acceptButton(dialog);
			if (button !== null) button.click();
			// Host 側の保存が失敗して閉じない場合だけ、最後の手段として隠す。
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				const again = findDialog();
				if (again !== null) hide(again);
			}, 1500);
		};
		/**
		 * Remember the notice when its accept button is pressed, wherever the
		 * button is re-rendered (React replaces the node, so the dialog is
		 * resolved at click time rather than at mount).
		 * @param event - the click.
		 */
		const onClick = (event) => {
			const target = event.target;
			if (target === null || typeof target.closest !== "function") return;
			const dialog = findDialog();
			if (dialog === null) return;
			const button = acceptButton(dialog);
			if (button === null) return;
			if (button !== target && button.contains(target) !== true) return;
			remember(fingerprint(dialog));
		};
		// 起動直後に一度だけ見るのではなく、React が差し替えても取りこぼさない
		// ように監視を張り続ける。
		const observer = new MutationObserver(handle);
		observer.observe(document.body, { childList: true, subtree: true });
		document.addEventListener("click", onClick, true);
		handle();
		return () => {
			observer.disconnect();
			document.removeEventListener("click", onClick, true);
			window.clearTimeout(timer);
		};
	}

		/**
		 * ホストが開いているセッションが空（blank）なら、PC で実際に話している
		 * 最新のセッションへ自動で追従する。スマホ版 DSH が「PC の画面Continuation」を
		 * なぞるためのもので、イベント履歴がないセッションのままだと
		 * 「履歴が読み込めない」ように見えるため。
		 *
		 * @param ctx - the client context.
		 * @param services - the optional session services.
		 */
		/**
		 * ホストが開いているセッションが空（blank）なら、PC で実際に話している
		 * 最新のセッションへ自動で追従する。スマホ版 DSH が「PC と同じ画面」を
		 * なぞるためのもので、イベント履歴がないセッションのままだと
		 * 「履歴が読み込めない」ように見えるため。
		 *
		 * @param ctx - the client context.
		 * @param services - the session services.
		 */
		/**
		 * ホストが開いているセッションが空（blank）なら、PC で実際に話している
		 * 最新のセッションへ自動で追従する。スマホ版 DSH が「PC と同じ画面」を
		 * なぞるためのもので、イベント履歴がないセッションのままだと
		 * 「履歴が読み込めない」ように見えるため。
		 *
		 * @param ctx - the client context.
		 * @param services - the session services.
		 */
		/**
		 * ホストが開いているセッションが空（blank）なら、PC で実際に話している
		 * 最新のセッションへ自動で追従する。
		 *
		 * スマホ版 DSH は「PC でいま話している会話」をそのまま追いかけたかった。
		 * ホストは自分の空セッションを復元するため、起動直後は必ず履歴のない
		 * セッションが開く。ここではその空セッションを置き換え、意思のある
		 * 会話（blank でない最新のセッション）へ移動する。ユーザーが既に
		 * 入力を始めたセッションは blank ではないので触らない。
		 *
		 * @param ctx - the client context.
		 * @param services - the session services.
		 */
		async function installSessionMirror(ctx, services) {
			const currentId = () => {
				try {
					return services.uiSession?.current?.value?.key;
				} catch {
					return undefined;
				}
			};
			const storeRows = () => {
				try {
					return services.sessions?.list?.getSnapshot()?.byId ?? {};
				} catch {
					return {};
				}
			};
			const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
			const listSessions = async () => {
				const response = await fetch("/api/session/list", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						type: "client-request",
						rpcId: `dsh-mobile-${Date.now()}`,
						method: "session/list",
						payload: { args: { _request: {} } },
					}),
				});
				if (!response.ok) throw new Error(`session/list failed: ${response.status}`);
				const payload = await response.json();
				return payload?.result?.value?.items ?? [];
			};

			// The phone is a peer, not a mirror: it may open its own independent
			// sessions. We only nudge it onto a real conversation on the very
			// first load (so it does not sit on the host's empty restored
			// session), and we stop the moment the user takes control.
			if (window.__DSH_MOBILE_MIRROR_DONE__) return;
			window.__DSH_MOBILE_MIRROR_DONE__ = true;

			let userInteracted = false;
			const markInteracted = () => { userInteracted = true; };
			document.addEventListener("click", markInteracted, { capture: true, once: true });
			document.addEventListener("keydown", markInteracted, { capture: true, once: true });

			const initialId = currentId();

			await sleep(2000);

			for (let attempt = 0; attempt < 15 && !userInteracted; attempt += 1) {
				const nowId = currentId();
				// The user navigated to (or created) their own session: leave it alone.
				if (nowId !== initialId) return;

				const rows = storeRows();
				const current = nowId !== undefined ? rows[nowId] : undefined;
				if (current === undefined) {
					await sleep(1000);
					continue;
				}
				// Already on a real conversation (the user's or the PC's): nothing to do.
				if (current.blank !== true) return;

				let items = [];
				try {
					items = await listSessions();
				} catch (error) {
					console.warn("dsh-mobile: 最新セッションへの追従に失敗しました", error);
					await sleep(1000);
					continue;
				}

				const target = items
					.filter((item) => item.blank !== true)
					.sort((left, right) => right.updatedAt - left.updatedAt)[0];
				if (target === undefined) return;

				if (!Object.hasOwn(storeRows(), target.sessionId)) {
					await sleep(1000);
					continue;
				}

				try {
					await services.uiWorkspace?.openSession(target.sessionId);
				} catch (error) {
					console.warn("dsh-mobile: セッションを開けませんでした", error);
					await sleep(1000);
					continue;
				}

				// Confirm the switch actually landed (startup can race us).
				for (let wait = 0; wait < 12 && !userInteracted; wait += 1) {
					if (currentId() === target.sessionId) return;
					await sleep(500);
				}
				return;
			}

			// Auto-sync: refresh the current session when the phone returns to the
			// foreground or the link (re)connects, so new content from the PC shows
			// up without a manual reload. Never interrupts a half-typed message.
			const refreshCurrent = async () => {
				if (userInteracted) return;
				if (document.visibilityState !== "visible") return;
				let state = "disconnected";
				try { state = ctx.connection.state.getSnapshot() ?? "disconnected"; } catch {}
				if (state !== "connected") return;
				const id = currentId();
				if (id === undefined) return;
				const composer = document.querySelector('[data-composer-input]');
				if (composer && String(composer.value ?? "").trim() !== "") return;
				try {
					await services.uiWorkspace?.openSession(id);
				} catch (error) {
					// Refresh is best-effort; ignore failures.
				}
			};

			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState === "visible") void refreshCurrent();
			});
			try {
				ctx.connection.state.subscribe(() => { void refreshCurrent(); });
			} catch (error) {
				// Connection state subscription is optional.
			}
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
				const services = { sessions: undefined, uiSession: undefined, uiWorkspace: undefined };
				ctx.effect(() => ctx.inject(["sessions", "uiSession", "uiWorkspace"], (scope) => {
					services.sessions = scope.get("sessions");
					services.uiSession = scope.get("uiSession");
					services.uiWorkspace = scope.get("uiWorkspace");
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
				ctx.effect(() => installBottomNav(), "dsh-mobile: bottom nav");
				ctx.effect(() => installCredentialHygiene(), "dsh-mobile: credential inputs");
				ctx.effect(() => installRemoteNotice(), "dsh-mobile: remote account notice");
				ctx.effect(() => installWorkspaceAutoSelect(services), "dsh-mobile: workspace auto-select");
				ctx.effect(() => installLastSessionRecorder(services), "dsh-mobile: last session recorder");
				ctx.effect(() => installPreviewNoticeGuard(), "dsh-mobile: preview notice guard");
				ctx.effect(() => installSidebarDedupe(), "dsh-mobile: sidebar dedupe");
				ctx.effect(() => installSessionMirror(ctx, services), "dsh-mobile: session mirror");
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
