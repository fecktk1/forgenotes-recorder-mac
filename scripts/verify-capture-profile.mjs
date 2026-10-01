import { readFile } from 'node:fs/promises'

const [html, app] = await Promise.all([
  readFile(new URL('../renderer/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../renderer/app.js', import.meta.url), 'utf8'),
])
const required = [
  [html, 'mode-room'], [html, 'system-audio-fields'],
  [app, 'room_single_mic'], [app, 'capture_profile'],
  [app, "fd.append('start_offset_ms'"], [app, "fd.append('sha256'"],
  // Spoken recording notice: the setting exists, the exact wording is intact, and it is
  // fired from a fresh start only.
  [html, 'id="announce-recording"'], [html, 'id="announce-note"'],
  [app, "const ANNOUNCE_TEXT = 'This meeting is being recorded.'"],
  [app, 'if (announceEnabled()) void announceRecording(rec)'],
]
for (const [source, token] of required) {
  if (!source.includes(token)) throw new Error(`missing recorder contract: ${token}`)
}
if (!app.includes("profile === 'remote_dual_track' && $('system-source')")) {
  throw new Error('room mode must disable macOS system capture')
}
if (app.split('announceRecording(').length !== 3) {
  throw new Error('the recording announcement must be fired from exactly one place (a fresh start)')
}
console.log('capture-profile contract ok')
