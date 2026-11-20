import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lockedPackages, download } from '../scripts/lib/termux.mjs';
import { zip } from '../scripts/lib/zip.mjs';
import { runtimeUrl } from '../scripts/lib/release.mjs';
import { spawnSync } from 'node:child_process';

const bytes = Buffer.from('verified package');
const entry = name => ({ Package: name, Version: '1.0', Architecture: 'aarch64', Filename: `pool/${name}.deb`, Size: String(bytes.length), SHA256: createHash('sha256').update(bytes).digest('hex') });

test('normal builds require reviewed architecture locks and never resolve latest', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-lock-'));
  try {
    const lockFile = path.join(dir, 'lock.json');
    await assert.rejects(lockedPackages({ arch: 'aarch64', lockFile }), /No lock/);
    const indexLoader = async () => new Map(['bash', 'nodejs'].map(name => [name, entry(name)]));
    const selected = await lockedPackages({ arch: 'aarch64', lockFile, updateLock: true, indexLoader });
    const locked = await lockedPackages({ arch: 'aarch64', lockFile, indexLoader: () => { throw Error('network forbidden'); } });
    assert.deepEqual(locked, selected);
    await assert.rejects(lockedPackages({ arch: 'x86_64', lockFile }), /No lock/);
    const raw = JSON.parse(readFileSync(lockFile)); raw.architectures.aarch64[0].SHA256 = '';
    writeFileSync(lockFile, JSON.stringify(raw));
    await assert.rejects(lockedPackages({ arch: 'aarch64', lockFile }), /Invalid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fresh and cached packages are checksum verified; poisoned downloads are not cached', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-deb-'));
  try {
    const file = path.join(dir, 'node.deb'); let calls = 0;
    const fetcher = async () => { calls++; return { ok: true, arrayBuffer: async () => bytes }; };
    writeFileSync(file, 'corrupt');
    await download('https://example.test/package', file, entry('nodejs'), fetcher);
    assert.deepEqual(readFileSync(file), bytes); assert.equal(calls, 1);
    await download('https://example.test/package', file, entry('nodejs'), fetcher); assert.equal(calls, 1);
    rmSync(file);
    await assert.rejects(download('https://example.test/package', file, entry('nodejs'), async () => ({ ok: true, arrayBuffer: async () => Buffer.from('bad') })), /mismatch/);
    assert.equal(existsSync(file), false); assert.equal(existsSync(`${file}.part`), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ZIP metadata is reproducible across time zones', () => {
  const code = "import {zip} from './scripts/lib/zip.mjs'; process.stdout.write(zip([{name:'x',data:Buffer.from('a')}]).toString('hex'))";
  const run = TZ => spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, TZ, SOURCE_DATE_EPOCH: '1700000000' } });
  const a = run('UTC'), b = run('Asia/Tokyo'); assert.equal(a.status, 0); assert.equal(b.status, 0); assert.equal(a.stdout, b.stdout);
  assert.ok(zip([{ name: 'x', data: bytes }]).length > 0);
});

test('live runner fails instead of silently skipping when no Host is configured', () => {
  const env = { ...process.env }; delete env.DSH_MOBILE_TEST_URL;
  const result = spawnSync(process.execPath, ['scripts/run-live-tests.mjs'], { env, encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /required/);
});

test('runtime URLs remain tied to the APK release and reject moving latest aliases', () => {
  const old = runtimeUrl('1.2.0', 'arm64-v8a');
  const next = runtimeUrl('1.3.0', 'arm64-v8a');
  assert.match(old, /releases\/download\/v1\.2\.0\//);
  assert.notEqual(old, next);
  assert.throws(() => runtimeUrl('1.2.0', 'arm64-v8a', 'https://github.com/x/y/releases/latest/download/runtime.zip'), /immutable/);
  assert.throws(() => runtimeUrl('1.2.0', 'arm64-v8a', 'http://example.com/runtime.zip'), /HTTPS/);
  assert.equal(runtimeUrl('1.2.0', 'x86_64', 'http://127.0.0.1:8099/runtime.zip'), 'http://127.0.0.1:8099/runtime.zip');
});
