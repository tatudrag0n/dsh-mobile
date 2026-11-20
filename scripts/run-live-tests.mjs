import { spawnSync } from 'node:child_process'

const raw = process.env.DSH_MOBILE_TEST_URL
if (!raw) {
  console.error('DSH_MOBILE_TEST_URL is required. Start an isolated DSH Host and set its URL; see docs/development.md.')
  process.exit(2)
}
let url
try { url = new URL(raw) } catch { console.error('Invalid DSH_MOBILE_TEST_URL'); process.exit(2) }
if (!['http:', 'https:'].includes(url.protocol)) process.exit(2)
const result = spawnSync(process.execPath, ['--test', 'test/routes.test.js'], { stdio: 'inherit', env: process.env })
if (result.error) console.error(result.error)
process.exit(result.status ?? 1)
