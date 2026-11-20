/** An APK pins bytes, so its URL must never follow the moving latest release. */
export function runtimeUrl(version, abi, override) {
  const value = override ?? `https://github.com/tatudrag0n/dsh-mobile/releases/download/v${version}/dsh-mobile-runtime-${abi}.zip`
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Invalid runtime URL')
  }
  if (url.pathname.includes('/releases/latest/')) throw new Error('Runtime URLs must be immutable, not releases/latest')
  // HTTP is for local adb-reverse testing only. Release artifacts use HTTPS.
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Remote runtime downloads require HTTPS')
  }
  return url.href
}
