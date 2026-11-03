/**
 * The Termux package mirror, as the build needs it.
 *
 * Android has no official Node.js build. Termux publishes aarch64 builds of
 * Node, bash and the shared libraries they link against, and those are what
 * the standalone runtime bundles. This module resolves one package plus its
 * dependency closure, downloads the `.deb` files into a cache, and unpacks
 * the `bin/` and `lib/` trees out of each Debian archive.
 *
 * The archives are `ar` containers holding `data.tar.xz`; Windows cannot
 * create the symlinks the packages ship (and `libc++` is not even a legal
 * Windows file name), so those entries are skipped and the SONAMEs the loader
 * asks for are materialised as copies afterwards ({@link materializeLinks}).
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The Termux repository the packages come from. */
export const MIRROR = 'https://packages.termux.dev/apt/termux-main'

/** The only Android ABI the runtime is built for by default. */
export const ARCH = 'aarch64'

/** Termux package architectures, by Android ABI. */
export const TERMUX_ARCH = {
  'arm64-v8a': 'aarch64',
  'x86_64': 'x86_64',
}

/**
 * Packages that are part of Android itself (`libc`) or only used by Termux's
 * own tooling, not by the binaries the runtime runs.
 */
const SKIP = new Set([
  'libc', 'libcompiler-rt', 'libandroid-glob', 'libandroid-posix-semaphore',
  'libandroid-shmem', 'libandroid-sysv-semaphore', 'libandroid-utimes',
  'libexpat', 'liblzma', 'libbz2', 'libcrypt', 'libcap-ng', 'termux-tools',
  'resolv-conf', 'ca-certificates',
])

/**
 * The root packages the runtime bundles: Node itself plus a POSIX shell,
 * because DSH's bash tool runs `bash -c`.
 */
export const ROOTS = ['nodejs', 'bash']

/**
 * Read the repository index of one architecture.
 *
 * @param {string} arch - The Termux architecture, e.g. `aarch64`.
 * @returns {Promise<Map<string, object>>} Package name to its control fields.
 */
async function readIndex(arch) {
  const url = `${MIRROR}/dists/stable/main/binary-${arch}/Packages`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  const text = await response.text()
  const packages = new Map()
  for (const block of text.split(/\n\n+/)) {
    if (block.trim() === '') continue
    const fields = {}
    for (const line of block.split('\n')) {
      const match = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line)
      if (match !== null) fields[match[1]] = match[2]
    }
    if (fields.Package === undefined) continue
    const current = packages.get(fields.Package)
    if (current === undefined || compareVersions(fields.Version, current.Version) > 0) {
      packages.set(fields.Package, fields)
    }
  }
  return packages
}

/**
 * Compare two Termux version strings.
 *
 * @param {string} a - The first version.
 * @param {string} b - The second version.
 * @returns {number} Negative when `a` sorts first.
 */
function compareVersions(a, b) {
  return a.localeCompare(b, 'en', { numeric: true })
}

/**
 * Parse a `Depends:` field into plain package names.
 *
 * @param {string|undefined} field - The raw field.
 * @returns {string[]} The dependencies, first alternative only.
 */
function dependenciesOf(field) {
  if (field === undefined) return []
  return field
    .split(',')
    .map((entry) => entry.split('|')[0].trim())
    .map((entry) => entry.replace(/\(.*?\)/g, '').trim())
    .filter((entry) => entry !== '' && !entry.includes(':'))
}

/**
 * Resolve the dependency closure of the root packages.
 *
 * @param {Map<string, object>} index - The repository index.
 * @param {string[]} roots - The packages to start from.
 * @returns {object[]} The packages to fetch, in a stable order.
 */
export function resolveClosure(index, roots) {
  const wanted = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()
    if (wanted.has(name) || SKIP.has(name)) continue
    const entry = index.get(name)
    if (entry === undefined) throw new Error(`Termux に ${name} が見つかりません`)
    wanted.add(name)
    for (const dependency of dependenciesOf(entry.Depends)) queue.push(dependency)
  }
  return [...wanted].sort().map((name) => index.get(name))
}

/**
 * Download and unpack the runtime packages.
 *
 * @param {object} options - Where to put the result.
 * @param {string} options.cacheDir - Directory for the `.deb` cache.
 * @param {string} options.root - Directory the `bin/` and `lib/` trees go into.
 * @returns {Promise<{ packages: object[], bin: string, lib: string }>} What was unpacked, and where.
 */
