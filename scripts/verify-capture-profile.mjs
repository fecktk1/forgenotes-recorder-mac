import { readFile, readdir } from 'node:fs/promises'

const [html, app] = await Promise.all([
  readFile(new URL('../renderer/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../renderer/app.js', import.meta.url), 'utf8'),
])
const required = [
  [html, 'mode-room'], [html, 'system-audio-fields'],
  [app, 'room_single_mic'], [app, 'capture_profile'],
  [app, "fd.append('start_offset_ms'"], [app, "fd.append('sha256'"],
  // Recording announcement: the setting, voice picker and failure note exist, the wording
  // is intact, and it is fired from a fresh start only.
  [html, 'id="announce-recording"'], [html, 'id="announce-note"'],
  [html, 'id="announce-voice"'], [html, 'id="announce-preview"'],
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
// Capture times and stop on silence: capture-clock.js and silence.js load before app.js,
// every new session sends the recording's own start and end, the segment clock is the
// sleep-aware one, and the "Still there?" pieces are on the page.
const scriptOrder = ['capture-clock.js', 'silence.js', 'app.js'].map((name) => html.indexOf(`<script src="${name}"></script>`))
if (scriptOrder.some((at) => at < 0) || !(scriptOrder[0] < scriptOrder[2] && scriptOrder[1] < scriptOrder[2])) {
  throw new Error('index.html must load capture-clock.js and silence.js before app.js')
}
for (const token of [
  '...FnCaptureClock.createSessionTimes(meta, localId)',
  'FnCaptureClock.finalizeTimes(meta, localId, seqd)',
  'clock: FnCaptureClock.createCaptureClock(startedAt)',
  'window.desktop.onPower(onPower)',
  'window.desktop.onSilenceKeep(keepRecording)',
  'startedAt: new Date(startedAt).toISOString()',
]) {
  if (!app.includes(token)) throw new Error(`missing capture-time contract: ${token}`)
}
if (/Date\.now\(\) - rec\.startedAt/.test(app)) throw new Error('segment offsets must come from the recording clock, not the wall clock')
for (const id of ['silence-minutes', 'silence-question', 'silence-keep', 'stop-note']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`missing stop-on-silence element: #${id}`)
}

// The announcement is a pre-rendered clip, never the system speech voice.
if (/speechSynthesis/i.test(app)) {
  throw new Error('renderer/app.js must not use speechSynthesis: the announcement plays a shipped voice clip')
}

// renderer/announce/voices.json is the shipped voice list. To change the voices, edit that
// file and add or remove the matching <id>.mp3 next to it; no code changes.
const announceDir = new URL('../renderer/announce/', import.meta.url)
let voiceList
try {
  voiceList = JSON.parse(await readFile(new URL('voices.json', announceDir), 'utf8'))
} catch (e) {
  throw new Error(`renderer/announce/voices.json must exist and be valid JSON (${e.message})`)
}
const voices = Array.isArray(voiceList.voices) ? voiceList.voices : []
if (!voices.length) throw new Error('voices.json lists no voices')
const voiceIds = voices.map((v) => v && v.id)
for (const v of voices) {
  if (!v || typeof v.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v.id)) {
    throw new Error(`voices.json has a voice with a missing or unsafe id: ${JSON.stringify(v)}`)
  }
  if (typeof v.label !== 'string' || !v.label.trim()) throw new Error(`voices.json voice ${v.id} has no label`)
}
if (new Set(voiceIds).size !== voiceIds.length) throw new Error('voices.json lists a voice id more than once')
if (!voiceIds.includes(voiceList.default)) {
  throw new Error(`voices.json default "${voiceList.default}" is not one of the listed voices`)
}
if (!app.includes(`const ANNOUNCE_TEXT = '${voiceList.phrase}'`)) {
  throw new Error('voices.json "phrase" must match ANNOUNCE_TEXT in renderer/app.js (the clips say that sentence)')
}
const clips = (await readdir(announceDir)).filter((name) => name.endsWith('.mp3'))
for (const id of voiceIds) {
  if (!clips.includes(`${id}.mp3`)) throw new Error(`voices.json lists "${id}" but renderer/announce/${id}.mp3 is missing`)
}
for (const name of clips) {
  if (!voiceIds.includes(name.slice(0, -4))) {
    throw new Error(`renderer/announce/${name} is not listed in voices.json: list it or remove the file`)
  }
}
console.log(`announcement voices ok (${voiceIds.length} voices, default ${voiceList.default})`)
console.log('capture-profile contract ok')
