// Drives the real recorder window (main.js, preload.js, renderer/) through both call-audio
// paths with stand-in capture streams, and checks what the user is shown and what is saved.
//
//   electron scripts/test-recorder-ui.cjs               a Mac that records call audio natively
//   electron scripts/test-recorder-ui.cjs --old-macos   a Mac that needs BlackHole (macOS 13)
//
// Nothing real is captured: the microphone is Chromium's fake device, and the page's
// getDisplayMedia / BlackHole input are replaced by synthesized streams, so macOS is never
// asked for anything and no permission window can appear. What this cannot show is whether
// macOS hands over real call audio: that needs a person (README, "Testing call audio").
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const OLD_MACOS = process.argv.includes('--old-macos')
// main.js honours this in an unpackaged run, so the result does not depend on the host.
process.env.FORGENOTES_FAKE_MACOS_VERSION = OLD_MACOS ? '13.6.9' : '15.5'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'forgenotes-ui-test-'))
app.setPath('userData', userData)
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (app.dock) app.dock.hide()
app.on('browser-window-created', (_event, window) => {
  window.hide()
  window.webContents.setBackgroundThrottling(false)
})

// Windows are destroyed before exiting: app.exit() with a live window has been seen to
// leave the process hanging on a busy Mac.
function finish(code) {
  clearTimeout(timeout)
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.exit(code)
}
const timeout = setTimeout(() => { console.error('Recorder UI test timed out'); finish(1) }, 240000)

// The temporary profile is removed as the process exits, after Chromium has stopped writing
// to it, and a failure to remove it must never fail or hang the run.
// FORGENOTES_KEEP_TEST_DATA=1 leaves the test's recordings on disk (and prints where), for
// example to try scripts/analyze-recording.cjs on them.
process.on('exit', () => {
  if (process.env.FORGENOTES_KEEP_TEST_DATA) {
    console.log(`test data kept in ${userData}`)
    return
  }
  if (!path.basename(userData).startsWith('forgenotes-ui-test-')) return
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // left for the system's temporary-file cleanup
  }
})

// The app itself, started the way Electron starts it: before the app is ready.
require('../main.js')

// Runs in the page before the recorder view is opened.
function installStandIns() {
  const context = new AudioContext()
  const fake = { mode: 'tone', displayCalls: 0, displayConstraints: [], inputs: [], tracks: [], releases: [] }
  window.__fake = fake
  function synthesized(mode) {
    const destination = context.createMediaStreamDestination()
    const oscillator = context.createOscillator()
    oscillator.frequency.value = 330
    const gain = context.createGain()
    gain.gain.value = mode === 'tone' ? 0.2 : 0 // otherwise frames with nothing in them
    oscillator.connect(gain)
    gain.connect(destination)
    oscillator.start()
    const track = destination.stream.getAudioTracks()[0]
    const opened = performance.now()
    // 'unanswered': live, but macOS has delivered no frames (its window is still open).
    Object.defineProperty(track, 'stats', {
      configurable: true,
      get: () => ({ deliveredFrames: mode === 'unanswered' ? 0 : Math.round((performance.now() - opened) * 48) }),
    })
    if (mode === 'dead') track.stop() // macOS refused: the track arrives ended, with no error
    fake.tracks.push(track)
    return destination.stream
  }
  navigator.mediaDevices.getDisplayMedia = (constraints) => {
    fake.displayCalls += 1
    fake.displayConstraints.push(JSON.parse(JSON.stringify(constraints)))
    // 'pending': the macOS permission window is open. The request neither resolves nor
    // rejects until the test answers it with __fake.releases[n](mode).
    if (fake.mode === 'pending') return new Promise((resolve) => { fake.releases.push((mode) => resolve(synthesized(mode))) })
    return Promise.resolve(synthesized(fake.mode))
  }
  const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = (constraints) => {
    const exact = constraints && constraints.audio && constraints.audio.deviceId && constraints.audio.deviceId.exact
    fake.inputs.push(exact || 'default')
    if (exact === 'bh') return Promise.resolve(synthesized('tone'))
    return realGetUserMedia(constraints)
  }
  const realEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
  navigator.mediaDevices.enumerateDevices = async () => [
    ...(await realEnumerate()),
    { kind: 'audioinput', deviceId: 'bh', groupId: 'bh', label: 'BlackHole 2ch (Virtual)' },
  ]
  try { localStorage.setItem('fn_live_captions', 'off') } catch { /* captions would download a model */ }
  return true
}

