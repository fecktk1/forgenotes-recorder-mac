// System-audio ("call audio") capture: the decisions and the measurements, with no DOM and
// no Electron in them, so the same file runs in the renderer (as window.FNSystemAudio), in
// the main process (require) and under `node --test`.
//
// Two ways to record the other side of a call exist on macOS, and the recorder uses exactly
// one of them for a recording, never both:
//
//   native    macOS 14.2 and later. Chromium opens a Core Audio tap on the Mac's sound
//             output. Nothing to install and nothing to route. macOS asks once for
//             permission ("System Audio Recording Only" in System Settings).
//   blackhole macOS 12.0 to 14.1, or when the user chooses it. The BlackHole 2ch virtual
//             device, which the user installs and routes through a Multi-Output Device.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.FNSystemAudio = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  // AudioHardwareCreateProcessTap exists from macOS 14.2. Chromium gates its Core Audio tap
  // path on exactly this version (media/base/media_switches.cc,
  // IsMacCatapSystemLoopbackCaptureSupported, Chromium 150 / Electron 43).
  const NATIVE_MIN_MACOS = [14, 2, 0]
  const NATIVE_MIN_MACOS_LABEL = '14.2'

  function parseVersion(value) {
    const parts = String(value == null ? '' : value).trim().split('.')
    const out = [0, 0, 0]
    for (let i = 0; i < 3; i++) {
      const n = Number.parseInt(parts[i], 10)
      out[i] = Number.isFinite(n) && n >= 0 ? n : 0
    }
    return out
  }

  function compareVersions(a, b) {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    }
    return 0
  }

  function nativeSupported({ platform, systemVersion } = {}) {
    return platform === 'darwin' && compareVersions(parseVersion(systemVersion), NATIVE_MIN_MACOS) >= 0
  }

  // The only stored setting: 'auto' (use what this Mac supports) or 'blackhole' (keep the
  // driver even where macOS could do it natively). Anything else reads as 'auto'.
  function normalizePreference(value) {
    return value === 'blackhole' ? 'blackhole' : 'auto'
  }

  // One answer, so both can never be active at once.
  function choosePath({ platform, systemVersion, preference } = {}) {
    const supported = nativeSupported({ platform, systemVersion })
    if (!supported) {
      return { path: 'blackhole', nativeSupported: false, reason: platform === 'darwin' ? 'macos_too_old' : 'not_macos' }
    }
    if (normalizePreference(preference) === 'blackhole') {
      return { path: 'blackhole', nativeSupported: true, reason: 'user_prefers_blackhole' }
    }
    return { path: 'native', nativeSupported: true, reason: 'native_default' }
  }

  // Main process: what to answer a getDisplayMedia() request with. Only an audio-only request
  // from the recorder's own window, on a macOS that has the tap, gets system audio. No video
  // source is ever granted, so the Screen Recording permission is never involved. null means
  // refuse (the renderer's getDisplayMedia() then rejects).
  function displayMediaResponse(request, { nativeSupported: supported, trustedFrame } = {}) {
    if (!supported || !trustedFrame || !request) return null
    if (!request.audioRequested || request.videoRequested) return null
    return { audio: 'loopback' }
  }

  // ---------------------------------------------------------------- levels and silence
  // A track counts as carrying sound once its peak passes -75 dBFS. Below that is digital
  // silence or the residue of a dead route: a Bluetooth hands-free microphone that macOS has
  // silenced measures about -78 dBFS peak (silverstein/minutes issue 1057), a live
  // microphone in a quiet room sits well above.
  const SILENCE_PEAK_DBFS = -75
  const SILENCE_PEAK = Math.pow(10, SILENCE_PEAK_DBFS / 20)

  function toDb(amplitude) {
    return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity
  }

  // Whole-buffer measurement of decoded PCM (a recorded segment, or any Float32Array).
  function analyzePcm(samples) {
    let peak = 0
    let sum = 0
    const n = samples ? samples.length : 0
    for (let i = 0; i < n; i++) {
      const v = samples[i]
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
      sum += v * v
    }
    const rms = n ? Math.sqrt(sum / n) : 0
    return { frames: n, peak, rms, peakDb: toDb(peak), rmsDb: toDb(rms), silent: peak < SILENCE_PEAK }
  }

  // Running account of one live track, fed with block summaries from level-worklet.js
  // ({ peak, frames, sampleRate } a few times a second).
  function createLevelMonitor() {
    const s = { totalMs: 0, heardMs: 0, silentRunMs: 0, everHeard: false, maxPeak: 0, blocks: 0 }
    return {
      push({ peak, frames, sampleRate }) {
        const ms = sampleRate > 0 ? (frames / sampleRate) * 1000 : 0
        s.blocks += 1
        s.totalMs += ms
        if (peak > s.maxPeak) s.maxPeak = peak
        if (peak >= SILENCE_PEAK) {
          s.everHeard = true
          s.heardMs += ms
          s.silentRunMs = 0
        } else {
          s.silentRunMs += ms
        }
      },
      snapshot() {
        return { ...s, maxPeakDb: toDb(s.maxPeak) }
      },
    }
  }

  // How long a track may stay silent from the start before the user is told. The microphone
  // always has room noise, so it is judged quickly; call audio can be legitimately quiet
  // while nobody on the far end has spoken yet, so it gets longer and a softer message.
  const MIC_SILENT_WARN_MS = 12 * 1000
  const SYSTEM_SILENT_WARN_MS = 30 * 1000
  // A live track that has delivered no audio frames at all after this long is not being fed
  // by macOS (permission not given, or the prompt is still unanswered).
  const NO_FRAMES_WARN_MS = 4 * 1000

  // One word for the state of a track during a recording.
  //   ok        delivering audio that has contained sound
  //   starting  too early to say
  //   absent    there is no track at all
  //   ended     the track has ended (device gone, permission refused, route torn down)
  //   no_frames live, but macOS has delivered no frames
  //   silent    frames arrive but they carry no sound: for call audio, nothing has been
  //             heard since the track was opened (a quiet stretch later in a call is
  //             normal and is not reported); for the microphone, nothing for
  //             MIC_SILENT_WARN_MS at any point, because a working microphone always
  //             hears the room
  function trackHealth({ kind, hasTrack, readyState, deliveredFrames, level, elapsedMs }) {
    if (!hasTrack) return 'absent'
    if (readyState === 'ended') return 'ended'
    if (typeof deliveredFrames === 'number' && deliveredFrames === 0 && elapsedMs >= NO_FRAMES_WARN_MS) return 'no_frames'
    if (level) {
      if (kind === 'mic' && level.silentRunMs >= MIC_SILENT_WARN_MS) return 'silent'
      if (kind !== 'mic' && !level.everHeard && level.totalMs >= SYSTEM_SILENT_WARN_MS) return 'silent'
      if (level.everHeard) return 'ok'
    }
    return 'starting'
  }

  // A finished recording shorter than this is not judged: there was no time to hear anything.
  const FINAL_SILENCE_MIN_MS = 10 * 1000

  // ---------------------------------------------------------------- what the user is told
  // The names macOS uses (checked against the System Settings strings of macOS 27): the pane
  // is "Screen & System Audio Recording", the list this app appears in is "System Audio
  // Recording Only". macOS may want the app reopened before a changed switch takes effect.
  const SETTINGS_PATH = 'System Settings → Privacy & Security → Screen & System Audio Recording'
  const SETTINGS_FIX = `Open ${SETTINGS_PATH}, and under “System Audio Recording Only” turn on ForgeNotes Recorder.`
  const REOPEN_NOTE = 'If macOS asks to quit and reopen the app, accept.'

  // Sentences a person can act on. `path` is 'native' or 'blackhole'. The native sentences
  // never mention a driver; the BlackHole sentences never send anyone to the macOS
  // permission that path does not use.
  function healthMessage({ kind, health, path }) {
    if (kind === 'mic') {
      if (health === 'silent' || health === 'no_frames') {
        return {
          level: 'error',
          text: 'Your microphone is silent. Check that it is not muted. If it is a Bluetooth headset, macOS may have switched it to call mode: stop, choose the Mac’s built-in microphone, and start again.',
        }
      }
      if (health === 'ended' || health === 'absent') {
        return { level: 'error', text: 'The microphone stopped (unplugged, switched off or disconnected). ForgeNotes is trying to reconnect it.' }
      }
      return null
    }
    if (path === 'native') {
      if (health === 'absent' || health === 'ended' || health === 'no_frames') {
        return {
          level: 'error',
          text: `macOS is not giving ForgeNotes the call audio, so only your microphone is being recorded. To fix it, stop this recording, then: ${SETTINGS_FIX} ${REOPEN_NOTE}`,
        }
      }
      if (health === 'silent') {
        return {
          level: 'warn',
          text: `No call audio has been heard yet. If someone on the call is speaking and the Call audio bar is not moving, check that the meeting app plays through your Mac’s current sound output (System Settings → Sound → Output). If it still does not move: ${SETTINGS_FIX}`,
        }
      }
      return null
    }
    if (health === 'absent' || health === 'ended' || health === 'no_frames') {
      return {
        level: 'error',
        text: 'The BlackHole input is not delivering audio, so only your microphone is being recorded. Check that BlackHole 2ch is installed and selected under “System audio source”.',
      }
    }
    if (health === 'silent') {
      return {
        level: 'warn',
        text: 'No call audio has been heard yet. If someone on the call is speaking and the Call audio bar is not moving, set your Mac’s sound output to the Multi-Output Device that includes BlackHole 2ch (System Settings → Sound → Output).',
      }
    }
    return null
  }

  // Shown after Stop when the call-audio track of the finished recording never carried sound.
  function noCallAudioSummary(path) {
    const head = 'This recording has no call audio: only your microphone was recorded.'
    if (path === 'native') {
      return `${head} For the next call, check that the meeting app plays through your Mac’s current sound output (System Settings → Sound → Output), and that ForgeNotes Recorder is turned on under ${SETTINGS_PATH} → “System Audio Recording Only”.`
    }
    return `${head} For the next call, check that BlackHole 2ch is selected under “System audio source” and that your Mac’s sound output is the Multi-Output Device that includes BlackHole 2ch.`
  }

  // Result of asking macOS for call audio before a recording (see probeNativeSystemAudio in
  // app.js). Returns what the device-check row shows and which buttons to offer.
  function nativePermissionCopy(state) {
    switch (state) {
      case 'ready':
        return { row: 'ok', text: 'Ready. macOS records the call audio directly: no driver and no audio routing.', allow: false, settings: false }
      case 'needs_permission':
        return {
          row: 'warn',
          text: 'One step left: click “Allow call audio”, then choose Allow in the macOS window that appears. This lets ForgeNotes record the other side of a call. Nothing is recorded until you press Start.',
          allow: true,
          settings: false,
        }
      case 'asking':
        return { row: 'checking', text: 'Waiting for your answer in the macOS window. Choose Allow.', allow: false, settings: false }
      case 'denied':
        return { row: 'fail', text: `macOS is not letting ForgeNotes record call audio. ${SETTINGS_FIX} ${REOPEN_NOTE} Otherwise click Re-check.`, allow: false, settings: true }
      case 'unanswered':
        return {
          row: 'warn',
          text: `macOS has not confirmed call audio. If a macOS window is asking for permission, choose Allow, then click Re-check. Otherwise: ${SETTINGS_FIX}`,
          allow: true,
          settings: true,
        }
      default:
        return { row: 'warn', text: 'Could not check call audio.', allow: true, settings: true }
    }
  }

  // ---------------------------------------------------------------- Bluetooth microphones
  // A Bluetooth headset's microphone only works in the hands-free profile: macOS drops the
  // headset to 8, 16 or 24 kHz mono, playback quality falls with it, and the switch changes
  // the output format under a running system-audio capture. Wired, built-in and USB
  // microphones run at 44.1 kHz or more.
  const BLUETOOTH_LABEL = /air\s?pods|bluetooth|hands-?free|head\s?set|\bbeats\b|\bbuds\b|\bbose\b|jabra|\bwh-|\bwf-/i

  function looksLikeBluetoothMic({ label, sampleRate } = {}) {
    if (typeof sampleRate === 'number' && sampleRate > 0 && sampleRate <= 24000) return true
    return BLUETOOTH_LABEL.test(String(label || ''))
  }

  const BLUETOOTH_MIC_NOTE =
    'This microphone looks like a Bluetooth headset. While its microphone is in use, macOS switches the headset to call mode: sound quality drops, and on some headsets the microphone or the call audio goes silent. The Mac’s built-in microphone, with the headset kept for listening, records more reliably.'

  // BlackHole path only: call audio reaches BlackHole through a Multi-Output Device, so an
  // output that is neither of those means the call is no longer being captured.
  function outputFeedsBlackhole(outputLabel) {
    return /blackhole|multi-output/i.test(String(outputLabel || ''))
  }

  // ---------------------------------------------------------------- echo measurement
  // How much of the system track comes back through the microphone (speakers into mic).
  // Measurement only: nothing here removes echo.
  //
  //   lagMs       how much later the sound arrives in the mic track than in the system track
  //   correlation 0..1, how alike the two tracks are at that lag (speech over a quiet room
  //               on laptop speakers is typically well above 0.3; headphones, near 0)
  //   leakDb      level of the echo in the mic track relative to the same sound in the
  //               system track
  //   micShare    0..1, the part of the mic track's energy that is echo
  //
  // Both inputs are mono Float32Array at the same sample rate, starting at the same instant.
  function measureEcho(mic, system, sampleRate, { minLagMs = -60, maxLagMs = 400 } = {}) {
    const empty = { detected: false, lagMs: 0, correlation: 0, leakDb: -Infinity, micShare: 0 }
    const n = Math.min(mic ? mic.length : 0, system ? system.length : 0)
    if (!n || !(sampleRate > 0)) return empty
    const minLag = Math.round((minLagMs / 1000) * sampleRate)
    const maxLag = Math.round((maxLagMs / 1000) * sampleRate)
    let best = { score: 0, lag: 0, cross: 0, micEnergy: 0, sysEnergy: 0 }
    for (let lag = minLag; lag <= maxLag; lag++) {
      // mic[i + lag] against system[i]
      const start = lag < 0 ? -lag : 0
      const end = lag > 0 ? n - lag : n
      if (end - start < sampleRate / 4) continue
      let cross = 0
      let micEnergy = 0
      let sysEnergy = 0
      for (let i = start; i < end; i++) {
        const m = mic[i + lag]
        const s = system[i]
        cross += m * s
        micEnergy += m * m
        sysEnergy += s * s
      }
      if (!(micEnergy > 0) || !(sysEnergy > 0)) continue
      const score = Math.abs(cross) / Math.sqrt(micEnergy * sysEnergy)
      if (score > best.score) best = { score, lag, cross, micEnergy, sysEnergy }
    }
    if (!(best.score > 0)) return empty
    const gain = Math.abs(best.cross) / best.sysEnergy
    return {
      detected: best.score >= 0.15,
      lagMs: (best.lag / sampleRate) * 1000,
      correlation: best.score,
      leakDb: toDb(gain),
      micShare: Math.min(1, (gain * gain * best.sysEnergy) / best.micEnergy),
    }
  }

  return {
    NATIVE_MIN_MACOS_LABEL,
    SILENCE_PEAK,
    SILENCE_PEAK_DBFS,
    MIC_SILENT_WARN_MS,
    SYSTEM_SILENT_WARN_MS,
    NO_FRAMES_WARN_MS,
    SETTINGS_PATH,
    BLUETOOTH_MIC_NOTE,
    parseVersion,
    compareVersions,
    nativeSupported,
    normalizePreference,
    choosePath,
    displayMediaResponse,
    toDb,
    analyzePcm,
    createLevelMonitor,
    trackHealth,
    FINAL_SILENCE_MIN_MS,
    healthMessage,
    noCallAudioSummary,
    nativePermissionCopy,
    looksLikeBluetoothMic,
    outputFeedsBlackhole,
    measureEcho,
  }
})
