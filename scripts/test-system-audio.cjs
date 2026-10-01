// Everything about call-audio capture that can be proven without macOS showing its
// permission window: which path a Mac gets, that the two paths are never both active, what
// main answers a capture request with, silence detection on PCM buffers, track health, the
// wording per path, and the echo measurement.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const SA = require('../renderer/system-audio.js')

const RATE = 16000

function tone(seconds, { freq = 440, amp = 0.3, rate = RATE } = {}) {
  const out = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate)
  return out
}

// Deterministic noise: a speech-like broadband signal without Math.random().
function noise(seconds, { amp = 0.3, seed = 1, rate = RATE } = {}) {
  const out = new Float32Array(Math.round(seconds * rate))
  let state = seed >>> 0
  for (let i = 0; i < out.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out[i] = amp * ((state / 0xffffffff) * 2 - 1)
  }
  return out
}

test('macOS versions map to exactly one capture path', () => {
  const cases = [
    ['12.7.6', 'blackhole', 'macos_too_old'],
    ['13.6.9', 'blackhole', 'macos_too_old'],
    ['14.0', 'blackhole', 'macos_too_old'],
    ['14.1.2', 'blackhole', 'macos_too_old'],
    ['14.2', 'native', 'native_default'],
    ['14.2.1', 'native', 'native_default'],
    ['14.7.8', 'native', 'native_default'],
    ['15.0', 'native', 'native_default'],
    ['15.6.1', 'native', 'native_default'],
    ['26.0', 'native', 'native_default'],
    ['27.2.0', 'native', 'native_default'],
  ]
  for (const [systemVersion, expectedPath, reason] of cases) {
    const choice = SA.choosePath({ platform: 'darwin', systemVersion })
    assert.equal(choice.path, expectedPath, `macOS ${systemVersion}`)
    assert.equal(choice.reason, reason, `macOS ${systemVersion}`)
    assert.equal(choice.nativeSupported, expectedPath === 'native')
    assert.ok(['native', 'blackhole'].includes(choice.path), 'one path, never a combination')
  }
})

test('the setting can keep BlackHole on a new Mac but cannot force native on an old one', () => {
  assert.deepEqual(SA.choosePath({ platform: 'darwin', systemVersion: '15.5', preference: 'blackhole' }),
    { path: 'blackhole', nativeSupported: true, reason: 'user_prefers_blackhole' })
  assert.equal(SA.choosePath({ platform: 'darwin', systemVersion: '15.5', preference: 'auto' }).path, 'native')
  assert.equal(SA.choosePath({ platform: 'darwin', systemVersion: '13.5', preference: 'auto' }).path, 'blackhole')
  // Unknown or tampered stored values read as 'auto'.
  for (const junk of [null, undefined, '', 'native', 'both', 'NATIVE', 42, {}]) {
    assert.equal(SA.normalizePreference(junk), 'auto')
    assert.equal(SA.choosePath({ platform: 'darwin', systemVersion: '13.5', preference: junk }).path, 'blackhole')
    assert.equal(SA.choosePath({ platform: 'darwin', systemVersion: '14.2', preference: junk }).path, 'native')
  }
})

test('unreadable versions and other platforms fall back to BlackHole', () => {
  for (const systemVersion of [undefined, null, '', 'unknown', 'x.y.z', '-1.0']) {
    assert.equal(SA.choosePath({ platform: 'darwin', systemVersion }).path, 'blackhole', String(systemVersion))
  }
  assert.equal(SA.choosePath({ platform: 'win32', systemVersion: '10.0.26100' }).reason, 'not_macos')
  assert.equal(SA.choosePath().path, 'blackhole')
  assert.deepEqual(SA.parseVersion('14.2'), [14, 2, 0])
  assert.deepEqual(SA.parseVersion('15.6.1 (24G90)'), [15, 6, 1])
  assert.equal(SA.compareVersions([14, 10, 0], [14, 2, 0]), 1, 'numeric, not text, comparison')
})