export async function unpackRuntime(options) {
  const arch = options.arch ?? ARCH
  const index = await readIndex(arch)
  const packages = resolveClosure(index, ROOTS)
  const debDir = path.join(options.cacheDir, 'deb')
  mkdirSync(debDir, { recursive: true })
  const binDir = path.join(options.root, 'bin')
  const libDir = path.join(options.root, 'lib')
  rmSync(binDir, { recursive: true, force: true })
  rmSync(libDir, { recursive: true, force: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(libDir, { recursive: true })

  for (const entry of packages) {
    if (entry.Architecture !== arch) continue
    const file = path.join(debDir, entry.Filename.split('/').pop().replace(':', '%3a'))
    await download(`${MIRROR}/${entry.Filename.replace(':', '%3a')}`, file)
    const dataMember = listAr(file).find((member) => member.name.startsWith('data.tar'))
    if (dataMember === undefined) throw new Error(`data.tar がありません: ${file}`)
    const tarPath = path.join(debDir, `${entry.Package}.tar`)
    extractArMember(file, dataMember.name, tarPath)
    untar(tarPath, libDir, binDir)
  }

  materializeLinks(debDir, libDir)
  return { packages, bin: binDir, lib: libDir }
}

/**
 * Fetch a file unless the cache already has it.
 *
 * @param {string} url - The source.
 * @param {string} file - The destination.
 * @returns {Promise<void>} A promise that resolves once the file is cached.
 */
async function download(url, file) {
  if (existsSync(file) && statSync(file).size > 0) return
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  writeFileSync(file, Buffer.from(await response.arrayBuffer()))
}

/**
 * List the members of a Debian `ar` archive.
 *
 * @param {string} file - The archive path.
 * @returns {object[]} Members with name, offset and size.
 */
function listAr(file) {
  const buffer = readFileSync(file)
  if (buffer.subarray(0, 8).toString('latin1') !== '!<arch>\n') throw new Error(`ar ではありません: ${file}`)
  const members = []
  let offset = 8
  while (offset + 60 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 60).toString('latin1')
    const name = header.slice(0, 16).trim().replace(/\/$/, '')
    const size = Number(header.slice(48, 58).trim())
    members.push({ name, start: offset + 60, size })
    offset += 60 + size + (size % 2)
  }
  return members
}

/**
 * Write one member of an `ar` archive to a file.
 *
 * @param {string} file - The archive path.
 * @param {string} member - The member name.
 * @param {string} target - The destination path.
 * @returns {void}
 */
function extractArMember(file, member, target) {
  const buffer = readFileSync(file)
  const found = listAr(file).find((entry) => entry.name === member)
  if (found === undefined) throw new Error(`${member} がありません: ${file}`)
  writeFileSync(target, buffer.subarray(found.start, found.start + found.size))
}

/**
 * Unpack a package's `data.tar`, keeping only the runtime trees.
 *
 * `--include` in bsdtar makes a pattern required, so this excludes instead:
 * headers, docs, man pages and cmake scaffolding are the bulk of what a
 * package ships and none of it is needed to execute a binary.
 *
 * @param {string} tarPath - The tar file.
 * @param {string} libDir - Where `lib/` goes.
 * @param {string} binDir - Where `bin/` goes.
 * @returns {void}
 */
function untar(tarPath, libDir, binDir) {
  const staging = path.join(path.dirname(tarPath), 'staging')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    execFileSync('tar', [
      '-xf', tarPath, '-C', staging, '--strip-components=4',
      '--exclude=*/usr/include/*', '--exclude=*/usr/share/doc/*',
      '--exclude=*/usr/share/man/*', '--exclude=*/usr/share/cmake*',
      '--exclude=*/usr/lib/cmake/*', '--exclude=*/usr/lib/pkgconfig/*',
      '--exclude=*/usr/share/aclocal*', '--exclude=*/usr/share/icu*',
      '--exclude=*/usr/lib/icu/*',
    ], { stdio: 'ignore' })
  } catch {
    // Symlinks and a few doc paths cannot be created on Windows; the files
    // that matter (`bin/`, versioned `lib/*.so*`) are regular files and are
    // already unpacked.
  }
  moveTree(path.join(staging, 'files', 'usr', 'bin'), binDir)
  moveTree(path.join(staging, 'files', 'usr', 'lib'), libDir)
  rmSync(staging, { recursive: true, force: true })
}

/**
 * Move every regular file from one directory into another.
 *
 * @param {string} from - The staging directory.
 * @param {string} to - The destination.
 * @returns {void}
 */
function moveTree(from, to) {
  if (!existsSync(from)) return
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const source = path.join(from, name)
    if (!statSync(source).isFile()) continue
    copyFileSync(source, path.join(to, name))
  }
}

/**
 * Recreate the SONAME links Windows cannot hold, as copies.
 *
 * @param {string} debDir - Where the extracted `data.tar` files live.
 * @param {string} libDir - The runtime `lib/` directory.
 * @returns {void}
 */
export function materializeLinks(debDir, libDir) {
  const links = new Map()
  for (const file of readdirSync(debDir).filter((name) => name.endsWith('.tar'))) {
    let listing = ''
    try {
      listing = execFileSync('tar', ['-tvf', path.join(debDir, file)], { encoding: 'utf8' })
    } catch (error) {
      listing = String(error.stdout ?? '')
    }
    for (const line of listing.split('\n')) {
      if (!line.startsWith('l')) continue
      const arrow = line.indexOf(' -> ')
      if (arrow < 0) continue
      const left = line.slice(0, arrow).trim()
      const linkPath = left.slice(left.lastIndexOf(' ') + 1)
      const target = line.slice(arrow + 4).trim()
      links.set(linkPath.replace(/^\.\//, ''), target)
    }
  }
  const prefix = 'data/data/com.termux/files/'
  for (const [linkPath, target] of links) {
    if (!linkPath.startsWith(`${prefix}usr/lib/`)) continue
    const relative = linkPath.slice(prefix.length)
    const destination = path.join(libDir, path.basename(relative))
    if (existsSync(destination)) continue
    let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target))
    for (let hops = 0; hops < 5 && links.has(prefix + resolved); hops += 1) {
      resolved = path.posix.normalize(path.posix.join(path.posix.dirname(resolved), links.get(prefix + resolved)))
    }
    const source = path.join(libDir, path.basename(resolved))
    if (!existsSync(source) || statSync(source).isDirectory()) continue
    copyFileSync(source, destination)
  }
}
