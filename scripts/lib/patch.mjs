/**
 * In-place string surgery for binaries built for a fixed prefix.
 *
 * Termux's packages are compiled with `/data/data/com.termux/files/usr` baked
 * into them. When the same binary runs from an app's own storage that path does
 * not exist, and bash, for one, complains on every non-interactive start:
 *
 *   /data/data/com.termux/files/usr/etc/bash.bashrc: Permission denied
 *
 * The harness tool that runs `bash -c ...` captures stderr, so the noise would
 * end up in every command's output. Replacing the string with a shorter one -
 * `/dev/null` - keeps the binary's layout intact (the replacement is NUL-padded
 * and never longer) and makes bash source nothing instead of failing to open a
 * file.
 */

/**
 * Replace the first occurrence of a NUL-terminated C string.
 *
 * @param {Buffer} buffer - The binary.
 * @param {string} from - The string to look for, without its terminator.
 * @param {string} to - The replacement; must not be longer than `from`.
 * @returns {{ buffer: Buffer, patched: boolean }} The bytes, and whether a
 *           replacement happened.
 */
export function replaceCString(buffer, from, to) {
  const needle = Buffer.from(`${from}\0`, 'latin1')
  const offset = buffer.indexOf(needle)
  if (offset < 0) return { buffer, patched: false }
  if (Buffer.byteLength(to, 'latin1') > Buffer.byteLength(from, 'latin1')) {
    throw new Error(`replacement is longer than the original: ${to}`)
  }
  const copy = Buffer.from(buffer)
  copy.fill(0, offset, offset + needle.length)
  copy.write(to, offset, 'latin1')
  return { buffer: copy, patched: true }
}
