/**
 * A merge that was resolved by hand can leave a marker behind. This test walks
 * the tracked source files and fails on one, because a stray `<<<<<<<` turns
 * into a syntax error somewhere far away from where it was noticed (a Gradle
 * build file, a Java class) and the failure reads like a different problem.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '.gradle', 'jniLibs'])
const SUFFIXES = ['.js', '.mjs', '.cjs', '.java', '.gradle', '.xml', '.md', '.json', '.yml', '.yaml', '.ps1', '.sh']

test('no conflict markers are left in the tree', () => {
  const offenders = []
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      if (SKIP.has(name)) continue
      const full = path.join(directory, name)
      const info = statSync(full)
      if (info.isDirectory()) {
        walk(full)
        continue
      }
      if (!SUFFIXES.some((suffix) => name.endsWith(suffix))) continue
      const text = readFileSync(full, 'utf8')
      if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) {
        offenders.push(path.relative(repo, full))
      }
    }
  }
  walk(repo)
  assert.deepEqual(offenders, [])
})
