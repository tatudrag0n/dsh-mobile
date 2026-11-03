// Exercise the app's loopback bridge the way the plugin does, from the PC.
// Usage: node scripts/probe-bridge.mjs <port> <token> [endpoint ...]
const [port, token, ...endpoints] = process.argv.slice(2)
const base = `http://127.0.0.1:${port}`
const call = async (name, body = {}) => {
  const response = await fetch(`${base}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let value
  try {
    value = JSON.parse(text)
  } catch {
    value = text
  }
  console.log(name, response.status, JSON.stringify(value).slice(0, 400))
  return value
}
for (const endpoint of endpoints.length === 0 ? ['status'] : endpoints) {
  const split = endpoint.indexOf(':')
  const name = split < 0 ? endpoint : endpoint.slice(0, split)
  const argsJson = split < 0 ? undefined : endpoint.slice(split + 1)
  await call(name, argsJson === undefined || argsJson === '' ? {} : JSON.parse(argsJson))
}
