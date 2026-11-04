// Measures a saved recording: is the call-audio track silent, and how much of the call is
// also in the microphone track (echo from the speakers)?
//
//   npm run analyze:recording                      the newest recording on this Mac
//   npm run analyze:recording -- <folder>          a recording folder (Open folder in the app)
//   npm run analyze:recording -- <folder> --json   the same, as JSON
//
// Read-only: nothing is changed, uploaded or sent anywhere. It measures; it does not remove
// echo. Runs under Electron because the segments are WebM/Opus and Chromium decodes them.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('analyze-recording.cjs') && a !== '.')
const asJson = process.argv.includes('--json')
const RATE = 8000 // speech band is enough to line the two tracks up
const WINDOW_SECONDS = 20
const MAX_WINDOWS = 6

function newestRecording() {
  const support = path.join(os.homedir(), 'Library', 'Application Support')
  const roots = ['forgenotes-recorder-mac', 'ForgeNotes Recorder', 'ForgeNotes Recorder Dev'].map((name) => path.join(support, name, 'recordings'))
  let best = null
  for (const root of roots) {
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = path.join(root, entry.name, 'meta.json')
      try {
        const mtime = fs.statSync(meta).mtimeMs
        if (!best || mtime > best.mtime) best = { dir: path.join(root, entry.name), mtime }
      } catch { /* not a recording */ }
    }
  }
  return best && best.dir
}

function fail(message) {
  console.error(message)
  app.exit(1)
}