test('main grants system audio only to an audio-only request from the recorder window on a capable Mac', () => {
  const ok = { nativeSupported: true, trustedFrame: true }
  assert.deepEqual(SA.displayMediaResponse({ audioRequested: true, videoRequested: false }, ok), { audio: 'loopback' })
  // Never a video source: the Screen Recording permission must not be involved.
  assert.equal(SA.displayMediaResponse({ audioRequested: true, videoRequested: true }, ok), null)
  assert.equal(SA.displayMediaResponse({ audioRequested: false, videoRequested: true }, ok), null)
  assert.equal(SA.displayMediaResponse({ audioRequested: false, videoRequested: false }, ok), null)
  // Older macOS: refused, so the BlackHole path is the only one that can run there.
  assert.equal(SA.displayMediaResponse({ audioRequested: true, videoRequested: false }, { nativeSupported: false, trustedFrame: true }), null)
  // Any other frame or window: refused.
  assert.equal(SA.displayMediaResponse({ audioRequested: true, videoRequested: false }, { nativeSupported: true, trustedFrame: false }), null)
  assert.equal(SA.displayMediaResponse(null, ok), null)
  assert.equal(SA.displayMediaResponse({ audioRequested: true, videoRequested: false }), null)
  const granted = SA.displayMediaResponse({ audioRequested: true, videoRequested: false }, ok)
  assert.ok(!('video' in granted))
})

test('silence detection on PCM buffers', () => {
  const zeros = SA.analyzePcm(new Float32Array(RATE))
  assert.equal(zeros.silent, true)
  assert.equal(zeros.peak, 0)
  assert.equal(zeros.peakDb, -Infinity)

  // The dead Bluetooth hands-free route measured in minutes#1057: max -78.3 dB, mean -91 dB.
  const deadRoute = SA.analyzePcm(noise(1, { amp: Math.pow(10, -78.3 / 20) }))
  assert.equal(deadRoute.silent, true)
  assert.ok(deadRoute.peakDb < SA.SILENCE_PEAK_DBFS)

  // A quiet room on a working microphone (peaks around -55 dBFS) is NOT silence.
  const quietRoom = SA.analyzePcm(noise(1, { amp: Math.pow(10, -55 / 20) }))
  assert.equal(quietRoom.silent, false)

  const speechLevel = SA.analyzePcm(tone(1, { amp: 0.25 }))
  assert.equal(speechLevel.silent, false)
  assert.ok(Math.abs(speechLevel.peakDb - 20 * Math.log10(0.25)) < 0.1)
  assert.ok(Math.abs(speechLevel.rmsDb - 20 * Math.log10(0.25 / Math.SQRT2)) < 0.1)

  // One click in an otherwise silent buffer is sound.
  const click = new Float32Array(RATE)
  click[1234] = -0.2
  assert.equal(SA.analyzePcm(click).silent, false)
  assert.equal(SA.analyzePcm(new Float32Array(0)).silent, true)
  assert.equal(SA.analyzePcm(null).frames, 0)
})

// Feeds a level monitor the way level-worklet.js does: a block summary every quarter second.
function feed(monitor, seconds, peak, rate = 48000) {
  for (let i = 0; i < seconds * 4; i++) monitor.push({ peak, frames: rate / 4, sampleRate: rate })
}

