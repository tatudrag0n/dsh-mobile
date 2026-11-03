/**
 * Build the runtime bundle the Android app installs on the phone.
 *
 * The bundle is what turns the app from a client into a Host: a Node binary
 * built for Android, the shared libraries it links against, the DSH package
 * tree, the mobile profile, and the phone plugin. The app downloads this zip
 * on first run (or reads it from a file the user picks), unpacks it into its
 * own data directory and starts `bin/node` against `app/node_modules/...`.
 *
 * Usage:
 *   node scripts/fetch-android-runtime.mjs           # one-time package cache
 *   node scripts/build-runtime.mjs --dsh <dir> [--url <download url>]
 *
 * `--dsh` points at an unpacked DSH desktop runtime (the directory that holds
 * `node_modules/@deepseek-ai/dsh`), for example the `dsh` folder inside the
 * DeepSeek Harness `app.asar`.
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { linkMap } from './lib/elf.mjs'
import { replaceCString } from './lib/patch.mjs'
import { TERMUX_ARCH, unpackRuntime } from './lib/termux.mjs'
import { zip } from './lib/zip.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

/** The version string stored in the bundle manifest. */
const VERSION = '1.1.0'

/** Directories inside a DSH runtime tree that only exist for other platforms. */
const FOREIGN = [
  '@img/sharp-win32-x64', '@img/sharp-win32-arm64', '@img/sharp-darwin-x64', '@img/sharp-darwin-arm64',
  '@koromix/koffi-win32-x64', '@koromix/koffi-win32-arm64', '@koromix/koffi-darwin-x64', '@koromix/koffi-darwin-arm64',
  'sherpa-onnx-win-x64', 'sherpa-onnx-darwin-arm64',
  'node-addon-require-builtin-win32-x64-msvc', 'node-addon-require-builtin-win32-arm64-msvc',
  'node-addon-require-builtin-darwin-x64', 'node-addon-require-builtin-darwin-arm64',
  'node-addon-require-builtin-linux-x64-gnu', 'node-addon-require-builtin-linux-arm64-gnu',
  'node-addon-require-builtin-linux-x64-musl', 'node-addon-require-builtin-linux-arm64-musl',
]

const args = parseArgs(process.argv.slice(2))

/** The Android ABI this build targets (`--abi`). */
const ABI = args.abi ?? 'arm64-v8a'
const ARCH = TERMUX_ARCH[ABI]
if (ARCH === undefined) {
  console.error(`unknown --abi: ${ABI}`)
  process.exit(2)
}

/** Where a released bundle lives unless `--url` overrides it. */
const DEFAULT_URL = `https://github.com/tatudrag0n/dsh-mobile/releases/latest/download/dsh-mobile-runtime-${ABI}.zip`

const dshTree = args.dsh ?? process.env.DSH_RUNTIME_DIR
if (dshTree === undefined || !existsSync(path.join(dshTree, 'node_modules', '@deepseek-ai', 'dsh'))) {
  console.error('usage: node scripts/build-runtime.mjs --dsh <unpacked dsh runtime dir> [--url <url>] [--out <dir>]')
  console.error('  <dir> must contain node_modules/@deepseek-ai/dsh')
  process.exit(2)
}

const outDir = path.resolve(args.out ?? path.join(repo, 'dist'))
const work = path.join(outDir, 'work', ABI)
const bundle = path.join(work, 'runtime')
rmSync(bundle, { recursive: true, force: true })
mkdirSync(bundle, { recursive: true })

console.log('1/6 Termux パッケージを展開しています…')
const unpacked = await unpackRuntime({ cacheDir: path.join(outDir, 'cache'), root: bundle, arch: ARCH })
console.log(`    ${unpacked.packages.map((entry) => `${entry.Package} ${entry.Version}`).join(', ')}`)

console.log('2/6 DSH のパッケージツリーをコピーしています…')
const appDir = path.join(bundle, 'app')
cpSync(path.join(dshTree, 'node_modules'), path.join(appDir, 'node_modules'), { recursive: true, dereference: true })
for (const name of FOREIGN) {
  rmSync(path.join(appDir, 'node_modules', name), { recursive: true, force: true })
  rmSync(path.join(appDir, 'node_modules', '@deepseek-ai', name), { recursive: true, force: true })
}
pruneNativePrebuilds(path.join(appDir, 'node_modules'))

console.log('3/6 資格情報シムとプロファイルを入れています…')
const shimTarget = path.join(
  appDir,
  'node_modules',
  `node-addon-require-builtin-android-${ABI === 'x86_64' ? 'x64' : 'arm64'}`,
)
cpSync(path.join(repo, 'runtime', 'shim', 'require-builtin'), shimTarget, { recursive: true })
cpSync(path.join(repo, 'runtime', 'plugins'), path.join(bundle, 'plugins'), { recursive: true })
cpSync(path.join(repo, 'runtime', 'profile'), path.join(bundle, 'profile'), { recursive: true })
rmSync(path.join(bundle, 'plugins', 'README.md'), { force: true })

