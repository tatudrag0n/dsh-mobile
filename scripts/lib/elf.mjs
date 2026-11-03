/**
 * The little ELF reading the build needs.
 *
 * Android's package manager only packages `lib*.so` files out of `jniLibs`,
 * while the shared libraries termux builds are named by their SONAME
 * (`libicudata.so.78`, `libz.so.1`). The runtime therefore ships the real
 * files under legal names and the app restores the SONAME names as symlinks
 * into its native library directory. That mapping is derived here, from the
 * binaries themselves, so it cannot drift from what the loader actually asks
 * for.
 *
 * Only ELF64 little-endian is handled: every Android arm64 binary is.
 */

import { readFileSync } from 'node:fs'

const ELF_MAGIC = 0x7f454c46
const PT_LOAD = 1
const PT_DYNAMIC = 2
const DT_NULL = 0
const DT_NEEDED = 1
const DT_STRTAB = 5
const DT_STRSZ = 10
const DT_SONAME = 14

/**
 * Read the dynamic section of an ELF64 LE file.
 *
 * @param {string} file - The path.
 * @returns {{ soname: string|undefined, needed: string[] }} What the loader sees.
 */
export function dynamicInfo(file) {
  const buffer = readFileSync(file)
  if (buffer.readUInt32BE(0) !== ELF_MAGIC) throw new Error(`not an ELF file: ${file}`)
  if (buffer[4] !== 2 || buffer[5] !== 1) throw new Error(`not ELF64 little-endian: ${file}`)

  const phoff = Number(buffer.readBigUInt64LE(0x20))
  const phentsize = buffer.readUInt16LE(0x36)
  const phnum = buffer.readUInt16LE(0x38)
  const loads = []
  let dynamic
  for (let index = 0; index < phnum; index += 1) {
    const header = phoff + index * phentsize
    const type = buffer.readUInt32LE(header)
    const offset = Number(buffer.readBigUInt64LE(header + 8))
    const vaddr = Number(buffer.readBigUInt64LE(header + 16))
    const filesz = Number(buffer.readBigUInt64LE(header + 32))
    if (type === PT_LOAD) loads.push({ offset, vaddr, filesz })
    if (type === PT_DYNAMIC) dynamic = { offset, filesz }
  }
  if (dynamic === undefined) return { soname: undefined, needed: [] }

  const entries = []
  for (let cursor = dynamic.offset; cursor < dynamic.offset + dynamic.filesz; cursor += 16) {
    const tag = Number(buffer.readBigUInt64LE(cursor))
    const value = Number(buffer.readBigUInt64LE(cursor + 8))
    if (tag === DT_NULL) break
    entries.push({ tag, value })
  }

  const strtab = entries.find((entry) => entry.tag === DT_STRTAB)
  if (strtab === undefined) return { soname: undefined, needed: [] }
  const load = loads.find((segment) => strtab.value >= segment.vaddr && strtab.value < segment.vaddr + segment.filesz)
  if (load === undefined) throw new Error(`dynamic string table is not mapped: ${file}`)
  const base = load.offset + (strtab.value - load.vaddr)
  const read = (offset) => {
    let end = base + offset
    while (buffer[end] !== 0) end += 1
    return buffer.toString('latin1', base + offset, end)
  }

  return {
    soname: entries.filter((entry) => entry.tag === DT_SONAME).map((entry) => read(entry.value))[0],
    needed: entries.filter((entry) => entry.tag === DT_NEEDED).map((entry) => read(entry.value)),
  }
}

/**
 * Choose the name a library is stored under inside `jniLibs`.
 *
 * @param {string} fileName - The library's file name, e.g. `libicudata.so.78.3`.
 * @returns {string} A name Android packages, e.g. `libicudata.so`.
 */
export function jniName(fileName) {
  const base = fileName.replace(/\.so(\..*)?$/, '.so')
  return base
}

/**
 * Build the symlink map the app creates at install time.
 *
 * @param {object} files - `bin`: name to file, `lib`: file name to absolute path.
 * @param {Map<string, string>} binFiles - Executables by their runtime name.
 * @param {Map<string, string>} libFiles - Libraries by their runtime file name.
 * @returns {{ bin: Record<string, string>, lib: Record<string, string> }} SONAME to jniLibs name.
 */
export function linkMap(binFiles, libFiles) {
  const bySoname = new Map()
  const info = new Map()
  for (const [name, file] of libFiles) {
    const parsed = dynamicInfo(file)
    info.set(name, parsed)
    if (parsed.soname !== undefined) bySoname.set(parsed.soname, name)
  }

  const lib = {}
  for (const [name] of libFiles) lib[name] = jniName(name)
  // Every requested soname must resolve; prefer the library that declares it,
  // and fall back to a file whose name matches.
  const needed = new Set()
  for (const parsed of info.values()) for (const name of parsed.needed) needed.add(name)
  for (const name of needed) {
    if (lib[name] !== undefined) continue
    const provider = bySoname.get(name)
      ?? [...libFiles.keys()].find((candidate) => jniName(candidate) === jniName(name))
    if (provider === undefined) continue
    lib[name] = jniName(provider)
  }

  const bin = {}
  for (const name of binFiles.keys()) {
    bin[name] = jniName(`libdsh${name}.so`)
  }
  return { bin, lib }
}