test('a call-audio track that never carries sound is reported after 30 s, and not before', () => {
  const monitor = SA.createLevelMonitor()
  const health = (elapsedMs) => SA.trackHealth({
    kind: 'system', hasTrack: true, readyState: 'live', deliveredFrames: 48000, level: monitor.snapshot(), elapsedMs,
  })
  feed(monitor, 10, 0)
  assert.equal(health(10000), 'starting')
  feed(monitor, 19, 0)
  assert.equal(health(29000), 'starting')
  feed(monitor, 2, 0)
  assert.equal(health(31000), 'silent')
  // Somebody speaks: fine from then on, and a later quiet stretch is normal on a call.
  feed(monitor, 1, 0.2)
  assert.equal(health(32000), 'ok')
  feed(monitor, 600, 0)
  assert.equal(health(632000), 'ok')
  const snap = monitor.snapshot()
  assert.equal(snap.everHeard, true)
  assert.ok(Math.abs(snap.heardMs - 1000) < 1)
  assert.ok(Math.abs(snap.silentRunMs - 600000) < 1)
})

test('a silent microphone is reported within 12 s, at the start or later', () => {
  const monitor = SA.createLevelMonitor()
  const health = () => SA.trackHealth({
    kind: 'mic', hasTrack: true, readyState: 'live', deliveredFrames: 48000, level: monitor.snapshot(), elapsedMs: 60000,
  })
  feed(monitor, 11, 0)
  assert.equal(health(), 'starting')
  feed(monitor, 2, 0)
  assert.equal(health(), 'silent')
  feed(monitor, 5, 0.05)
  assert.equal(health(), 'ok')
  // The headset drops into a dead hands-free route mid-recording.
  feed(monitor, 13, Math.pow(10, -78.3 / 20))
  assert.equal(health(), 'silent')
  feed(monitor, 1, 0.05)
  assert.equal(health(), 'ok')
})

test('absent, ended and undelivered tracks are told apart', () => {
  const level = SA.createLevelMonitor().snapshot()
  assert.equal(SA.trackHealth({ kind: 'system', hasTrack: false }), 'absent')
  assert.equal(SA.trackHealth({ kind: 'system', hasTrack: true, readyState: 'ended', deliveredFrames: 0, level, elapsedMs: 100 }), 'ended')
  // macOS permission window unanswered: live, but not one frame delivered.
  assert.equal(SA.trackHealth({ kind: 'system', hasTrack: true, readyState: 'live', deliveredFrames: 0, level, elapsedMs: 1000 }), 'starting')
  assert.equal(SA.trackHealth({ kind: 'system', hasTrack: true, readyState: 'live', deliveredFrames: 0, level, elapsedMs: 4000 }), 'no_frames')
  // A Chromium without the frame counter (null) must not be read as "no frames".
  assert.equal(SA.trackHealth({ kind: 'system', hasTrack: true, readyState: 'live', deliveredFrames: null, level, elapsedMs: 9000 }), 'starting')
  assert.equal(SA.trackHealth({ kind: 'mic', hasTrack: true, readyState: 'ended', level, elapsedMs: 9000 }), 'ended')
})

test('every failure has a sentence, and each path only names its own remedy', () => {
  for (const health of ['absent', 'ended', 'no_frames', 'silent']) {
    const native = SA.healthMessage({ kind: 'system', health, path: 'native' })
    const blackhole = SA.healthMessage({ kind: 'system', health, path: 'blackhole' })
    assert.ok(native && native.text.length > 40, `native ${health}`)
    assert.ok(blackhole && blackhole.text.length > 40, `blackhole ${health}`)
    assert.doesNotMatch(native.text, /blackhole|driver|multi-output|install/i, 'a Mac on the native path is never sent to a driver')
    assert.match(native.text, /System Audio Recording Only/, 'the native remedy names what to click')
    assert.match(blackhole.text, /BlackHole/)
    assert.doesNotMatch(blackhole.text, /System Audio Recording Only/)
    assert.equal(native.level, health === 'silent' ? 'warn' : 'error')
  }
  for (const health of ['ok', 'starting']) {
    assert.equal(SA.healthMessage({ kind: 'system', health, path: 'native' }), null)
    assert.equal(SA.healthMessage({ kind: 'system', health, path: 'blackhole' }), null)
    assert.equal(SA.healthMessage({ kind: 'mic', health }), null)
  }
  assert.match(SA.healthMessage({ kind: 'mic', health: 'silent' }).text, /Bluetooth/)
  assert.match(SA.healthMessage({ kind: 'mic', health: 'ended' }).text, /reconnect/)
  assert.doesNotMatch(SA.noCallAudioSummary('native'), /blackhole|driver/i)
  assert.match(SA.noCallAudioSummary('native'), /System Audio Recording Only/)
  assert.match(SA.noCallAudioSummary('blackhole'), /BlackHole 2ch/)
})

