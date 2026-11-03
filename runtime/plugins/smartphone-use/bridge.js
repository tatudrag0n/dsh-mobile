/**
 * Client half of the smartphone-use bridge.
 *
 * The Host runs as a Node process inside the Android app's own sandbox, so it
 * cannot take a screenshot, dispatch a gesture or read the accessibility tree
 * by itself: those need the platform APIs that only the app has. The app
 * therefore listens on a loopback port and answers one JSON request per call,
 * and this module is the only place that knows the wire shape.
 *
 * The port and token are written by the app to a small JSON file next to the
 * harness home. It is re-read when it changes (the Host restarts with a new
 * port after an app restart), but not on every call.
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

/** How long one bridge call may take before it is reported as timed out. */
const TIMEOUT_MS = 60000

/**
 * A handle on the running app's bridge.
 */
export class PhoneBridge {
  /**
   * @param {object} options - Where to look for the bridge descriptor.
   * @param {string|undefined} options.descriptorPath - Explicit descriptor path.
   * @param {string|undefined} options.url - Explicit bridge URL (skips the file).
   * @param {string|undefined} options.token - Explicit token.
   */
  constructor(options) {
    this.options = options
    this.loaded = undefined
  }

  /**
   * Resolve the bridge descriptor, reusing it while the file is unchanged.
   *
   * @returns {Promise<{ url: string, token: string }>} The descriptor.
   */
  async descriptor() {
    if (this.options.url !== undefined && this.options.url !== '') {
      return { url: this.options.url, token: this.options.token ?? '' }
    }
    const file = this.options.descriptorPath ?? descriptorPath()
    let stamp
    try {
      stamp = (await stat(file)).mtimeMs
    } catch {
      throw new Error(
        `スマホのブリッジが見つかりません（${file}）。` +
          'DSH Mobile アプリでホストを起動すると作られます。',
      )
    }
    if (this.loaded !== undefined && this.loaded.stamp === stamp) return this.loaded.value
    let parsed
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      throw new Error(`スマホのブリッジ設定を読めません（${file}）: ${error.message}`)
    }
    if (typeof parsed?.url !== 'string' || parsed.url === '') {
      throw new Error(`スマホのブリッジ設定に url がありません（${file}）`)
    }
    const value = { url: parsed.url, token: typeof parsed.token === 'string' ? parsed.token : '' }
    this.loaded = { stamp, value }
    return value
  }

  /**
   * Call one bridge endpoint.
   *
   * @param {string} name - The endpoint name, e.g. `tap`.
   * @param {object} body - The JSON body.
   * @returns {Promise<any>} The decoded response.
   */
  async call(name, body = {}) {
    const { url, token } = await this.descriptor()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`ブリッジが JSON ではない応答を返しました（HTTP ${response.status}）: ${text.slice(0, 200)}`)
      }
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `ブリッジ呼び出しに失敗しました（HTTP ${response.status}）`)
      }
      return payload
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`ブリッジ呼び出しが ${TIMEOUT_MS}ms でタイムアウトしました（${name}）`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * The default descriptor location.
 *
 * The app writes it beside the harness home (`$DSH_HOME/bridge.json`), so the
 * plugin needs no configuration in the normal case: `DSH_HOME` is what the
 * launcher already passed to this process.
 *
 * @returns {string} The path.
 */
export function descriptorPath() {
  const explicit = process.env.DSH_MOBILE_BRIDGE
  if (explicit !== undefined && explicit !== '') return explicit
  const home = process.env.DSH_HOME
  if (home !== undefined && home !== '') return path.join(home, 'bridge.json')
  return path.join(process.env.HOME ?? '.', '.dsh', 'bridge.json')
}
