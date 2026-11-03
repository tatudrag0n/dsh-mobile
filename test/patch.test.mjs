/**
 * The binary string patch the runtime build applies to bash.
 *
 * The interesting property is not "it replaces text": it is that the length
 * never changes, because the surrounding offsets in a compiled binary are
 * fixed. These tests pin that down.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { replaceCString } from '../scripts/lib/patch.mjs'

test('replaces a NUL-terminated string without moving anything', () => {
  const original = Buffer.from('aa\0/path/to/rc\0bb\0', 'latin1')
  const { buffer, patched } = replaceCString(original, '/path/to/rc', '/dev/null')
  assert.equal(patched, true)
  assert.equal(buffer.length, original.length)
  assert.equal(buffer.toString('latin1'), 'aa\0/dev/null\0\0\0bb\0')
})

test('reports a miss instead of corrupting the binary', () => {
  const original = Buffer.from('aa\0other\0', 'latin1')
  const { buffer, patched } = replaceCString(original, '/path/to/rc', '/dev/null')
  assert.equal(patched, false)
  assert.deepEqual(buffer, original)
})

test('refuses a replacement that would not fit', () => {
  const original = Buffer.from('aa\0short\0', 'latin1')
  assert.throws(
    () => replaceCString(original, 'short', '/a/longer/replacement'),
    /longer than the original/,
  )
})