test('the permission step says what to click in every state and offers the right buttons', () => {
  const states = ['ready', 'needs_permission', 'asking', 'denied', 'unanswered', 'something-else']
  for (const state of states) {
    const copy = SA.nativePermissionCopy(state)
    assert.ok(copy.text.length > 10, state)
    assert.doesNotMatch(copy.text, /blackhole|driver.*install|install.*driver/i, state)
    assert.doesNotMatch(copy.text, /!/, 'calm sentences')
  }
  assert.deepEqual([SA.nativePermissionCopy('ready').row, SA.nativePermissionCopy('ready').allow], ['ok', false])
  assert.equal(SA.nativePermissionCopy('needs_permission').allow, true)
  assert.match(SA.nativePermissionCopy('needs_permission').text, /Allow call audio/)
  assert.equal(SA.nativePermissionCopy('denied').row, 'fail')
  assert.equal(SA.nativePermissionCopy('denied').settings, true)
  assert.equal(SA.nativePermissionCopy('denied').allow, false, 'macOS does not ask twice: only System Settings helps')
  assert.match(SA.nativePermissionCopy('denied').text, /System Audio Recording Only/)
})

test('Bluetooth microphones are recognised by sample rate or by name', () => {
  assert.equal(SA.looksLikeBluetoothMic({ label: 'MacBook Pro Microphone (Built-in)', sampleRate: 48000 }), false)
  assert.equal(SA.looksLikeBluetoothMic({ label: 'RODECaster Pro Stereo (19f7:0011)', sampleRate: 48000 }), false)
  assert.equal(SA.looksLikeBluetoothMic({ label: 'Logi Zone Wireless 2', sampleRate: 16000 }), true, 'hands-free profile rate')
  assert.equal(SA.looksLikeBluetoothMic({ label: 'Unknown', sampleRate: 24000 }), true)
  assert.equal(SA.looksLikeBluetoothMic({ label: 'Josh’s AirPods Pro', sampleRate: 48000 }), true)
  assert.equal(SA.looksLikeBluetoothMic({ label: 'Jabra Evolve2 65 (Bluetooth)' }), true)
  assert.equal(SA.looksLikeBluetoothMic({ label: 'External Headset' }), true)
  assert.equal(SA.looksLikeBluetoothMic({}), false)
  assert.equal(SA.looksLikeBluetoothMic(), false)
  assert.equal(SA.outputFeedsBlackhole('Multi-Output Device (Aggregate)'), true)
  assert.equal(SA.outputFeedsBlackhole('BlackHole 2ch (Virtual)'), true)
  assert.equal(SA.outputFeedsBlackhole('MacBook Pro Speakers (Built-in)'), false)
})

