/**
 * Smartphone use — Host half.
 *
 * Adds tools that let the agent perceive and drive *this* phone: capture the
 * screen, read the accessibility tree, tap, swipe, type, press keys, and list
 * or launch apps. The Host process is plain Node inside the app sandbox, so
 * every platform call goes through the app's loopback bridge
 * ({@link ./bridge.js}); these tools only shape the conversation.
 *
 * Screenshots are written as PNG files inside the session working directory,
 * so the agent can look at them with the built-in `read_image` tool.
 */

import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { PhoneBridge } from './bridge.js'

/** The plugin's own name inside the cordis tree. */
export const name = 'smartphone-use'

/** The services this plugin needs before it registers its tools. */
export const inject = ['tools']

/**
 * Register the smartphone-use tools.
 *
 * @param {object} ctx - The plugin context.
 * @param {object} config - The plugin configuration.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const phone = new PhoneBridge(options)

  ctx.effect(() => ctx.tools.register(statusTool(phone)), 'smartphone-use: phone_status')
  ctx.effect(() => ctx.tools.register(screenshotTool(ctx, phone, options)), 'smartphone-use: phone_screen')
  ctx.effect(() => ctx.tools.register(nodesTool(phone)), 'smartphone-use: phone_nodes')
  ctx.effect(() => ctx.tools.register(tapTool(phone)), 'smartphone-use: phone_tap')
  ctx.effect(() => ctx.tools.register(swipeTool(phone)), 'smartphone-use: phone_swipe')
  ctx.effect(() => ctx.tools.register(typeTool(phone)), 'smartphone-use: phone_type')
  ctx.effect(() => ctx.tools.register(keyTool(phone)), 'smartphone-use: phone_key')
  ctx.effect(() => ctx.tools.register(appsTool(phone)), 'smartphone-use: phone_apps')
  ctx.effect(() => ctx.tools.register(launchTool(phone)), 'smartphone-use: phone_launch')
}

/**
 * Resolve the plugin configuration.
 *
 * @param {object} config - The configured values.
 * @returns {{ url: string|undefined, token: string|undefined, descriptorPath: string|undefined, maxWidth: number, shotDirectory: string }} The options.
 */
function resolveOptions(config) {
  const source = config ?? {}
  return {
    url: text(source.url),
    token: text(source.token),
    descriptorPath: text(source.bridgePath),
    maxWidth: Number.isFinite(source.maxWidth) && source.maxWidth > 0 ? Math.round(source.maxWidth) : 1080,
    shotDirectory: text(source.shotDirectory) ?? 'phone-shots',
  }
}

/**
 * Trim a configured string, treating blank as absent.
 *
 * @param {unknown} value - The candidate.
 * @returns {string|undefined} The trimmed value, or undefined.
 */
function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Resolve the session working directory, falling back to the process cwd.
 *
 * @param {object} ctx - The plugin context.
 * @param {object} exec - The tool execution context.
 * @returns {Promise<string>} The directory path.
 */
async function sessionCwd(ctx, exec) {
  const workingDirectory = ctx.get?.('workingDirectory')
  if (workingDirectory !== undefined && exec?.agent !== undefined) {
    try {
      return await workingDirectory.ensure(exec.agent, exec.signal)
    } catch {
      // fall through to the process directory
    }
  }
  return process.cwd()
}

/** A reusable empty parameter schema. */
const NO_ARGUMENTS = { type: 'object', additionalProperties: false, properties: {} }

/**
 * The `phone_status` tool.
 *
 * @param {PhoneBridge} phone - The bridge client.
 * @returns {object} The tool definition.
 */
