// Serve the built runtime bundle to the phone over adb reverse, so the app's
// own download + verify + install path is what gets exercised in testing.
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? 'C:/root/dsh-mobile/dist')
const port = Number(process.argv[3] ?? 8099)

createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\/+/, '')
  const file = path.join(root, name)
  if (!file.startsWith(root)) {
    response.writeHead(403).end()
    return
  }
  let size
  try {
    size = statSync(file).size
  } catch {
    response.writeHead(404).end('not found')
    return
  }
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': size,
  })
  createReadStream(file).pipe(response)
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`))
