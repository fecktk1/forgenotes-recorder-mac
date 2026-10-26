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
// Room mode records no call audio, whichever way this Mac would capture it.
if (!app.includes("const systemPath = profile === 'remote_dual_track' ? systemAudioChoice().path : 'none'")) {
  throw new Error('room mode must disable macOS system capture')
}
// Call audio: both paths have their controls, and the native one is audio only.
for (const token of ['id="native-audio-fields"', 'id="blackhole-fields"', 'id="system-audio-pref"', 'id="native-audio-allow"', 'id="capture-note"']) {
  if (!html.includes(token)) throw new Error(`missing recorder contract: ${token}`)
}
if (!app.includes('getDisplayMedia({ audio: { ...RAW_AUDIO }, video: false })')) {
  throw new Error('native call audio must be requested as audio only (no screen capture)')
}
if (app.split('announceRecording(').length !== 3) {
  throw new Error('the recording announcement must be fired from exactly one place (a fresh start)')
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