test('echo measurement finds the delay and the level of speaker sound in the microphone', () => {
  const seconds = 3
  const system = noise(seconds, { amp: 0.3, seed: 7 })
  const voice = noise(seconds, { amp: 0.05, seed: 99 }) // the user's own speech, unrelated
  const delay = Math.round(0.085 * RATE) // 85 ms: output latency + air + input latency
  const gain = Math.pow(10, -12 / 20) // the echo arrives 12 dB down
  const mic = new Float32Array(system.length)
  for (let i = 0; i < mic.length; i++) mic[i] = voice[i] + (i >= delay ? gain * system[i - delay] : 0)

  const echo = SA.measureEcho(mic, system, RATE, { maxLagMs: 200 })
  assert.equal(echo.detected, true)
  assert.ok(Math.abs(echo.lagMs - 85) < 1, `lag ${echo.lagMs}`)
  assert.ok(Math.abs(echo.leakDb - -12) < 1, `leak ${echo.leakDb}`)
  assert.ok(echo.correlation > 0.6)
  assert.ok(echo.micShare > 0.5 && echo.micShare <= 1)

  // Headphones: nothing of the call reaches the microphone.
  const none = SA.measureEcho(voice, system, RATE, { maxLagMs: 200 })
  assert.equal(none.detected, false)
  assert.ok(none.correlation < 0.1)

  // Degenerate input never throws and never reports echo.
  assert.equal(SA.measureEcho(new Float32Array(RATE), system, RATE).detected, false)
  assert.equal(SA.measureEcho(new Float32Array(0), new Float32Array(0), RATE).detected, false)
  assert.equal(SA.measureEcho(mic, system, 0).detected, false)
})

// ---- contracts between the files: things a refactor must not quietly undo.
const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('the two capture paths cannot both be opened for one recording', () => {
  const app = read('renderer/app.js')
  // One stream slot, filled through one function that takes exactly one path.
  assert.match(app, /function openSystemStream\(path, deviceId\) \{\n {2}if \(path === 'native'\) return openNativeSystemStream\(\)\n {2}return navigator\.mediaDevices\.getUserMedia/)
  assert.equal(app.split('getDisplayMedia(').length - 1, 1, 'native capture is requested from exactly one place')
  assert.match(app, /getDisplayMedia\(\{ audio: \{ \.\.\.RAW_AUDIO \}, video: false \}\)/, 'audio only: no screen capture')
  // Room mode records no call audio on either path.
  assert.match(app, /const systemPath = profile === 'remote_dual_track' \? systemAudioChoice\(\)\.path : 'none'/)
})

test('main never enumerates screens and only answers through the shared decision', () => {
  const main = read('main.js')
  assert.doesNotMatch(main, /desktopCapturer/, 'no screen sources: Screen Recording permission must not be requested')
  assert.match(main, /systemAudio\.displayMediaResponse\(request, \{ nativeSupported: NATIVE_SYSTEM_AUDIO, trustedFrame \}\)/)
  assert.doesNotMatch(main, /loopbackWithMute/, 'the user must keep hearing the call')
})

test('the app declares why it records system audio, and onboarding never demands a driver', () => {
  const pkg = JSON.parse(read('package.json'))
  const info = pkg.build.mac.extendInfo
  assert.ok(info.NSAudioCaptureUsageDescription && info.NSAudioCaptureUsageDescription.length > 30)
  assert.doesNotMatch(info.NSAudioCaptureUsageDescription, /blackhole/i)
  assert.doesNotMatch(info.NSMicrophoneUsageDescription, /blackhole/i, 'the microphone prompt is shown to people who have no driver')
  for (const file of ['build/entitlements.mac.plist', 'build/entitlements.mac.inherit.plist']) {
    assert.match(read(file), /com\.apple\.security\.device\.audio-input/, file)
  }
  const html = read('renderer/index.html')
  const firstRun = html.slice(html.indexOf('id="first-run"'), html.indexOf('id="first-run-dismiss"'))
  assert.doesNotMatch(firstRun, /blackhole/i, 'the first-run hint is static text shown on every Mac')
  // BlackHole instructions live only inside the block that is hidden on the native path.
  const outsideBlackhole = html.replace(/<div id="blackhole-fields"[\s\S]*?<\/div>\s*\n/, '').replace(/<option value="blackhole">[^<]*<\/option>/, '')
  assert.doesNotMatch(outsideBlackhole.replace(/<!--[\s\S]*?-->/g, ''), /blackhole|multi-output/i)
  assert.match(html, /<script src="system-audio\.js"><\/script>\s*<script src="app\.js"><\/script>/)
})
