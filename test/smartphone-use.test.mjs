/**
 * The phone tools, against a fake bridge.
 *
 * These tests drive the plugin the way the Host does: they mount it with a
 * stub context, collect the tools it registers, and call them. The bridge on
 * the other end is a real HTTP server, so the wire format, the bearer token and
 * the screenshot move are exercised rather than mocked away.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { apply } from '../runtime/plugins/smartphone-use/index.js'

/** A 1x1 PNG, standing in for a screenshot the app would capture. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/AJ0q9wAAAABJRU5ErkJggg==',
  'base64',
)

let server
let port
let token
let calls
let workspace

before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'dsh-phone-'))
  server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', async () => {
      const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
      calls.push({ path: request.url, body, authorization: request.headers.authorization })
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: 'bad token' }))
        return
      }
      if (request.url === '/fail') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: 'アクセシビリティが無効です' }))
        return
      }
      const answers = {
        '/status': { ok: true, screenWidth: 1080, screenHeight: 2400, accessibility: true, android: '16', model: 'Test' },
        '/screen': { ok: true, path: await writeShot(), width: 1, height: 1 },
        '/nodes': { ok: true, tree: '[Button] text="OK" bounds=10,20 100x50', count: 1 },
        '/tap': { ok: true },
        '/swipe': { ok: true },
        '/type': { ok: true, focused: 'com.example:id/field' },
        '/key': { ok: true },
        '/apps': { ok: true, apps: [{ label: '設定', package: 'com.android.settings' }] },
        '/launch': { ok: true, label: '設定' },
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answers[request.url] ?? { ok: false, error: 'unknown' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  token = 'test-token'
  calls = []

  async function writeShot() {
    const file = path.join(workspace, 'bridge-shot.png')
    await writeFile(file, PNG)
    return file
  }
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(workspace, { recursive: true, force: true })
})

/**
 * Mount the plugin and collect its tools.
 *
 * @param {object} config - The plugin configuration.
 * @returns {Map<string, object>} Tools by name.
 */
function mountWith(config) {
  const tools = new Map()
  apply({
    effect(callback) {
      const dispose = callback()
      return () => dispose?.()
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    get() {
      return undefined
    },
  }, config)
  return tools
}

/**
 * Mount against the fake bridge.
 *
 * @returns {Map<string, object>} Tools by name.
 */
async function mount() {
  return mountWith({ url: `http://127.0.0.1:${port}/`, token, shotDirectory: 'phone-shots' })
}

test('registers the phone tools', async () => {
  const tools = await mount()
  assert.deepEqual([...tools.keys()].sort(), [
    'phone_apps', 'phone_key', 'phone_launch', 'phone_nodes',
    'phone_screen', 'phone_status', 'phone_swipe', 'phone_tap', 'phone_type',
  ])
})

test('phone_status reports the screen and the accessibility state', async () => {
  const tools = await mount()
  const value = await tools.get('phone_status').execute({})
  assert.equal(value.screenWidth, 1080)
  assert.equal(value.accessibility, true)
  const [block] = tools.get('phone_status').output.render({}, value)
  assert.match(block.text, /accessibility service: on/)
})

test('phone_screen copies the capture into the workspace', async () => {
  const tools = await mount()
  const value = await tools.get('phone_screen').execute({}, { agent: undefined })
  assert.equal(value.width, 1)
  assert.ok(value.path.startsWith(path.join(process.cwd(), 'phone-shots')), value.path)
  const written = await readFile(value.path)
  assert.deepEqual(written, PNG)
  await rm(path.dirname(value.path), { recursive: true, force: true })
})

test('phone_tap sends rounded pixels and renders a confirmation', async () => {
  const tools = await mount()
  const tool = tools.get('phone_tap')
  const value = await tool.execute({ x: 10.6, y: 20.2 })
  assert.deepEqual(value, { ok: true })
  const last = calls.at(-1)
  assert.equal(last.path, '/tap')
  assert.deepEqual(last.body, { x: 11, y: 20 })
  assert.equal(last.authorization, `Bearer ${token}`)
  assert.match(tool.output.render({ x: 11, y: 20 }, value)[0].text, /tapped \(11, 20\)/)
})

test('phone_swipe passes the duration through', async () => {
  const tools = await mount()
  await tools.get('phone_swipe').execute({ x1: 10, y1: 20, x2: 30, y2: 40, durationMs: 500 })
  assert.deepEqual(calls.at(-1).body, { x1: 10, y1: 20, x2: 30, y2: 40, durationMs: 500 })
})

test('phone_type reports the field it wrote into', async () => {
  const tools = await mount()
  const value = await tools.get('phone_type').execute({ text: 'こんにちは' })
  assert.equal(value.focused, 'com.example:id/field')
  assert.deepEqual(calls.at(-1).body, { text: 'こんにちは' })
})

test('phone_nodes renders the tree the bridge returned', async () => {
  const tools = await mount()
  const tool = tools.get('phone_nodes')
  const value = await tool.execute({})
  assert.equal(tool.output.render({}, value)[0].text, '[Button] text="OK" bounds=10,20 100x50')
})

test('phone_apps and phone_launch use the package id', async () => {
  const tools = await mount()
  const apps = tools.get('phone_apps')
  const listed = await apps.execute({ query: '設定' })
  assert.deepEqual(listed.apps, [{ label: '設定', package: 'com.android.settings' }])
  assert.match(apps.output.render({}, listed)[0].text, /設定 \| com\.android\.settings/)
  const launched = await tools.get('phone_launch').execute({ package: 'com.android.settings' })
  assert.equal(launched.label, '設定')
  assert.deepEqual(calls.at(-1).body, { package: 'com.android.settings' })
})

test('phone_key accepts the documented keys only', async () => {
  const tools = await mount()
  const tool = tools.get('phone_key')
  for (const key of ['back', 'home', 'recents', 'enter', 'delete', 'notification', 'quick_settings', 'lock']) {
    assert.ok(tool.parameters.properties.key.enum.includes(key), key)
  }
  await tool.execute({ key: 'back' })
  assert.deepEqual(calls.at(-1).body, { key: 'back' })
})

test('a bridge refusal surfaces as a tool error with its message', async () => {
  const wrong = mountWith({ url: `http://127.0.0.1:${port}/`, token: 'nope' })
  await assert.rejects(() => wrong.get('phone_tap').execute({ x: 1, y: 2 }), /bad token/)
})

test('a missing descriptor explains how to start the host', async () => {
  const tools = mountWith({ bridgePath: path.join(workspace, 'missing', 'bridge.json') })
  await assert.rejects(
    () => tools.get('phone_tap').execute({ x: 1, y: 2 }),
    /ブリッジが見つかりません/,
  )
})
