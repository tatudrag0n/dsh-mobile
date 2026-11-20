import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { SERVICE_WORKER, renderPairPath } from '../assets/pages.js';

function worker({ cacheControl = 'public', offline = false } = {}) {
  const handlers = {}, stores = new Map(), deleted = [], fetched = [];
  const store = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return { match: async key => entries.get(key.url ?? key), put: async (key, value) => entries.set(key.url ?? key, value), add: async key => entries.set(key, 'offline page') };
  };
  const response = { ok: true, type: 'basic', headers: new Headers({ 'cache-control': cacheControl }), clone() { return this; } };
  runInNewContext(renderPairPath(SERVICE_WORKER, '/ops').replace('__DSH_MOBILE_VERSION__', 'test'), {
    URL, Response,
    self: { location: { origin: 'https://host.test' }, addEventListener: (name, fn) => handlers[name] = fn, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async name => store(name), keys: async () => [...stores.keys()], delete: async name => { deleted.push(name); return stores.delete(name); } },
    fetch: async request => { fetched.push(request.url); if (offline) throw Error('offline'); return response; },
  });
  return { stores, deleted, fetched, async event(name) { let promise; handlers[name]({ waitUntil: p => promise = p }); await promise; },
    async get(path, mode = 'cors') {
      let promise;
      handlers.fetch({ request: { url: `https://host.test${path}`, method: 'GET', mode }, respondWith: p => promise = p });
      return promise === undefined ? undefined : await promise;
    } };
}

test('pairing, sync, auth and arbitrary JS URLs never consult Cache Storage', async () => {
  const w = worker();
  for (const path of ['/ops/pair', '/ops/sync', '/connect?token=secret', '/api/session/list', '/plugin.js', '/ops/icon.svg?token=secret']) {
    assert.equal(await w.get(path), undefined);
  }
  assert.equal(w.stores.size, 0);
});

test('only allowlisted icons are cached; no-store/private/no-cache responses are not', async () => {
  const w = worker();
  await w.get('/ops/icon.svg'); await w.get('/ops/icon.svg');
  assert.equal(w.fetched.length, 1);
  for (const cacheControl of ['no-store', 'private, max-age=60', 'no-cache']) {
    const restricted = worker({ cacheControl });
    await restricted.get('/ops/icon.svg'); await restricted.get('/ops/icon.svg');
    assert.equal(restricted.fetched.length, 2);
    assert.equal([...restricted.stores.values()][0].size, 0);
  }
});

test('activation removes old mobile caches including leaked auth, but preserves other apps', async () => {
  const w = worker();
  w.stores.set('dsh-mobile-v1-old', new Map([['/ops/pair', 'secret']]));
  w.stores.set('another-plugin', new Map());
  await w.event('install'); await w.event('activate');
  assert.deepEqual(w.deleted, ['dsh-mobile-v1-old']);
  assert.ok(w.stores.has('another-plugin'));
});

test('offline navigation reads only this worker cache and uses the configured prefix', async () => {
  const w = worker({ offline: true });
  await w.event('install');
  assert.equal(await w.get('/', 'navigate'), 'offline page');
});