app.whenReady().then(async () => {
  const started = Date.now()
  let window = null
  while (!window && Date.now() - started < 10000) {
    window = BrowserWindow.getAllWindows()[0] || null
    if (!window) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(window, 'the recorder window opened')
  if (window.webContents.isLoading()) await new Promise((resolve) => window.webContents.once('did-finish-load', resolve))

  const js = (code) => window.webContents.executeJavaScript(code, true)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  async function until(what, code, ms = 15000) {
    const deadline = Date.now() + ms
    let last
    while (Date.now() < deadline) {
      last = await js(`(() => { try { return ${code} } catch (e) { return false } })()`)
      if (last) return last
      await sleep(100)
    }
    throw new Error(`timed out waiting for: ${what}`)
  }
  const visible = (id) => js(`!document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`)
  const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).textContent.replace(/\\s+/g, ' ').trim()`)
  const row = (id) => js(`(() => { const r = document.getElementById('pf-${id}'); return r ? { state: r.className.replace('pf-row', '').trim(), label: r.querySelector('.pf-label').textContent, detail: r.querySelector('.pf-detail').textContent } : null })()`)
  const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`)
  const fake = () => js('JSON.parse(JSON.stringify({ mode: __fake.mode, displayCalls: __fake.displayCalls, displayConstraints: __fake.displayConstraints, inputs: __fake.inputs }))')
  const setMode = (mode) => js(`__fake.mode = ${JSON.stringify(mode)}`)
  const log = () => { try { return fs.readFileSync(path.join(userData, 'upload-log.txt'), 'utf8') } catch { return '' } }
  // Presses Start and returns how long the microphone took to be recording. Native call
  // audio is attached after that; the second wait is for that attempt to be over.
  async function start() {
    const pressed = Date.now()
    await click('start-btn')
    await until('recording to start', `rec && rec.mic && !document.getElementById('rec-indicator').classList.contains('hidden')`)
    const took = Date.now() - pressed
    await until('the call-audio attempt', `!rec.systemOpening`)
    return took
  }
  // Stops the running recording and returns what was saved for it (its meta.json).
  async function stop() {
    const localId = await js('`rec_${rec.startedAt}`')
    await click('stop-btn')
    await until('recording to be saved', `!rec && /Saved on this device/.test(document.getElementById('status').textContent)`)
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'recordings', localId, 'meta.json'), 'utf8'))
    assert.equal(saved.state, 'saved')
    return saved
  }
  const steps = []
  const step = (name) => { steps.push(name); console.log(`  ok  ${name}`) }

  await until('the sign-in view', `!document.getElementById('login-view').classList.contains('hidden')`)
  await js(`(${installStandIns.toString()})()`)
  await click('local-record-btn')
  await until('the device check', `document.getElementById('pf-system') && !/Checking/.test(document.getElementById('pf-system').textContent) && document.getElementById('pf-disk') && !/Checking/.test(document.getElementById('pf-disk').textContent)`)

  if (OLD_MACOS) {
    // ---------------------------------------------------------------- macOS 12.0 to 14.1
    assert.equal(await visible('blackhole-fields'), true)
    assert.equal(await visible('native-audio-fields'), false)
    assert.equal(await visible('system-audio-pref-row'), false, 'no choice is offered where macOS cannot do it')
    assert.match(await text('first-run-audio'), /BlackHole/)
    assert.match(await text('first-run-audio'), /14\.2/)
    assert.match(await text('mode-hint'), /BlackHole/)
    assert.equal(await js(`document.getElementById('system-source').value`), 'bh', 'BlackHole is selected automatically')
    assert.match((await row('system')).detail, /BlackHole 2ch/)
    step('macOS 13: BlackHole controls and instructions are shown, native capture is not offered')

    await start()
    assert.equal(await js('rec.systemPath'), 'blackhole')
    await until('call audio to be heard', `rec.health.system === 'ok'`)
    assert.match(await text('cap-system'), /capturing/)
    const saved = await stop()
    const calls = await fake()
    assert.equal(calls.displayCalls, 0, 'native capture is never requested on macOS 13')
    assert.ok(calls.inputs.includes('bh'))
    assert.equal(saved.system_audio_path, 'blackhole')
    assert.deepEqual([...saved.tracks].sort(), ['mic', 'system'])
    assert.doesNotMatch(log(), /capture request answered with native loopback/)
    step('macOS 13: a recording uses the BlackHole input for call audio and nothing else')
  } else {
    // ---------------------------------------------------------------- macOS 14.2 and later
    assert.equal(await visible('native-audio-fields'), true)
    assert.equal(await visible('blackhole-fields'), false, 'no driver instructions on a Mac that does not need one')
    assert.equal(await visible('system-audio-pref-row'), true)
    assert.match(await text('first-run-audio'), /nothing to install/)
    assert.doesNotMatch(await text('mode-hint'), /BlackHole/i)
    let system = await row('system')
    assert.equal(system.state, 'warn')
    assert.match(system.detail, /Allow call audio/)
    assert.doesNotMatch(system.detail, /BlackHole|driver/i)
    assert.equal(await visible('native-audio-allow'), true)
    assert.equal((await fake()).displayCalls, 0, 'the macOS window is never raised by the device check')
    step('first run: the device check explains the one step and does not ask macOS by itself')

    // The user clicks Allow call audio. macOS shows its window; the app waits, and says so.
    await setMode('pending')
    await click('native-audio-allow')
    await until('the waiting state', `/Waiting for your answer/.test(document.getElementById('pf-system').textContent)`)
    assert.equal(await visible('native-audio-allow'), false)
    assert.equal(await js(`localStorage.getItem('fn_native_audio_asked')`), null)
    // ... and the user chooses Don't Allow.
    await js(`__fake.releases[0]('dead')`)
    await until('the refusal', `document.getElementById('pf-system').className.includes('fail')`)
    system = await row('system')
    assert.match(system.detail, /System Audio Recording Only/)
    assert.match(system.detail, /Re-check/)
    assert.equal(await visible('native-audio-allow'), false)
    assert.equal(await visible('native-audio-settings'), true)
    assert.equal(await js(`localStorage.getItem('fn_native_audio_asked')`), '1')
    let calls = await fake()
    assert.equal(calls.displayCalls, 1)
    assert.equal(calls.displayConstraints[0].video, false, 'audio only: no screen capture is requested')
    assert.deepEqual(calls.displayConstraints[0].audio, { echoCancellation: false, noiseSuppression: false, autoGainControl: false })
    step('permission refused: detected from the ended track, with the exact place to turn it on')

    // Turned on in System Settings, then Re-check.
    await setMode('tone')
    await click('preflight-btn')
    await until('the ready state', `document.getElementById('pf-system').className.includes('ok')`)
    assert.match((await row('system')).detail, /Ready/)
    assert.equal(await visible('native-audio-settings'), false)
    step('permission given: the device check says call audio is ready')

    // A normal recording.
    await start()
    assert.equal(await js('rec.systemPath'), 'native')
    await until('call audio to be heard', `rec.health.system === 'ok' && rec.health.mic === 'ok'`)
    assert.match(await text('cap-system'), /capturing/)
    assert.equal(await visible('capture-note'), false)
    assert.ok(!(await fake()).inputs.includes('bh'), 'BlackHole is installed and selected in the hidden list, and still not opened')
    assert.equal(await js(`document.getElementById('system-audio-pref').disabled`), true)
    step('recording: native call audio and microphone both carry sound; BlackHole is not opened')

    // The call-audio track ends (sound output changed and the tap could not follow, or the
    // audio service restarted).
    const displayBefore = (await fake()).displayCalls
    await js(`__fake.tracks.at(-1).stop()`)
    await until('call audio to be reopened', `__fake.displayCalls > ${displayBefore} && rec.systemStream.getAudioTracks()[0].readyState === 'live' && rec.health.system === 'ok' && !rec.reacquiring.system`)
    assert.match(await text('cap-system'), /capturing/)
    step('call audio ended mid-recording: reopened, recording continues')

    // The microphone ends (headset switched off).
    await js(`rec.micStream.getAudioTracks()[0].stop()`)
    await until('the microphone to be reopened', `rec.micStream.getAudioTracks()[0].readyState === 'live' && rec.health.mic === 'ok' && !rec.reacquiring.mic`)
    step('microphone ended mid-recording: reopened, recording continues')

    await sleep(1200)
    let saved = await stop()
    assert.equal(saved.system_audio_path, 'native')
    assert.deepEqual([...saved.tracks].sort(), ['mic', 'system'])
    const count = (meta, track) => meta.segments.filter((s) => s.track === track).length
    assert.ok(count(saved, 'system') >= 2, 'the reopened call audio is a new segment')
    assert.ok(count(saved, 'mic') >= 2, 'the reopened microphone is a new segment')
    for (const track of ['mic', 'system']) {
      const segments = saved.segments.filter((s) => s.track === track).sort((a, b) => a.seq - b.seq)
      for (let i = 1; i < segments.length; i++) assert.ok(segments[i].startOffsetMs >= segments[i - 1].startOffsetMs + segments[i - 1].durationMs - 50, 'segments keep their place in time')
    }
    assert.equal(await visible('capture-note'), false)
    assert.match(log(), /capture: system reopened on attempt/)
    assert.match(log(), /capture: mic reopened on attempt/)
    assert.equal(await js(`document.getElementById('system-audio-pref').disabled`), false)
    step('saved: both tracks, in order, with the gaps kept')

    // Permission was reset since the last check, so macOS shows its window at Start. The
    // recording must not wait for it: the microphone starts, and call audio joins when the
    // window is answered.
    await setMode('pending')
    const micStartedIn = await start()
    assert.ok(micStartedIn < 2500, `the microphone is recording at once (${micStartedIn} ms), whatever macOS is doing`)
    assert.equal(await js('rec.systemStream'), null)
    assert.match(await text('cap-system'), /NOT captured/)
    assert.match(await text('capture-note'), /Only your microphone is being recorded so far/)
    assert.match(await text('capture-note'), /Call audio joins this recording/)
    await until('the microphone to be heard', `rec.health.mic === 'ok'`)
    await js(`__fake.releases.at(-1)('tone')`)
    await until('late call audio to join', `rec.systemStream && rec.systemStream.getAudioTracks()[0].readyState === 'live' && rec.health.system === 'ok'`)
    assert.match(await text('cap-system'), /capturing/)
    assert.equal(await visible('capture-note'), false)
    saved = await stop()
    assert.deepEqual([...saved.tracks].sort(), ['mic', 'system'])
    assert.ok(saved.segments.find((s) => s.track === 'system').startOffsetMs >= 3500, 'late call audio keeps its true start time')
    assert.match(log(), /macOS handed call audio over late/)
    step('macOS window at Start: microphone recorded at once, call audio joins when it is answered')

    // First Start on a Mac that was never asked, and the window is ignored. The wait is
    // bounded (shortened here), the recording is microphone only, and it says why.
    await js(`localStorage.removeItem('fn_native_audio_asked'); NATIVE_WAIT.answerMs = 1500`)
    await setMode('pending')
    await click('preflight-btn')
    await until('the one-step-left state', `/Allow call audio/.test(document.getElementById('pf-system').textContent)`)
    const callsBeforeIgnored = (await fake()).displayCalls
    await start()
    assert.equal(await js('rec.systemStream'), null)
    assert.match(await text('capture-note'), /Only your microphone is being recorded so far/)
    assert.equal((await fake()).displayCalls, callsBeforeIgnored + 1, 'macOS is asked once, not again under the running microphone')
    await sleep(1200)
    saved = await stop()
    assert.deepEqual(saved.tracks, ['mic'])
    assert.match(await text('capture-note'), /This recording has no call audio/)
    // The window is answered after the recording: the device check turns ready by itself.
    await js(`__fake.releases.at(-1)('tone')`)
    await until('the late answer', `document.getElementById('pf-system').className.includes('ok') && localStorage.getItem('fn_native_audio_asked') === '1'`)
    await js(`NATIVE_WAIT.answerMs = 70000`)
    step('macOS window ignored at first Start: bounded wait, microphone-only recording, late answer accepted')

    // A request macOS never answers is abandoned, and the next one asks afresh.
    await setMode('pending')
    await click('preflight-btn')
    await until('the unanswered state', `/has not confirmed call audio/.test(document.getElementById('pf-system').textContent)`)
    const stale = (await fake()).displayCalls
    await click('preflight-btn')
    await until('the unanswered state again', `/has not confirmed call audio/.test(document.getElementById('pf-system').textContent) && !nativeCheck`)
    assert.equal((await fake()).displayCalls, stale, 'no second request while macOS is still deciding the first')
    await js(`NATIVE_WAIT.abandonMs = 0`)
    await setMode('tone')
    await click('preflight-btn')
    await until('the ready state', `document.getElementById('pf-system').className.includes('ok')`)
    assert.equal((await fake()).displayCalls, stale + 1)
    await js(`NATIVE_WAIT.abandonMs = 80000; __fake.releases.at(-1)('tone')`)
    await sleep(300)
    assert.equal(await js(`__fake.tracks.at(-1).readyState`), 'ended', 'the abandoned request is closed when it finally arrives')
    step('unanswered request: not repeated while pending, abandoned after its time, then asked afresh')

    // macOS delivers nothing (the track is live but no frame ever arrives).
    await setMode('unanswered')
    await start()
    await until('the no-frames report', `rec.health.system === 'no_frames'`, 12000)
    assert.match(await text('cap-system'), /NOT captured/)
    assert.match(await text('capture-note'), /macOS is not giving ForgeNotes the call audio/)
    assert.match(await text('capture-note'), /System Audio Recording Only/)
    assert.equal(await js('rec.health.mic'), 'ok', 'the microphone keeps recording')
    await stop()
    step('call audio not delivered: reported within seconds, during the recording')

    // macOS refuses at Start (permission switched off since the last check).
    await setMode('dead')
    await start()
    assert.equal(await js('rec.systemStream'), null)
    assert.match(await text('cap-system'), /NOT captured/)
    assert.match(await text('capture-note'), /System Audio Recording Only/)
    assert.doesNotMatch(await text('capture-note'), /BlackHole|driver/i)
    await sleep(1500)
    saved = await stop()
    assert.deepEqual(saved.tracks, ['mic'])
    assert.match(await text('capture-note'), /This recording has no call audio/)
    step('refused at Start: microphone-only recording, said plainly at the start and at the end')

    // A track that is delivered but silent for the whole recording.
    await setMode('tone')
    await click('preflight-btn')
    await until('the ready state', `document.getElementById('pf-system').className.includes('ok')`)
    await setMode('silent')
    await start()
    await until('levels', `rec.levels.system && rec.levels.system.snapshot().totalMs > 10500`, 20000)
    assert.equal(await js('rec.heard.system'), false)
    assert.match(await text('cap-system'), /capturing/, 'a quiet start is not an error before 30 s')
    saved = await stop()
    assert.deepEqual([...saved.tracks].sort(), ['mic', 'system'])
    assert.match(await text('capture-note'), /This recording has no call audio/)
    assert.doesNotMatch(await text('capture-note'), /BlackHole/)
    step('silent call-audio track: the finished recording is flagged')

    // The setting: keep BlackHole on a Mac that could do without it.
    await setMode('tone')
    const displayCalls = (await fake()).displayCalls
    await js(`(() => { const s = document.getElementById('system-audio-pref'); s.value = 'blackhole'; s.dispatchEvent(new Event('change')) })()`)
    await until('the BlackHole controls', `!document.getElementById('blackhole-fields').classList.contains('hidden')`)
    assert.equal(await visible('native-audio-fields'), false)
    await until('the BlackHole device check', `/BlackHole 2ch/.test(document.getElementById('pf-system').textContent)`)
    await start()
    assert.equal(await js('rec.systemPath'), 'blackhole')
    await until('call audio to be heard', `rec.health.system === 'ok'`)
    saved = await stop()
    calls = await fake()
    assert.equal(calls.displayCalls, displayCalls, 'with BlackHole chosen, native capture is not opened as well')
    assert.ok(calls.inputs.includes('bh'))
    assert.equal(saved.system_audio_path, 'blackhole')
    step('setting = BlackHole: only the BlackHole input is opened')

    // Room setup: no call audio on either path.
    const inputsBefore = calls.inputs.filter((id) => id === 'bh').length
    await click('mode-room')
    await until('the room device check', `/Room microphone only/.test(document.getElementById('pf-system').textContent)`)
    await start()
    assert.equal(await js('rec.systemPath'), 'none')
    await sleep(1200)
    saved = await stop()
    calls = await fake()
    assert.equal(calls.displayCalls, displayCalls)
    assert.equal(calls.inputs.filter((id) => id === 'bh').length, inputsBefore)
    assert.deepEqual(saved.tracks, ['mic'])
    assert.equal(await visible('capture-note'), false, 'no call-audio warning in the room setup')
    step('room setup: microphone only, no call-audio capture and no warning about it')
  }

  console.log(JSON.stringify({ electron: process.versions.electron, macos: process.env.FORGENOTES_FAKE_MACOS_VERSION, steps: steps.length }))
  finish(0)
}).catch((error) => {
  console.error(error)
  finish(1)
})