console.log('4/6 実行ファイルを jniLibs へ配置しています…')
// Android only lets an app execute files from its native library directory:
// a binary unpacked next to the app's data is refused with EACCES. The
// executables and shared libraries therefore ship inside the APK as `lib*.so`
// and the installer restores their real names as symlinks back into it.
const binaries = new Map([
  ['node', path.join(unpacked.bin, 'node')],
  ['bash', path.join(unpacked.bin, 'bash')],
])
const libraries = new Map()
for (const name of readdirSync(unpacked.lib)) {
  if (!/^lib.*\.so/.test(name)) continue
  const file = path.join(unpacked.lib, name)
  if (existsSync(file) && statSync(file).isFile()) libraries.set(name, file)
}
const links = linkMap(binaries, libraries)

const jniDir = path.join(repo, 'android', 'app', 'src', 'main', 'jniLibs', ABI)
rmSync(jniDir, { recursive: true, force: true })
mkdirSync(jniDir, { recursive: true })
const placed = new Set()
for (const [name, file] of libraries) {
  const target = links.lib[name]
  if (placed.has(target)) continue
  placed.add(target)
  cpSync(file, path.join(jniDir, target))
}
for (const [name, file] of binaries) {
  if (name === 'bash') {
    // bash reads a system rc file compiled in as the Termux prefix, and that
    // path cannot exist inside another app: every non-interactive `bash -c`
    // printed a permission warning that would otherwise land in tool output.
    const { buffer, patched } = replaceCString(
      readFileSync(file),
      '/data/data/com.termux/files/usr/etc/bash.bashrc',
      '/dev/null',
    )
    if (!patched) console.warn('    bash のシステム rc パスが見つかりません（版が変わった可能性）')
    writeFileSync(path.join(jniDir, links.bin[name]), buffer)
    continue
  }
  cpSync(file, path.join(jniDir, links.bin[name]))
}
writeFileSync(path.join(bundle, 'libmap.json'), `${JSON.stringify(links, null, 2)}\n`)
rmSync(path.join(bundle, 'bin'), { recursive: true, force: true })
rmSync(path.join(bundle, 'lib'), { recursive: true, force: true })
console.log(`    jniLibs: ${placed.size + binaries.size} files, ${links.lib ? Object.keys(links.lib).length : 0} names`)

const dshPackage = JSON.parse(readFileSync(path.join(dshTree, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
const nodePackage = unpacked.packages.find((entry) => entry.Package === 'nodejs')
const manifest = {
  schemaVersion: 1,
  version: VERSION,
  abi: ABI,
  node: nodePackage === undefined ? 'unknown' : nodePackage.Version,
  dsh: dshPackage.version,
  builtAt: new Date().toISOString(),
}
writeFileSync(path.join(bundle, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log('5/6 zip を書いています…')
const entries = collect(bundle)
const archive = zip(entries)
const zipPath = path.join(outDir, `dsh-mobile-runtime-${ABI}.zip`)
writeFileSync(zipPath, archive)
const sha256 = createHash('sha256').update(archive).digest('hex')

console.log('6/6 マニフェストをアプリの assets に書いています…')
const releaseUrl = args.url ?? DEFAULT_URL
const assetsDir = path.join(repo, 'android', 'app', 'src', 'main', 'assets')
mkdirSync(assetsDir, { recursive: true })
const manifestFile = path.join(assetsDir, 'runtime-manifest.json')
const catalog = existsSync(manifestFile)
  ? JSON.parse(readFileSync(manifestFile, 'utf8'))
  : { version: VERSION, abis: {} }
catalog.version = VERSION
catalog.abis = catalog.abis ?? {}
catalog.abis[ABI] = { url: releaseUrl, sha256, bytes: archive.length }
writeFileSync(manifestFile, `${JSON.stringify(catalog, null, 2)}\n`)

console.log('')
console.log(`bundle : ${zipPath}`)
console.log(`bytes  : ${archive.length} (${(archive.length / 1e6).toFixed(1)} MB)`)
console.log(`sha256 : ${sha256}`)
console.log(`node   : ${manifest.node} / dsh ${manifest.dsh}`)

/**
 * Parse `--key value` pairs.
 *
 * @param {string[]} argv - The arguments after the script name.
 * @returns {Record<string, string>} The parsed options.
 */
function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    parsed[token.slice(2)] = argv[index + 1]
    index += 1
  }
  return parsed
}

/**
 * Remove native prebuilds for platforms Android never runs.
 *
 * @param {string} nodeModules - The `node_modules` root.
 * @returns {void}
 */
function pruneNativePrebuilds(nodeModules) {
  const pty = path.join(nodeModules, 'node-pty', 'prebuilds')
  if (!existsSync(pty)) return
  for (const name of readdirSync(pty)) {
    if (name !== 'android-arm64' && name !== 'linux-arm64') {
      rmSync(path.join(pty, name), { recursive: true, force: true })
    }
  }
  if (readdirSync(pty).length === 0) rmSync(path.join(nodeModules, 'node-pty', 'prebuilds'), { recursive: true, force: true })
}

/**
 * List every regular file under a directory as zip entries.
 *
 * @param {string} root - The directory to walk.
 * @returns {object[]} Entries with archive-relative names and modes.
 */
function collect(root) {
  const entries = []
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name)
      const relative = prefix === '' ? name : `${prefix}/${name}`
      const info = statSync(full)
      if (info.isDirectory()) {
        walk(full, relative)
        continue
      }
      if (!info.isFile()) continue
      const executable = relative.startsWith('bin/')
      entries.push({ name: relative, data: readFileSync(full), mode: executable ? 0o755 : 0o644 })
    }
  }
  walk(root, '')
  return entries
}

