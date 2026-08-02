import { readFile } from 'node:fs/promises'

const [html, app] = await Promise.all([
  readFile(new URL('../renderer/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../renderer/app.js', import.meta.url), 'utf8'),
])
const required = [
  [html, 'mode-room'], [html, 'system-audio-fields'],
  [app, 'room_single_mic'], [app, 'capture_profile'],
  [app, "fd.append('start_offset_ms'"], [app, "fd.append('sha256'"],
]
for (const [source, token] of required) {
  if (!source.includes(token)) throw new Error(`missing recorder contract: ${token}`)
}
if (!app.includes("profile === 'remote_dual_track' && $('system-source')")) {
  throw new Error('room mode must disable macOS system capture')
}
console.log('capture-profile contract ok')
