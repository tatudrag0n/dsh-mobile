/**
 * Lay a built runtime's executables out by name, outside the app.
 *
 * The app restores `bin/node`, `bin/bash` and the versioned `lib*.so` names as
 * symlinks into the APK's native library directory. This does the same thing
 * with copies, so a bundle can be smoke-tested over adb without installing:
 *
 *   node scripts/stage-abi.mjs arm64-v8a
 *   adb push dist/smoke/arm64-v8a /data/local/tmp/dsh
 *   adb shell 'cd /data/local/tmp/dsh && chmod 755 bin/* && \
 *     OPENSSL_CONF=/dev/null LD_LIBRARY_PATH=$PWD/lib ./bin/node --version'
 */

import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const abi = process.argv[2] ?? 'arm64-v8a'
const bundle = path.join(repo, 'dist', 'work', abi, 'runtime')
const jni = path.join(repo, 'android', 'app', 'src', 'main', 'jniLibs', abi)
const stage = path.join(repo, 'dist', 'smoke', abi)

rmSync(stage, { recursive: true, force: true })
mkdirSync(path.join(stage, 'lib'), { recursive: true })
mkdirSync(path.join(stage, 'bin'), { recursive: true })

const links = JSON.parse(readFileSync(path.join(bundle, 'libmap.json'), 'utf8'))
for (const [name, packaged] of Object.entries(links.lib)) {
  cpSync(path.join(jni, packaged), path.join(stage, 'lib', name))
}
for (const [name, packaged] of Object.entries(links.bin)) {
  cpSync(path.join(jni, packaged), path.join(stage, 'bin', name))
}
console.log(`staged ${Object.keys(links.lib).length} names in ${stage}`)
