import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { readBody } from '../lib/http.js';
import { createPinGate, resolveOptions } from '../lib/host.js';

function request(headers = {}) { return Object.assign(new PassThrough(), { headers }); }

test('body reader enforces declared and streamed byte limits, including UTF-8', async () => {
  await assert.rejects(readBody(request({ 'content-length': '1025' })), { status: 413 });
  await assert.rejects(readBody(request({ 'content-length': '-1' })), { status: 400 });
  const req = request(); const result = readBody(req, { maxBytes: 5 });
  req.end('日本'); await assert.rejects(result, { status: 413 });
  const valid = request(); const text = readBody(valid); valid.end('日本語'); assert.equal(await text, '日本語');
});

test('body reader uses an absolute deadline and releases concurrency slots', async () => {
  const slow = request(); const pending = readBody(slow, { timeoutMs: 20, maxActive: 1 });
  await assert.rejects(readBody(request(), { maxActive: 1 }), { status: 503 });
  slow.write('a'); await assert.rejects(pending, { status: 408 });
  const next = request(); const result = readBody(next, { maxActive: 1 }); next.end('ok'); assert.equal(await result, 'ok');
});

test('aborted requests release their listeners and slots', async () => {
  const req = request(); const result = readBody(req); req.emit('aborted');
  await assert.rejects(result, { status: 400 });
  assert.equal(req.listenerCount('data'), 0);
});

test('PIN records expire, capacity fails closed, invalid configuration is rejected', () => {
  let now = 0;
  const gate = createPinGate({ pin: '123456', maxAttempts: 2, lockoutMinutes: 1, maxRecords: 2 }, () => now);
  gate.check('A', 'wrong'); gate.check('B', 'wrong');
  assert.equal(gate.check('C', '123456').reason, 'locked');
  gate.check('A', 'wrong'); assert.equal(gate.check('A', '123456').reason, 'locked');
  now = 60001;
  assert.equal(gate.attemptsFor('A'), 0);
  assert.equal(gate.check('C', '123456').ok, true);
  for (const value of [0, -1, 1e9]) {
    assert.equal(resolveOptions({ maxFailedPinAttempts: value }).maxAttempts, 5);
    assert.equal(resolveOptions({ lockoutMinutes: value }).lockoutMinutes, 10);
  }
});