function statusTool(phone) {
  return {
    name: 'phone_status',
    description: 'Report the phone the Host runs on: screen size, whether the accessibility service is on, and the Android release. Call it first when a phone tool fails, because every input tool needs the accessibility service.',
    parameters: NO_ARGUMENTS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['screenWidth', 'screenHeight'],
        properties: {
          screenWidth: { type: 'integer' },
          screenHeight: { type: 'integer' },
          accessibility: { type: 'boolean' },
          android: { type: 'string' },
          model: { type: 'string' },
        },
      },
      render(_args, value) {
        const lines = [`screen: ${value.screenWidth}x${value.screenHeight}`, `Android: ${value.android ?? '?'} ${value.model ?? ''}`]
        lines.push(
          value.accessibility === true
            ? 'accessibility service: on (tap/swipe/type/screenshot available)'
            : 'accessibility service: OFF — open DSH Mobile and enable スマホ操作の許可',
        )
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute() {
      const value = await phone.call('status')
      return {
        screenWidth: value.screenWidth,
        screenHeight: value.screenHeight,
        accessibility: value.accessibility === true,
        android: value.android,
        model: value.model,
      }
    },
  }
}

/**
 * The `phone_screen` tool.
 *
 * @param {object} ctx - The plugin context.
 * @param {PhoneBridge} phone - The bridge client.
 * @param {object} options - The plugin options.
 * @returns {object} The tool definition.
 */
function screenshotTool(ctx, phone, options) {
  return {
    name: 'phone_screen',
    description: 'Capture the phone screen to a PNG file and return its path. Follow with read_image on that path to actually see it. Coordinates used by phone_tap and phone_swipe are pixels in this screenshot.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxWidth: {
          type: 'integer',
          description: `Longest edge of the stored PNG; wider captures are downscaled. Default ${options.maxWidth}.`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['path', 'width', 'height'],
        properties: {
          path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: `screenshot ${value.width}x${value.height} -> ${value.path}\nUse read_image on that path to look at the screen.`,
        }]
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = await sessionCwd(ctx, exec)
      const directory = path.join(cwd, options.shotDirectory)
      await mkdir(directory, { recursive: true })
      const width = Number.isFinite(args?.maxWidth) && args.maxWidth > 0 ? Math.round(args.maxWidth) : options.maxWidth
      const shot = await phone.call('screen', { maxWidth: width })
      const target = path.join(directory, `phone-${Date.now()}.png`)
      if (typeof shot.path === 'string' && shot.path !== '') {
        if (shot.path === target) {
          // The app wrote straight into the workspace.
        } else {
          await copyFile(shot.path, target)
        }
      } else if (typeof shot.png === 'string') {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(target, Buffer.from(shot.png, 'base64'))
      } else {
        throw new Error('ブリッジがスクリーンショットを返しませんでした')
      }
      const size = await stat(target)
      if (size.size === 0) throw new Error(`スクリーンショットが空です: ${target}`)
      return { path: target, width: shot.width, height: shot.height }
    },
  }
}

/**
 * The `phone_nodes` tool.
 *
 * @param {PhoneBridge} phone - The bridge client.
 * @returns {object} The tool definition.
 */
function nodesTool(phone) {
  return {
    name: 'phone_nodes',
    description: 'Dump the accessibility tree of the current screen as indented text with each node\'s tap-able bounds. Prefer this over guessing coordinates from a screenshot when the target is a labelled button or text field.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxNodes: { type: 'integer', description: 'Maximum nodes to print (default 120).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['tree'],
        properties: { tree: { type: 'string' }, count: { type: 'integer' } },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.tree }]
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = Number.isFinite(args?.maxNodes) && args.maxNodes > 0 ? Math.round(args.maxNodes) : 120
      const value = await phone.call('nodes', { maxNodes: limit })
      return { tree: String(value.tree ?? ''), count: value.count ?? 0 }
    },
  }
}

/**
 * The `phone_tap` tool.
 *
 * @param {PhoneBridge} phone - The bridge client.
 * @returns {object} The tool definition.
 */
