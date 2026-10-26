// Call-audio measurements, proven in the real engine on real recorder output.
//
// Synthesized tracks are recorded with MediaRecorder (WebM/Opus, as the app does), decoded
// back to PCM, and measured with renderer/system-audio.js:
//   * a recorded track that is silent is told apart from one that carries sound;
//   * the audio-thread level tap (renderer/level-worklet.js) sees a live track's level and
//     keeps reporting on a silent one;
//   * the echo measurement finds call audio that has leaked into the microphone track.
//
// No audio device is opened and macOS is never asked for anything: whether macOS actually
// hands over the call audio is a hardware check that needs a person (see the README).
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const scripts = { '/system-audio.js': 'system-audio.js', '/level-worklet.js': 'level-worklet.js' }
const server = http.createServer((req, res) => {
  if (scripts[req.url]) {
    res.setHeader('Content-Type', 'text/javascript')
    res.end(fs.readFileSync(path.join(__dirname, '..', 'renderer', scripts[req.url])))
    return
  }
  res.setHeader('Content-Type', 'text/html')
  res.end('<!doctype html><title>Call audio measurements</title><script src="/system-audio.js"></script>')
})

let window
const timeout = setTimeout(() => { console.error('Call-audio runtime test timed out'); app.exit(1) }, 60000)

async function inPage() {
  const SA = window.FNSystemAudio
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) throw Error('WebM audio recording unavailable')
  const context = new AudioContext()
  await context.resume()

  // Analysis rate. decodeAudioData resamples to the rate of the context it is called on.
  const RATE = 16000
  const analysis = new OfflineAudioContext(1, RATE, RATE)
  async function recordAndDecode(stream, ms) {
    const recorder = new MediaRecorder(stream, { mimeType: mime })
    const chunks = []
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    const stopped = new Promise((resolve) => { recorder.onstop = resolve })
    recorder.start(100)
    await delay(ms)
    recorder.stop()
    await stopped
    const decoded = await analysis.decodeAudioData(await new Blob(chunks, { type: mime }).arrayBuffer())
    return decoded.getChannelData(0)
  }

  // Deterministic noise, speech-like in bandwidth once low-passed.
  function noiseBuffer(seconds, seed) {
    const buffer = context.createBuffer(1, Math.round(seconds * context.sampleRate), context.sampleRate)
    const data = buffer.getChannelData(0)
    let state = seed >>> 0
    for (let i = 0; i < data.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      data[i] = 0.3 * ((state / 0xffffffff) * 2 - 1)
    }
    return buffer
  }

  // "System" track: the call. "Mic" track: the user's own voice, plus the call arriving
  // 80 ms later and 12 dB down (laptop speakers into the microphone). "Dead" track: a
  // capture that delivers frames with nothing in them.
  const call = context.createBufferSource()
  call.buffer = noiseBuffer(4, 7)
  const band = context.createBiquadFilter()
  band.type = 'lowpass'
  band.frequency.value = 3500
  call.connect(band)
  const systemOut = context.createMediaStreamDestination()
  band.connect(systemOut)

  const voice = context.createBufferSource()
  voice.buffer = noiseBuffer(4, 99)
  const voiceGain = context.createGain()
  voiceGain.gain.value = 0.15
  const micOut = context.createMediaStreamDestination()
  voice.connect(voiceGain)
  voiceGain.connect(micOut)
  const echoDelay = context.createDelay(1)
  echoDelay.delayTime.value = 0.08
  const echoGain = context.createGain()
  echoGain.gain.value = Math.pow(10, -12 / 20)
  band.connect(echoDelay)
  echoDelay.connect(echoGain)
  echoGain.connect(micOut)

  const deadOut = context.createMediaStreamDestination()
  const hush = context.createGain()
  hush.gain.value = 0
  band.connect(hush)
  hush.connect(deadOut)

  await context.audioWorklet.addModule('/level-worklet.js')
  function tap(stream) {
    const monitor = SA.createLevelMonitor()
    const node = new AudioWorkletNode(context, 'fn-level-tap', { numberOfOutputs: 0 })
    node.port.onmessage = (e) => monitor.push(e.data)
    context.createMediaStreamSource(stream).connect(node)
    return monitor
  }
  const liveLevel = tap(systemOut.stream)
  const deadLevel = tap(deadOut.stream)

  call.start()
  voice.start()
  const [systemPcm, micPcm, deadPcm] = await Promise.all([
    recordAndDecode(systemOut.stream, 2500),
    recordAndDecode(micOut.stream, 2500),
    recordAndDecode(deadOut.stream, 2500),
  ])
  call.stop()
  voice.stop()

  const summary = (pcm) => {
    const a = SA.analyzePcm(pcm)
    return { frames: a.frames, peakDb: Number.isFinite(a.peakDb) ? a.peakDb : null, silent: a.silent }
  }
  const out = {
    mime,
    system: summary(systemPcm),
    mic: summary(micPcm),
    dead: summary(deadPcm),
    liveLevel: liveLevel.snapshot(),
    deadLevel: deadLevel.snapshot(),
    echo: SA.measureEcho(micPcm, systemPcm, RATE, { maxLagMs: 250 }),
    noEcho: SA.measureEcho(deadPcm, systemPcm, RATE, { maxLagMs: 250 }),
  }
  await context.close()
  return out
}

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  await window.loadURL(`http://127.0.0.1:${server.address().port}`)
  const r = await window.webContents.executeJavaScript(`(${inPage.toString()})()`, true)

  // Silent-track detection on recorded buffers: MediaRecorder -> WebM/Opus -> decoded PCM.
  assert.ok(r.dead.frames > 16000, 'the silent track was recorded for its full length')
  assert.equal(r.dead.silent, true, `a recorded silent track is detected (peak ${r.dead.peakDb} dBFS)`)
  assert.equal(r.system.silent, false)
  assert.equal(r.mic.silent, false)
  assert.ok(r.system.peakDb > -30, `recorded call audio keeps its level (${r.system.peakDb} dBFS)`)

  // The level tap on the audio thread, as used during a recording.
  assert.equal(r.liveLevel.everHeard, true)
  assert.ok(r.liveLevel.totalMs > 1500, `live blocks ${r.liveLevel.totalMs} ms`)
  assert.equal(r.deadLevel.everHeard, false)
  assert.ok(r.deadLevel.totalMs > 1500, 'a silent track still delivers blocks, so silence is measured and not assumed')

  // Echo of the call in the microphone track, measured on the two recorded tracks.
  assert.equal(r.echo.detected, true, JSON.stringify(r.echo))
  assert.ok(Math.abs(r.echo.lagMs - 80) < 25, `echo delay ${r.echo.lagMs} ms`)
  assert.ok(Math.abs(r.echo.leakDb - -12) < 3, `echo level ${r.echo.leakDb} dB`)
  assert.equal(r.noEcho.detected, false)

  console.log(JSON.stringify({ electron: process.versions.electron, platform: process.platform, ...r }))
  clearTimeout(timeout)
  server.close()
  window.destroy()
  app.exit(0)
}).catch((error) => {
  console.error(error)
  clearTimeout(timeout)
  server.close()
  app.exit(1)
})
