/**
 * Static surfaces the DSH Mobile host half serves to the phone.
 *
 * Every page here is plain HTML/CSS/JS with no build step: the host writes
 * them to the wire as-is, so a phone needs nothing but a browser.
 */

/** The web app manifest, served next to the pairing card. */
export const MANIFEST = {
	name: "DeepSeek Harness",
	short_name: "DSH",
	description: "DeepSeek Harness on your phone, paired with the PC host.",
	start_url: "/",
	scope: "/",
	display: "standalone",
	orientation: "portrait-primary",
	background_color: "#15171c",
	theme_color: "#15171c",
	icons: [
		{ src: "/mobile/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
		{ src: "/mobile/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
		{ src: "/mobile/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
	],
};

/**
 * The service worker: an offline shell, never an API cache.
 *
 * Navigations are network-first (the page carries a live boot payload, so a
 * stale copy would be wrong) and fall back to the offline page. Static assets
 * carry a content hash in their file name, so they are cached forever. The
 * `/api` prefix is never touched: the Host is the source of truth for state.
 */
export const SERVICE_WORKER = `const CACHE = 'dsh-mobile-v1-__DSH_MOBILE_VERSION__';
const OFFLINE = '/mobile/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.add(OFFLINE).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api')) return;
  if (url.pathname === OFFLINE) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cached = await caches.match(OFFLINE);
        return cached ?? new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } });
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  })());
});
`;

/** The offline fallback the service worker serves when the PC is unreachable. */
export const OFFLINE_PAGE = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>DSH - オフライン</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; min-height: 100dvh; display: grid; place-items: center;
        background: #15171c; color: #e5e7eb;
        font: 16px/1.7 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
        padding: calc(24px + env(safe-area-inset-top)) 24px calc(24px + env(safe-area-inset-bottom));
        text-align: center;
      }
      h1 { font-size: 1.25rem; margin: 0 0 8px; }
      p { margin: 0 0 20px; color: #9ca3af; }
      button {
        font: inherit; padding: 12px 22px; border-radius: 10px; border: 0;
        background: #7c8cf8; color: #10131a; font-weight: 600;
      }
    </style>
  </head>
  <body>
    <div>
      <h1>PC に接続できません</h1>
      <p>同じ Wi-Fi に戻ってから、もう一度お試しください。</p>
      <button onclick="location.reload()">再試行</button>
    </div>
  </body>
</html>
`;

/**
 * The pairing page.
 *
 * Two audiences share it. The PC, already holding a session cookie, sees the
 * pairing card immediately and can show the QR to the phone. The phone, which
 * has no session yet, presents the PIN the PC printed and then receives the
 * launch URL that mints its cookie.
 */
export const PAIR_PAGE = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="robots" content="noindex" />
    <title>DSH - ペアリング</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100dvh; display: grid; place-items: center;
        background: #15171c; color: #e5e7eb;
        font: 16px/1.7 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
        padding: calc(24px + env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom));
      }
      .card {
        width: min(420px, 100%); background: #1c1f26; border: 1px solid #2b2f38;
        border-radius: 16px; padding: 24px;
      }
      h1 { font-size: 1.15rem; margin: 0 0 4px; }
      .sub { color: #9ca3af; font-size: .875rem; margin: 0 0 20px; }
      label { display: block; font-size: .8125rem; color: #9ca3af; margin-bottom: 6px; }
      input {
        width: 100%; font: 600 1.25rem/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: .4em; text-align: center; padding: 14px; border-radius: 10px;
        border: 1px solid #2b2f38; background: #11141a; color: #e5e7eb;
      }
      input:focus { outline: 2px solid #7c8cf8; outline-offset: 1px; }
      button {
        width: 100%; margin-top: 14px; font: inherit; font-weight: 600;
        padding: 13px; border-radius: 10px; border: 0; background: #7c8cf8; color: #10131a;
      }
      button.ghost { background: #262a33; color: #e5e7eb; }
      .error { color: #f87171; font-size: .8125rem; margin-top: 10px; min-height: 1.2em; }
      .qr { display: none; text-align: center; }
      .qr canvas, .qr img { width: min(280px, 78vw); height: auto; background: #fff; border-radius: 12px; padding: 10px; }
      .url { word-break: break-all; font: .8125rem/1.6 ui-monospace, Menlo, monospace; color: #9ca3af; margin-top: 12px; }
      .alt { word-break: break-all; font: .8125rem/1.6 ui-monospace, Menlo, monospace; margin-top: 6px; }
      .alt a { color: #7c8cf8; }
      .host { font-size: .8125rem; color: #6b7280; margin-top: 18px; border-top: 1px solid #2b2f38; padding-top: 14px; }
      .hidden { display: none !important; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>DeepSeek Harness</h1>
      <p class="sub" id="lead">PC に表示されたペアリングPINを入力してください。</p>

      <form id="pin-form" class="hidden">
        <label for="pin">ペアリングPIN（6桁）</label>
        <input id="pin" name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" autofocus />
        <button type="submit">接続する</button>
        <p class="error" id="error"></p>
      </form>

      <div class="qr" id="qr">
        <div id="qr-image"></div>
        <p class="url" id="url"></p>
        <div id="alternatives"></div>
        <button id="go" type="button">DSH を開く</button>
      </div>

      <p class="host" id="host"></p>
    </main>

    <script src="/mobile/qr.js"></script>
    <script>
      const lead = document.getElementById('lead');
      const form = document.getElementById('pin-form');
      const qrBox = document.getElementById('qr');
      const error = document.getElementById('error');
      const urlBox = document.getElementById('url');
      const hostBox = document.getElementById('host');
      const alternativesBox = document.getElementById('alternatives');
      let target = '';

      function showPairing(payload) {
        target = payload.url;
        lead.textContent = 'このQRをスマホで読み取ってください。';
        form.classList.add('hidden');
        qrBox.style.display = 'block';
        urlBox.textContent = payload.url;
        hostBox.textContent = payload.host ? '接続先: ' + payload.host : '';
        for (const alternative of payload.alternatives ?? []) {
          const line = document.createElement('p');
          line.className = 'alt';
          const link = document.createElement('a');
          link.href = alternative;
          link.textContent = alternative;
          line.appendChild(link);
          alternativesBox.appendChild(line);
        }
        const canvas = document.createElement('canvas');
        const qr = window.qrcode(0, 'M');
        qr.addData(payload.url, 'Byte');
        qr.make();
        const count = qr.getModuleCount();
        const scale = 6;
        canvas.width = count * scale;
        canvas.height = count * scale;
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#000000';
        for (let row = 0; row < count; row += 1) {
          for (let column = 0; column < count; column += 1) {
            if (!qr.isDark(row, column)) continue;
            context.fillRect(column * scale, row * scale, scale, scale);
          }
        }
        document.getElementById('qr-image').appendChild(canvas);
      }

      async function request(pin) {
        const response = await fetch('/mobile/pair', {
          method: pin === undefined ? 'GET' : 'POST',
          headers: pin === undefined ? {} : { 'content-type': 'application/json' },
          body: pin === undefined ? undefined : JSON.stringify({ pin }),
        });
        return await response.json();
      }

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.textContent = '';
        const pin = document.getElementById('pin').value.trim();
        const payload = await request(pin);
        if (payload.status === 'ok') { showPairing(payload); return; }
        error.textContent = payload.reason === 'locked' ? '試行回数が多すぎます。しばらくしてからお試しください。' : 'PIN が違います。';
      });

      document.getElementById('go').addEventListener('click', () => { if (target) location.href = target; });

      request().then((payload) => {
        if (payload.status === 'ok') { showPairing(payload); return; }
        form.classList.remove('hidden');
      }).catch(() => { form.classList.remove('hidden'); });
    </script>
  </body>
</html>
`;
