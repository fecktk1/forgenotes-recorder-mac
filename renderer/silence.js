// Stop on silence, for the desktop recorder. The same behaviour, defaults and wording as the
// web recorder (social-os src/notes/lib/silenceDetector.js, captureSettings.js and
// liveRecording.js; the contract is internal/forgenotes/capture-api.md, section 3).
//
// OFF unless the person turns it on. The setting is per account on the server
// (rpc forgenotes_capture_settings / forgenotes_set_capture_settings), so it follows the
// person between the web and this app. Start must not wait for the network, so the last
// value seen is also kept in localStorage under the web's key and read from there. With no
// value seen (signed out and never set here, load failed, storage blocked) it is off.
//
// When it is on, the recorder feeds the detector a level reading a few times a second for
// every captured track (microphone and call audio). Silence means ALL of them are quiet.
// After the chosen time minus a minute the recorder asks "Still there?" (a chime every 20
// seconds, a notification and the window title) and stops a minute later if nobody
// answers, exactly as if Stop had been pressed. Nothing is trimmed: every recorded part is
// kept, the quiet stretch included.
//
// What the detector is NOT trusted with: deciding that audio is worthless. It is known to
// call some real speech silence (a voice quieter than about -50 dBFS, or one not much
// louder than a steady fan), so the only thing it can do is ask, and stop if nobody answers.
//
//   * Silence is counted only where it was observed. Each reading adds at most MAX_GAP_MS
//     however long ago the previous one was, and readings are timed on the recording's own
//     clock (capture-clock.js), which stops while paused or asleep. Starved of readings the
//     detector under-counts and the recording keeps going; it never stops a meeting because
//     the computer was asleep. A pause is not silence.
//   * "Quiet" is relative to the room. The threshold follows each track's noise floor between
//     a lowest and a highest value, so a steadily loud room always counts as sound.
//   * A person answering "Keep recording" counts as sound.
//
// Pure apart from the timer in createSilenceWatch, which takes its timers and clocks as
// arguments so the tests can drive it. A plain script: index.html loads it before app.js
// (window.FnSilence) and the node tests require it.
'use strict'
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.FnSilence = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // 0 is "never stop", and it is the default on every client.
  const SILENCE_DEFAULT_MINUTES = 0
  const SILENCE_MAX_MINUTES = 120
  // The choices offered in the setting.
  const SILENCE_MINUTE_CHOICES = [0, 5, 10, 20]
  // The same key as the web recorder's copy.
  const SILENCE_MINUTES_STORAGE_KEY = 'forgenotes.record.silenceMinutes'

  // The countdown shown before the recording stops.
  const WARNING_LEAD_MS = 60 * 1000
  // How often the recorder reads the room.
  const TICK_MS = 250
  // While the question is up, a chime every this often.
  const CHIME_EVERY_MS = 20 * 1000
  // The chime comes out of the speakers and back in through the microphone (and, on
  // Windows, the call-audio loopback): readings are ignored for this long after one, so
  // the question cannot answer itself.
  const CHIME_DEAF_MS = 1500

  const WARNING_TITLE = 'Still there? Recording is about to stop'
  const NOTIFICATION_TITLE = 'Still there?'

  const WINDOW_SECONDS = 0.02
  const MIN_THRESHOLD = 0.003 // about -50 dBFS: below this nothing counts as sound
  const MAX_THRESHOLD = 0.012 // about -38 dBFS: above this everything counts as sound
  const FLOOR_FACTOR = 3
  const FLOOR_RISE_MS = 30 * 1000
  const MAX_GAP_MS = 3000

  // The stored setting, as the number of minutes to use. Unknown, unreadable or out of
  // range values are the default, which is off.
  function normalizeSilenceMinutes(value) {
    const minutes = Number(value)
    if (value === null || value === undefined || value === '' || !Number.isFinite(minutes)) return SILENCE_DEFAULT_MINUTES
    if (minutes < 0 || minutes > SILENCE_MAX_MINUTES) return SILENCE_DEFAULT_MINUTES
    return Math.round(minutes)
  }

  // Minutes -> the timings the recorder runs on. `enabled: false` means never ask, never stop.
  function silencePlan(minutes) {
    const stopAfterMs = Math.round(normalizeSilenceMinutes(minutes) * 60 * 1000)
    if (stopAfterMs <= 0) return { enabled: false, stopAfterMs: 0, warnLeadMs: 0 }
    return { enabled: true, stopAfterMs, warnLeadMs: Math.min(WARNING_LEAD_MS, Math.round(stopAfterMs / 2)) }
  }

  // Level of a stretch of audio samples (floats in -1..1), in 20 ms windows: `peak` is the
  // loudest window, `quiet` the quietest, `last` the most recent. A voice shows up in
  // `peak`; the room's steady noise shows up in `quiet`.
  function measureLevels(samples, sampleRate) {
    const size = Math.max(1, Math.round((sampleRate || 48000) * WINDOW_SECONDS))
    let peak = 0
    let quiet = Infinity
    let last = 0
    for (let start = 0; start + size <= samples.length; start += size) {
      let sum = 0
      for (let i = start; i < start + size; i++) sum += samples[i] * samples[i]
      last = Math.sqrt(sum / size)
      if (last > peak) peak = last
      if (last < quiet) quiet = last
    }
    if (quiet === Infinity) return { peak: 0, quiet: 0, last: 0 }
    return { peak, quiet, last }
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value))
  }

  function isLevel(value) {
    return Boolean(value) && (typeof value.peak === 'number' || typeof value.quiet === 'number')
  }

  // plan: from silencePlan(). Readings: push(atMs, levels), where levels is one track's
  // { peak, quiet } or one per captured track: { mic: { peak, quiet }, system: { ... } }.
  // A reading is sound when ANY track is at or above its own threshold, so silence means
  // every captured track is quiet.
  function createSilenceDetector(plan, options = {}) {
    const maxGapMs = options.maxGapMs ?? MAX_GAP_MS
    const floors = new Map() // track -> that track's steady noise level
    const state = {
      lastAt: null, // recording clock of the previous reading
      silentMs: 0, // observed silence since the last sound
      lastSoundAt: null, // recording clock of the last sound (or "keep recording")
      heard: false, // any sound at all since the start
    }

    function threshold(track) {
      return clamp((floors.get(track) ?? 0) * FLOOR_FACTOR, MIN_THRESHOLD, MAX_THRESHOLD)
    }

    function snapshot() {
      const enabled = Boolean(plan && plan.enabled)
      const untilStopMs = enabled ? Math.max(0, plan.stopAfterMs - state.silentMs) : Infinity
      let phase = 'ok'
      if (enabled && state.silentMs >= plan.stopAfterMs) phase = 'stop'
      else if (enabled && untilStopMs <= plan.warnLeadMs) phase = 'warning'
      const first = floors.keys().next()
      return {
        phase,
        silentMs: state.silentMs,
        secondsLeft: enabled ? Math.ceil(untilStopMs / 1000) : null,
        lastSoundAt: state.lastSoundAt,
        heard: state.heard,
        threshold: threshold(first.done ? 'room' : first.value),
      }
    }

    return {
      // One level reading at `atMs` on the recording clock. Returns the state plus `sound`:
      // whether this reading was sound.
      push(atMs, levels = {}) {
        const elapsed = state.lastAt === null ? 0 : Math.max(0, atMs - state.lastAt)
        state.lastAt = atMs
        const tracks = isLevel(levels) || !levels || !Object.keys(levels).length ? { room: levels || {} } : levels

        let sound = false
        for (const [track, level] of Object.entries(tracks)) {
          const peak = Number(level && level.peak) || 0
          const quiet = level && typeof level.quiet === 'number' ? level.quiet : peak
          // Follow the room: drop to a quieter level at once, drift up to a louder one
          // slowly, so a pause between sentences sets the floor and a sentence does not.
          const floor = floors.get(track)
          if (floor === undefined || quiet < floor) floors.set(track, quiet)
          else floors.set(track, floor + (quiet - floor) * Math.min(1, elapsed / FLOOR_RISE_MS))
          if (peak >= threshold(track)) sound = true
        }

        if (sound) {
          state.silentMs = 0
          state.lastSoundAt = atMs
          state.heard = true
        } else {
          state.silentMs += Math.min(elapsed, maxGapMs)
        }
        return { ...snapshot(), sound }
      },
      // Someone answered "keep recording": the same as hearing them.
      keepAlive(atMs) {
        state.silentMs = 0
        state.lastSoundAt = atMs
        state.heard = true
        state.lastAt = atMs
        return snapshot()
      },
      // Recording resumed after a pause or a sleep: the time in between is not silence.
      resume(atMs) {
        state.lastAt = atMs
      },
      state: snapshot,
    }
  }

  // "9 minutes", "1 minute", "45 seconds": for the sentences shown to people.
  function describeDuration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}`
  }

  // ---- what the person reads ---------------------------------------------------------

  function questionSentence(silentMs, secondsLeft) {
    return `Still there? It has been quiet for ${describeDuration(silentMs)}. Recording stops in ${secondsLeft} second${secondsLeft === 1 ? '' : 's'}.`
  }

  function notificationBody(plan) {
    return `ForgeNotes will stop recording in ${describeDuration(plan.warnLeadMs)} unless you choose Keep recording.`
  }

  // Left where the person will find it when they come back. The desktop app keeps every
  // recording on the device and uploads it only when asked (or with automatic upload on).
  // `place`: what the app calls the device ("this computer", "this Mac").
  function stoppedSentence(plan, { uploading = false, place = 'this computer' } = {}) {
    return `The recording stopped by itself because the room had been quiet for ${describeDuration(plan.stopAfterMs)} and nobody answered. ` +
      (uploading ? 'All of it is kept and uploaded.' : `All of it is kept on ${place}.`)
  }

  // ---- the setting ---------------------------------------------------------------------

  function readCachedSilenceMinutes(storage) {
    try {
      const raw = storage.getItem(SILENCE_MINUTES_STORAGE_KEY)
      return raw === null ? SILENCE_DEFAULT_MINUTES : normalizeSilenceMinutes(raw)
    } catch {
      return SILENCE_DEFAULT_MINUTES
    }
  }

  function cacheSilenceMinutes(minutes, storage) {
    try {
      storage.setItem(SILENCE_MINUTES_STORAGE_KEY, String(normalizeSilenceMinutes(minutes)))
    } catch { /* storage blocked: the value still applies until the app closes */ }
  }

  // The server's answer, as minutes.
  function silenceMinutesFrom(data) {
    return normalizeSilenceMinutes(data && data.silence_stop_minutes)
  }

  // The choices for the select. A value saved from another app that is not one of ours is
  // offered too, so opening the setting never changes it.
  function silenceOptions(current) {
    const values = SILENCE_MINUTE_CHOICES.includes(current) ? SILENCE_MINUTE_CHOICES : [...SILENCE_MINUTE_CHOICES, current].sort((a, b) => a - b)
    return values.map((minutes) => ({
      minutes,
      label: minutes === 0 ? 'Never' : `After ${describeDuration(minutes * 60000)} of silence`,
    }))
  }

  // What is said back after a change. `local`: not signed in, so it is kept on this device
  // only (`place`). `recording`: a recording is running, which keeps the setting it started with.
  function silenceSettingSentence(minutes, { local = false, recording = false, place = 'this computer' } = {}) {
    const saved = local ? `Saved on ${place}.` : 'Saved.'
    const what = minutes === 0
      ? 'Recordings keep going until you stop them.'
      : `A recording that hears nothing for ${describeDuration(minutes * 60000)} asks if you are still there, then stops if nobody answers.`
    return `${saved} ${what}${recording ? ' This applies from your next recording.' : ''}`
  }

  // ---- one recording's question ----------------------------------------------------------

  // Runs "Still there?" for one recording. Everything it touches is passed in:
  //   plan       silencePlan(minutes); a disabled plan never reads, asks or stops
  //   clock()    the recording clock in ms (stops while paused or asleep)
  //   wall()     Date.now(), for the chime interval
  //   read()     levels heard since the previous call, per track, or null for no new audio
  //   ask(s)     the question goes up      s: { silentMs, secondsLeft }
  //   update(s)  the countdown changed
  //   clear()    the question came down (sound, Keep recording, pause, stop)
  //   stop(s)    nobody answered: stop exactly as if Stop had been pressed
  //   chime()    play the chime
  //   setInterval / clearInterval: the timer (defaults to the global ones)
  function createSilenceWatch(options) {
    const plan = options.plan || silencePlan(0)
    const detector = createSilenceDetector(plan)
    const tickMs = options.tickMs ?? TICK_MS
    const chimeEveryMs = options.chimeEveryMs ?? CHIME_EVERY_MS
    const deafMs = options.deafMs ?? CHIME_DEAF_MS
    const setTimer = options.setInterval || ((fn, ms) => setInterval(fn, ms))
    const clearTimer = options.clearInterval || ((id) => clearInterval(id))
    const call = (fn, ...args) => { try { if (fn) fn(...args) } catch { /* the view must not break the recording */ } }

    let timer = null
    let asking = false
    let secondsLeft = null
    let deafUntil = -Infinity
    let lastChimeAt = 0
    let paused = false
    let done = false

    function chime() {
      lastChimeAt = options.wall()
      deafUntil = options.clock() + deafMs
      call(options.chime)
    }

    function endQuestion() {
      if (!asking) return
      asking = false
      secondsLeft = null
      call(options.clear)
    }

    function finish() {
      done = true
      if (timer !== null) clearTimer(timer)
      timer = null
    }

    function tick() {
      if (done || paused || !plan.enabled) return
      let levels = null
      try { levels = options.read() } catch { levels = null }
      if (!levels) return
      const now = options.clock()
      if (now < deafUntil) return
      const reading = detector.push(now, levels)
      if (reading.phase === 'stop') {
        finish()
        endQuestion()
        call(options.stop, reading)
        return
      }
      if (reading.phase === 'warning') {
        if (!asking) {
          asking = true
          secondsLeft = reading.secondsLeft
          chime()
          call(options.ask, { silentMs: reading.silentMs, secondsLeft: reading.secondsLeft })
          return
        }
        if (options.wall() - lastChimeAt >= chimeEveryMs) chime()
        if (secondsLeft !== reading.secondsLeft) {
          secondsLeft = reading.secondsLeft
          call(options.update, { silentMs: reading.silentMs, secondsLeft: reading.secondsLeft })
        }
      } else {
        endQuestion()
      }
    }

    return {
      plan,
      start() {
        if (!plan.enabled || done || timer !== null) return
        timer = setTimer(tick, tickMs)
      },
      tick,
      // "Keep recording": the person is there. It counts as sound and the clock starts again.
      keep() {
        if (done) return
        detector.keepAlive(options.clock())
        endQuestion()
      },
      // A pause is not silence: the question comes down and nothing is counted until resume.
      pause() {
        paused = true
        endQuestion()
      },
      // After a pause or a sleep: the time in between is not silence.
      resume() {
        paused = false
        detector.resume(options.clock())
      },
      dispose() {
        finish()
        endQuestion()
      },
      asking: () => asking,
      state: () => detector.state(),
    }
  }

  return {
    SILENCE_DEFAULT_MINUTES,
    SILENCE_MAX_MINUTES,
    SILENCE_MINUTE_CHOICES,
    SILENCE_MINUTES_STORAGE_KEY,
    WARNING_LEAD_MS,
    TICK_MS,
    CHIME_EVERY_MS,
    CHIME_DEAF_MS,
    WARNING_TITLE,
    NOTIFICATION_TITLE,
    normalizeSilenceMinutes,
    silencePlan,
    measureLevels,
    createSilenceDetector,
    describeDuration,
    questionSentence,
    notificationBody,
    stoppedSentence,
    readCachedSilenceMinutes,
    cacheSilenceMinutes,
    silenceMinutesFrom,
    silenceOptions,
    silenceSettingSentence,
    createSilenceWatch,
  }
})