// Runs in the page. Decodes every segment, measures each, and measures echo on windows
// where a microphone segment and a call-audio segment overlap.
async function inPage(meta, rate, windowSeconds, maxWindows) {
  const SA = window.FNSystemAudio
  const context = new OfflineAudioContext(1, rate, rate)
  const tracks = {}
  const decoded = []
  for (const segment of meta.segments || []) {
    const name = `${segment.track}-${String(segment.seq).padStart(4, '0')}.webm`
    let pcm = null
    let error = null
    try {
      const response = await fetch(`/segment/${name}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      pcm = (await context.decodeAudioData(await response.arrayBuffer())).getChannelData(0)
    } catch (e) {
      error = (e && e.message) || String(e)
    }
    const t = tracks[segment.track] || (tracks[segment.track] = { segments: 0, silentSegments: 0, undecodable: 0, seconds: 0, peak: 0, squares: 0, frames: 0 })
    t.segments += 1
    if (!pcm) { t.undecodable += 1; continue }
    const a = SA.analyzePcm(pcm)
    if (a.silent) t.silentSegments += 1
    t.seconds += pcm.length / rate
    t.peak = Math.max(t.peak, a.peak)
    t.squares += a.rms * a.rms * a.frames
    t.frames += a.frames
    decoded.push({ ...segment, pcm, silent: a.silent, error })
  }
  for (const t of Object.values(tracks)) {
    t.peakDb = SA.toDb(t.peak)
    t.rmsDb = SA.toDb(t.frames ? Math.sqrt(t.squares / t.frames) : 0)
    t.silent = t.segments > 0 && t.silentSegments + t.undecodable === t.segments
    delete t.squares
  }

  const echoes = []
  const systems = decoded.filter((s) => s.track === 'system' && !s.silent)
  const mics = decoded.filter((s) => s.track === 'mic' && !s.silent)
  for (const sys of systems) {
    if (echoes.length >= maxWindows) break
    // The microphone segment that overlaps this call-audio segment the most.
    let best = null
    for (const mic of mics) {
      const start = Math.max(mic.startOffsetMs, sys.startOffsetMs)
      const end = Math.min(mic.startOffsetMs + (mic.pcm.length / rate) * 1000, sys.startOffsetMs + (sys.pcm.length / rate) * 1000)
      if (end - start > (best ? best.end - best.start : 2000)) best = { mic, start, end }
    }
    if (!best) continue
    const frames = Math.min(Math.round(((best.end - best.start) / 1000) * rate), windowSeconds * rate)
    const sysFrom = Math.round(((best.start - sys.startOffsetMs) / 1000) * rate)
    const micFrom = Math.round(((best.start - best.mic.startOffsetMs) / 1000) * rate)
    const sysPcm = sys.pcm.subarray(sysFrom, sysFrom + frames)
    const micPcm = best.mic.pcm.subarray(micFrom, micFrom + frames)
    if (SA.analyzePcm(sysPcm).silent) continue // nobody on the call spoke in this window
    echoes.push({ atMs: best.start, seconds: frames / rate, ...SA.measureEcho(micPcm, sysPcm, rate, { minLagMs: -80, maxLagMs: 500 }) })
  }
  return { tracks, echoes }
}

const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
// Decoded digital silence is not exactly zero (Opus leaves denormals around -670 dB).
const db = (value) => (Number.isFinite(value) && value > -140 ? `${value.toFixed(1)} dB` : '-inf dB')
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN
}

function report(dir, meta, result) {
  const lines = []
  lines.push(`Recording: ${dir}`)
  lines.push(`Title: ${meta.title || 'Untitled meeting'}   Length: ${clock((meta.durationSec || 0) * 1000)}   Setup: ${meta.capture_profile || 'unknown'}   Call audio path: ${meta.system_audio_path || 'not recorded in this file'}`)
  lines.push('')
  for (const [name, t] of Object.entries(result.tracks)) {
    lines.push(`${name.padEnd(7)} ${String(t.segments).padStart(3)} segment(s)  ${clock(t.seconds * 1000).padStart(6)}  peak ${db(t.peakDb)}FS  average ${db(t.rmsDb)}FS  ${t.silent ? 'SILENT' : t.silentSegments ? `${t.silentSegments} silent segment(s)` : 'has sound'}${t.undecodable ? `  (${t.undecodable} could not be decoded)` : ''}`)
  }
  lines.push('')
  const system = result.tracks.system
  if (meta.capture_profile === 'room_single_mic') lines.push('Call audio: not recorded in the room setup.')
  else if (!system) lines.push('Call audio: NO TRACK. Only the microphone was recorded.')
  else if (system.silent) lines.push('Call audio: SILENT. The track exists but carries no sound: the capture was not receiving the call.')
  else lines.push('Call audio: present.')
  if (result.tracks.mic && result.tracks.mic.silent) lines.push('Microphone: SILENT.')

  if (meta.capture_profile === 'room_single_mic') return lines.join('\n')
  lines.push('')
  if (!result.echoes.length) {
    lines.push('Echo: not measured (needs a stretch where the call-audio track has sound and the microphone track overlaps it).')
  } else {
    lines.push(`Echo of the call in the microphone track (${result.echoes.length} window(s) of up to ${WINDOW_SECONDS} s):`)
    for (const e of result.echoes) {
      lines.push(`  at ${clock(e.atMs).padStart(5)}  ${e.detected ? 'echo' : 'none'}  likeness ${e.correlation.toFixed(2)}  delay ${e.lagMs.toFixed(0)} ms  level ${db(e.leakDb)} relative to the call  ${(e.micShare * 100).toFixed(0)}% of the microphone track's energy`)
    }
    const found = result.echoes.filter((e) => e.detected)
    if (found.length) {
      lines.push(`  Typical where found: delay ${median(found.map((e) => e.lagMs)).toFixed(0)} ms, level ${db(median(found.map((e) => e.leakDb)))} relative to the call, ${(median(found.map((e) => e.micShare)) * 100).toFixed(0)}% of the microphone track.`)
      lines.push('  The microphone is picking up the call from the speakers. The transcript can show the other side twice (once per track).')
    } else {
      lines.push('  No echo found: the microphone track does not contain the call (headphones, or speakers too quiet to reach the microphone).')
    }
    lines.push('  Likeness is 0 to 1; 0.15 and above counts as echo. Level is how loud the call is in the microphone track compared with the call-audio track.')
  }
  return lines.join('\n')
}

app.whenReady().then(async () => {
  const dir = args[0] ? path.resolve(args[0]) : newestRecording()
  if (!dir) return fail('No recording found. Pass a recording folder: npm run analyze:recording -- <folder>')
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  } catch (e) {
    return fail(`Not a recording folder (no readable meta.json): ${dir}`)
  }

  const renderer = path.join(__dirname, '..', 'renderer')
  const server = http.createServer((req, res) => {
    if (req.url === '/system-audio.js') {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(fs.readFileSync(path.join(renderer, 'system-audio.js')))
    } else if (/^\/segment\/(mic|system|mixed)-\d{4}\.webm$/.test(req.url)) {
      fs.readFile(path.join(dir, req.url.slice('/segment/'.length)), (error, data) => {
        if (error) { res.statusCode = 404; res.end() } else { res.setHeader('Content-Type', 'audio/webm'); res.end(data) }
      })
    } else {
      res.setHeader('Content-Type', 'text/html')
      res.end('<!doctype html><title>Recording analysis</title><script src="/system-audio.js"></script>')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    const result = await window.webContents.executeJavaScript(
      `(${inPage.toString()})(${JSON.stringify({ segments: meta.segments || [] })}, ${RATE}, ${WINDOW_SECONDS}, ${MAX_WINDOWS})`, true)
    console.log(asJson ? JSON.stringify({ dir, title: meta.title, capture_profile: meta.capture_profile, system_audio_path: meta.system_audio_path, ...result }) : report(dir, meta, result))
    server.close()
    window.destroy()
    app.exit(0)
  } catch (error) {
    server.close()
    fail(`Could not analyze the recording: ${(error && error.message) || error}`)
  }
})
