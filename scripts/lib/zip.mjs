/**
 * A minimal ZIP writer.
 *
 * The runtime bundle is several hundred megabytes of JavaScript and one Node
 * binary, so it has to be compressed; Node ships `zlib` but no archive writer,
 * and pulling in an archiver package for one build step would add a dependency
 * to a project whose Android app deliberately has none. This writes the small,
 * well-specified subset the bundle needs: deflated entries with a CRC-32 and a
 * UTF-8 name, plus a central directory the platform `ZipInputStream` reads.
 */

import { deflateRawSync } from 'node:zlib'

/** CRC-32 of a buffer, using the standard IEEE polynomial. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

/**
 * Compute the CRC-32 the ZIP format stores.
 *
 * @param {Buffer} buffer - The bytes.
 * @returns {number} The checksum as an unsigned 32-bit integer.
 */
export function crc32(buffer) {
  let value = -1
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ -1) >>> 0
}

/**
 * Collect files into a ZIP archive.
 *
 * @param {object[]} entries - `{ name, data, mode }` in archive order.
 * @returns {Buffer} The archive bytes.
 */
export function zip(entries) {
  const chunks = []
  const directory = []
  let offset = 0
  const stamp = dosTime(new Date())

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const compressed = deflateRawSync(raw, { level: 9 })
    const checksum = crc32(raw)
    const mode = entry.mode ?? 0o644

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, compressed)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE((3 << 8) | 20, 4) // made by: UNIX, version 2.0
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt16LE(stamp.time, 12)
    header.writeUInt16LE(stamp.date, 14)
    header.writeUInt32LE(checksum, 16)
    header.writeUInt32LE(compressed.length, 20)
    header.writeUInt32LE(raw.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(((mode & 0o777) << 16) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    directory.push(header, name)

    offset += local.length + name.length + compressed.length
  }

  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, central, end])
}

/**
 * Convert a date into the MS-DOS time and date pair ZIP stores.
 *
 * @param {Date} date - The timestamp.
 * @returns {{ time: number, date: number }} The two 16-bit fields.
 */
function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}
