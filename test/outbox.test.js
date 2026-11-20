import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('function createOutbox(services)');
const end = source.indexOf('\n\t\t/**\n\t\t * Watch for send attempts', start);
const factory = source.slice(start, end);
function setup({ storage = new Map(), send = async () => {}, confirm = () => true } = {}) {
  let draft = '', current = 'session-A';
  const calls = [], alerts = [];
  const box = runInNewContext(`(${factory})`, {
    crypto: webcrypto, Uint8Array, Date, OUTBOX_KEY: 'outbox', readDraft: () => draft,
    console: { warn() {} },
    window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, confirm, alert: text => alerts.push(text) },
  })({ uiSession: { get current() { return { value: { key: current } }; } }, sessions: { scope: id => ({ conversation: { send: async text => { calls.push({ id, text }); return send(text); } } }) } });
  return { box, calls, storage, alerts, draft: value => draft = value, session: value => current = value };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('queue is kept until acknowledgement; overlapping flushes send only once', async () => {
  const pending = deferred(); const h = setup({ send: () => pending.promise });
  h.box.add('first'); h.box.add('second');
  const sending = h.box.flush();
  assert.equal(h.box.items.length, 2);
  assert.equal(await h.box.flush(), false);
  assert.equal(h.calls.length, 1);
  h.box.clear(); assert.equal(h.box.items.length, 2, 'cannot discard an in-flight operation');
  pending.resolve(); assert.equal(await sending, true);
  assert.deepEqual(Array.from(h.box.items, item => item.text), ['second']);
});

test('switching sessions never redirects a queued message', async () => {
  const h = setup(); h.box.add('private A'); h.session('session-B');
  assert.equal(await h.box.flush({ manual: true }), false);
  assert.equal(h.calls.length, 0);
  h.session('session-A'); assert.equal(await h.box.flush(), true);
  assert.deepEqual(h.calls, [{ id: 'session-A', text: 'private A' }]);
});

test('edited/nonempty composer is neither clicked nor cleared', async () => {
  const h = setup(); h.box.add('queued'); h.draft('unrelated draft');
  assert.equal(await h.box.flush({ manual: true }), false);
  assert.equal(h.calls.length, 0); assert.equal(h.box.items.length, 1); assert.equal(h.alerts.length, 1);
});

test('failed sends survive reload and require confirmation, not automatic retry', async () => {
  const h = setup({ send: async () => { throw Error('lost acknowledgement'); } });
  h.box.add('keep'); const id = h.box.items[0].id;
  assert.equal(await h.box.flush(), false);
  assert.equal(h.box.items[0].status, 'uncertain');
  const reload = setup({ storage: h.storage, confirm: () => false });
  assert.equal(reload.box.items[0].id, id);
  assert.equal(await reload.box.flush(), false);
  assert.equal(await reload.box.flush({ manual: true }), false);
  assert.equal(reload.calls.length, 0);
  const confirmed = setup({ storage: h.storage });
  assert.equal(await confirmed.box.flush({ manual: true }), true);
});

test('abandoned in-flight entries and legacy entries are preserved without auto-send', async () => {
  const storage = new Map([['outbox', JSON.stringify([
    { id: 'old', text: 'maybe sent', sessionId: 'session-A', status: 'sending' },
    { text: 'legacy draft', at: 1 },
  ])]]);
  const h = setup({ storage });
  assert.equal(await h.box.flush(), false);
  assert.equal(h.box.items.length, 2);
  assert.equal(h.box.items[1].sessionId, null);
});

test('offline attempts record the destination and do not deduplicate across sessions', () => {
  const h = setup(); h.draft('same'); h.box.rememberAttempt(); h.box.rememberAttempt();
  assert.equal(h.box.items.length, 1);
  h.session('session-B'); h.box.rememberAttempt();
  assert.equal(h.box.items.length, 2);
  assert.notEqual(h.box.items[0].id, h.box.items[1].id);
});

test('unconfirmed delivery blocks automatic sending of later messages in the same conversation', async () => {
  const h = setup({ send: async () => { throw Error('unknown'); } });
  h.box.add('first'); h.box.add('second');
  await h.box.flush(); await h.box.flush();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(Array.from(h.box.items, item => item.text), ['first', 'second']);
});