function tapTool(phone) {
  return {
    name: 'phone_tap',
    description: 'Tap a pixel coordinate on the phone screen (use the coordinates of the latest phone_screen or phone_nodes).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: {
        x: { type: 'integer', description: 'Horizontal pixel.' },
        y: { type: 'integer', description: 'Vertical pixel.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
      render(args) {
        return [{ type: 'text', text: `tapped (${args.x}, ${args.y})` }]
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      await phone.call('tap', { x: Math.round(args.x), y: Math.round(args.y) })
      return { ok: true }
    },
  }
}

/**
 * The `phone_swipe` tool.
 *
 * @param {PhoneBridge} phone - The bridge client.
 * @returns {object} The tool definition.
 */
function swipeTool(phone) {
  return {
    name: 'phone_swipe',
    description: 'Swipe from one pixel to another, optionally with a duration. Use it for scrolling lists and pulling down the shade.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['x1', 'y1', 'x2', 'y2'],
      properties: {
        x1: { type: 'integer' },
        y1: { type: 'integer' },
        x2: { type: 'integer' },
        y2: { type: 'integer' },
        durationMs: { type: 'integer', description: 'Gesture duration (default 300).' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
      render(args) {
        return [{ type: 'text', text: `swiped (${args.x1}, ${args.y1}) -> (${args.x2}, ${args.y2})` }]
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const duration = Number.isFinite(args.durationMs) && args.durationMs > 0 ? Math.round(args.durationMs) : 300
      await phone.call('swipe', {
        x1: Math.round(args.x1),
        y1: Math.round(args.y1),
        x2: Math.round(args.x2),
        y2: Math.round(args.y2),
        durationMs: duration,
      })
      return { ok: true }
    },
  }
}

/**
 * The `phone_type` tool.
 *
 * @param {PhoneBridge} phone - The bridge client.
 * @returns {object} The tool definition.
 */
function typeTool(phone) {
  return {
    name: 'phone_type',
    description: 'Type text into the focused text field. Tap the field first with phone_tap; the accessibility service needs a focused editable node to write into.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'The text to enter (replaces the field content).' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' }, focused: { type: 'string' } } },
      render(args, value) {
        return [{ type: 'text', text: `typed ${JSON.stringify(args.text)} into ${value.focused ?? 'the focused field'}` }]
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const value = await phone.call('type', { text: String(args.text ?? '') })
      return { ok: true, focused: value.focused }
    },
  }
}

/**
 * The `phone_key` tool.
 *
 * @param {PhoneBridge} phone - The bridge client.
 * @returns {object} The tool definition.
 */
function keyTool(phone) {
  const keys = ['back', 'home', 'recents', 'enter', 'delete', 'notification', 'quick_settings', 'lock']
  return {
    name: 'phone_key',
    description: `Press a system key: ${keys.join(', ')}.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: {
        key: { type: 'string', enum: keys, description: 'The key to press.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
      render(args) {
        return [{ type: 'text', text: `pressed ${args.key}` }]
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      await phone.call('key', { key: String(args.key) })
      return { ok: true }
    },
  }
}

/**
 * The `phone_apps` tool.
 *
 * @param {PhoneBridge} phone - The bridge client.
 * @returns {object} The tool definition.
 */
function appsTool(phone) {
  return {
    name: 'phone_apps',
    description: 'List the apps that can be launched, as "label | package" lines. Filter with a query to keep the list short.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Case-insensitive match on label or package.' },
        limit: { type: 'integer', description: 'Maximum rows (default 60).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['apps'],
        properties: {
          apps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['label', 'package'],
              properties: { label: { type: 'string' }, package: { type: 'string' } },
            },
          },
        },
      },
      render(_args, value) {
        if (value.apps.length === 0) return [{ type: 'text', text: 'no matching apps' }]
        return [{ type: 'text', text: value.apps.map((app) => `${app.label} | ${app.package}`).join('\n') }]
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const value = await phone.call('apps', {
        query: typeof args?.query === 'string' ? args.query : '',
        limit: Number.isFinite(args?.limit) && args.limit > 0 ? Math.round(args.limit) : 60,
      })
      return { apps: Array.isArray(value.apps) ? value.apps : [] }
    },
  }
}

/**
 * The `phone_launch` tool.
 *
 * @param {PhoneBridge} phone - The bridge client.
 * @returns {object} The tool definition.
 */
function launchTool(phone) {
  return {
    name: 'phone_launch',
    description: 'Bring an app to the foreground by package name (see phone_apps).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['package'],
      properties: {
        package: { type: 'string', description: 'The package id, e.g. com.android.settings.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' }, label: { type: 'string' } } },
      render(args, value) {
        return [{ type: 'text', text: `launched ${value.label ?? args.package}` }]
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const value = await phone.call('launch', { package: String(args.package ?? '') })
      return { ok: true, label: value.label }
    },
  }
}
