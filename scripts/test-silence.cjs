// Stop on silence: the same setting, timings and wording as the web recorder, every captured
// track has to be quiet, and the "Still there?" question and auto-stop run on time (fake timers).
const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
const silence = require('../renderer/silence')

const QUIET = { peak: 0.001, quiet: 0.0008 }
const DIGITAL_SILENCE = { peak: 0, quiet: 0 }
const SPEECH = { peak: 0.08, quiet: 0.001 }
const MINUTE = 60000

function feed(detector, level, fromMs, toMs, stepMs = 250) {
  let last = null
  for (let t = fromMs; t <= toMs; t += stepMs) last = detector.push(t, level)
  return last
}

function fakeStorage(initial = {}) {
  const data = { ...initial }
  return { getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value) }, data }
}

test('the setting is off by default, and off for anything unknown, unreadable or out of range', () => {
  assert.equal(silence.SILENCE_DEFAULT_MINUTES, 0)
  for (const value of [null, undefined, '', 'abc', -5, 500, NaN]) assert.equal(silence.normalizeSilenceMinutes(value), 0)
  assert.equal(silence.normalizeSilenceMinutes('20'), 20)
  assert.equal(silence.silenceMinutesFrom({ silence_stop_minutes: 10 }), 10)
  assert.equal(silence.silenceMinutesFrom(null), 0)
  assert.deepEqual(silence.silencePlan(10), { enabled: true, stopAfterMs: 600000, warnLeadMs: 60000 })
  assert.deepEqual(silence.silencePlan(1), { enabled: true, stopAfterMs: 60000, warnLeadMs: 30000 })
  assert.deepEqual(silence.silencePlan(0), { enabled: false, stopAfterMs: 0, warnLeadMs: 0 })
})

test('the last value seen is kept under the web recorder\'s key; with nothing kept, or storage blocked, it is off', () => {
  assert.equal(silence.SILENCE_MINUTES_STORAGE_KEY, 'forgenotes.record.silenceMinutes')
  const storage = fakeStorage()
  assert.equal(silence.readCachedSilenceMinutes(storage), 0)
  silence.cacheSilenceMinutes(20, storage)
  assert.equal(storage.data['forgenotes.record.silenceMinutes'], '20')
  assert.equal(silence.readCachedSilenceMinutes(storage), 20)
  const blocked = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(silence.readCachedSilenceMinutes(blocked), 0)
  assert.equal(silence.readCachedSilenceMinutes(null), 0)
  assert.doesNotThrow(() => silence.cacheSilenceMinutes(5, blocked))
})

test('offers Never, 5, 10 and 20 minutes, keeps a value another app saved, and says back what was saved', () => {
  assert.deepEqual(silence.silenceOptions(0).map((o) => o.label), ['Never', 'After 5 minutes of silence', 'After 10 minutes of silence', 'After 20 minutes of silence'])
  assert.deepEqual(silence.silenceOptions(30).map((o) => o.minutes), [0, 5, 10, 20, 30])
  assert.equal(silence.silenceSettingSentence(0), 'Saved. Recordings keep going until you stop them.')
  assert.equal(silence.silenceSettingSentence(10), 'Saved. A recording that hears nothing for 10 minutes asks if you are still there, then stops if nobody answers.')
  assert.equal(silence.silenceSettingSentence(5, { local: true, recording: true }),
    'Saved on this computer. A recording that hears nothing for 5 minutes asks if you are still there, then stops if nobody answers. This applies from your next recording.')
  assert.equal(silence.silenceSettingSentence(0, { local: true, place: 'this Mac' }), 'Saved on this Mac. Recordings keep going until you stop them.')
})

test('the question and the stop note use the web recorder\'s words', () => {
  assert.equal(silence.questionSentence(9 * MINUTE, 60), 'Still there? It has been quiet for 9 minutes. Recording stops in 60 seconds.')
  assert.equal(silence.questionSentence(9 * MINUTE + 59000, 1), 'Still there? It has been quiet for 10 minutes. Recording stops in 1 second.')
  assert.equal(silence.notificationBody(silence.silencePlan(10)), 'ForgeNotes will stop recording in 1 minute unless you choose Keep recording.')
  assert.equal(silence.WARNING_TITLE, 'Still there? Recording is about to stop')
  assert.equal(silence.stoppedSentence(silence.silencePlan(10), { uploading: true }),
    'The recording stopped by itself because the room had been quiet for 10 minutes and nobody answered. All of it is kept and uploaded.')
  assert.equal(silence.stoppedSentence(silence.silencePlan(10)),
    'The recording stopped by itself because the room had been quiet for 10 minutes and nobody answered. All of it is kept on this computer.')
  assert.equal(silence.stoppedSentence(silence.silencePlan(5), { place: 'this Mac' }),
    'The recording stopped by itself because the room had been quiet for 5 minutes and nobody answered. All of it is kept on this Mac.')
})

test('measureLevels finds the loudest and quietest 20 ms windows', () => {
  const samples = new Float32Array(100)
  for (let i = 40; i < 60; i++) samples[i] = i % 2 ? 0.5 : -0.5
  for (let i = 80; i < 100; i++) samples[i] = 0.1
  const levels = silence.measureLevels(samples, 1000)
  assert.ok(Math.abs(levels.peak - 0.5) < 1e-6)
  assert.equal(levels.quiet, 0)
  assert.ok(Math.abs(levels.last - 0.1) < 1e-6)
  assert.deepEqual(silence.measureLevels(new Float32Array(3), 48000), { peak: 0, quiet: 0, last: 0 })
})

test('the detector warns one minute before the threshold, counts down, then says stop', () => {
  const detector = silence.createSilenceDetector(silence.silencePlan(10))
  feed(detector, SPEECH, 0, 5000)
  let state = feed(detector, QUIET, 5250, 5000 + 8 * MINUTE)
  assert.equal(state.phase, 'ok')
  state = feed(detector, QUIET, 5250 + 8 * MINUTE, 5000 + 9 * MINUTE)
  assert.equal(state.phase, 'warning')
  assert.equal(state.secondsLeft, 60)
  state = feed(detector, QUIET, 5250 + 9 * MINUTE, 5000 + 10 * MINUTE)
  assert.equal(state.phase, 'stop')
})

test('silence means every captured track is quiet: call audio alone keeps the recording going', () => {
  const detector = silence.createSilenceDetector(silence.silencePlan(10))
  let state = feed(detector, { mic: QUIET, system: SPEECH }, 0, 30 * MINUTE)
  assert.equal(state.phase, 'ok')
  assert.equal(state.silentMs, 0)
  state = feed(detector, { mic: SPEECH, system: DIGITAL_SILENCE }, 30 * MINUTE, 60 * MINUTE)
  assert.equal(state.phase, 'ok')
  // Both quiet (the 24-hour recording: digital silence on both tracks): it counts.
  state = feed(detector, { mic: DIGITAL_SILENCE, system: DIGITAL_SILENCE }, 60 * MINUTE + 250, 69.5 * MINUTE)
  assert.equal(state.phase, 'warning')
  state = feed(detector, { mic: DIGITAL_SILENCE, system: DIGITAL_SILENCE }, 69.5 * MINUTE + 250, 70 * MINUTE + 250)
  assert.equal(state.phase, 'stop')
})

test('each track follows its own room: a steadily loud call track always counts as sound', () => {
  const detector = silence.createSilenceDetector(silence.silencePlan(5))
  const fan = { peak: 0.02, quiet: 0.02 } // above the highest threshold: always sound
  const state = feed(detector, { mic: DIGITAL_SILENCE, system: fan }, 0, 20 * MINUTE)
  assert.equal(state.phase, 'ok')
})

test('silence is counted only where it was observed: a sleeping or throttled app never stops a meeting', () => {
  const detector = silence.createSilenceDetector(silence.silencePlan(10))
  detector.push(0, QUIET)
  const state = detector.push(5 * 60 * MINUTE, QUIET) // one reading five hours later
  assert.equal(state.silentMs, 3000)
  assert.equal(state.phase, 'ok')
})

test('never asks or stops when the setting is off', () => {
  const detector = silence.createSilenceDetector(silence.silencePlan(0))
  const state = feed(detector, QUIET, 0, 3 * 60 * MINUTE, 1000)
  assert.equal(state.phase, 'ok')
  assert.equal(state.secondsLeft, null)
})

// ---- the question, on the clock -----------------------------------------------------

// A recording of `levels()` with a fake clock: the timers are node:test's mocked ones.
function harness({ minutes = 10, levels = () => ({ mic: DIGITAL_SILENCE, system: DIGITAL_SILENCE }) } = {}) {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 })
  const events = []
  let recordingMs = 0
  let pausedAt = null
  let pausedTotal = 0
  const clockNow = () => (pausedAt !== null ? pausedAt : Date.now() - pausedTotal)
  const watch = silence.createSilenceWatch({
    plan: silence.silencePlan(minutes),
    clock: () => { recordingMs = clockNow(); return recordingMs },
    wall: () => Date.now(),
    read: () => levels(clockNow()),
    ask: (s) => events.push({ at: Date.now(), type: 'ask', ...s }),
    update: (s) => events.push({ at: Date.now(), type: 'update', ...s }),
    clear: () => events.push({ at: Date.now(), type: 'clear' }),
    stop: (s) => events.push({ at: Date.now(), type: 'stop', silentMs: s.silentMs }),
    chime: () => events.push({ at: Date.now(), type: 'chime' }),
  })
  watch.start()
  const advance = (ms) => { for (let left = ms; left > 0; left -= 250) mock.timers.tick(Math.min(250, left)) }
  return {
    watch, events, advance,
    pause() { pausedAt = clockNow(); watch.pause() },
    resume() { pausedTotal = Date.now() - pausedAt; pausedAt = null; watch.resume() },
    of: (type) => events.filter((e) => e.type === type),
  }
}

test('asks "Still there?" a minute before the chosen time, chimes every 20 s, then stops exactly as Stop would', (t) => {
  t.after(() => mock.timers.reset())
  const h = harness({ minutes: 10 })
  h.advance(9 * MINUTE - 1000)
  assert.equal(h.of('ask').length, 0, 'nothing before nine minutes of quiet')
  h.advance(1500)
  const [ask] = h.of('ask')
  assert.ok(ask, 'asked at nine minutes')
  assert.ok(Math.abs(ask.at - 9 * MINUTE) <= 500, `asked at ${ask.at}`)
  assert.equal(ask.secondsLeft, 60)
  assert.equal(h.watch.asking(), true)

  h.advance(59 * 1000)
  const chimes = h.of('chime').map((e) => e.at)
  assert.equal(chimes.length, 3, 'a chime when asked, then every 20 seconds')
  assert.ok(chimes[1] - chimes[0] >= 20000 && chimes[1] - chimes[0] <= 20500)
  assert.ok(h.of('update').some((e) => e.secondsLeft === 30), 'the countdown is shown')
  assert.equal(h.of('stop').length, 0)

  h.advance(1500)
  const [stop] = h.of('stop')
  assert.ok(stop, 'stopped at ten minutes')
  assert.ok(Math.abs(stop.at - 10 * MINUTE) <= 1500, `stopped at ${stop.at}`)
  assert.equal(h.of('clear').length, 1, 'the question came down before the stop')
  h.advance(5 * MINUTE)
  assert.equal(h.of('stop').length, 1, 'stops once')
})

test('"Keep recording" counts as sound: the question comes down and the wait starts again', (t) => {
  t.after(() => mock.timers.reset())
  const h = harness({ minutes: 5 })
  h.advance(4 * MINUTE + 10000)
  assert.equal(h.of('ask').length, 1)
  h.watch.keep()
  assert.equal(h.watch.asking(), false)
  assert.equal(h.of('clear').length, 1)
  h.advance(4 * MINUTE - 2000)
  assert.equal(h.of('ask').length, 1, 'not asked again before another four minutes of quiet')
  h.advance(3000)
  assert.equal(h.of('ask').length, 2)
  assert.equal(h.of('stop').length, 0)
})

test('sound returning cancels the question', (t) => {
  t.after(() => mock.timers.reset())
  let talking = false
  const h = harness({ minutes: 5, levels: () => ({ mic: talking ? SPEECH : DIGITAL_SILENCE, system: DIGITAL_SILENCE }) })
  h.advance(4 * MINUTE + 5000)
  assert.equal(h.watch.asking(), true)
  talking = true
  h.advance(2000)
  assert.equal(h.watch.asking(), false)
  talking = false
  h.advance(2 * MINUTE)
  assert.equal(h.of('stop').length, 0)
})

test('the chime coming back in through the microphone does not answer the question', (t) => {
  t.after(() => mock.timers.reset())
  let lastChime = -Infinity
  // The room is silent except for the chime itself, heard for one second after each one.
  const h = harness({ minutes: 5, levels: () => (Date.now() - lastChime < 1000 ? { mic: SPEECH, system: SPEECH } : { mic: DIGITAL_SILENCE, system: DIGITAL_SILENCE }) })
  const realChime = h.events.push.bind(h.events)
  h.events.push = (e) => { if (e.type === 'chime') lastChime = Date.now(); return realChime(e) }
  h.advance(5 * MINUTE + 2000)
  assert.equal(h.of('ask').length, 1)
  assert.equal(h.of('clear').length, 1, 'only the stop took the question down')
  assert.equal(h.of('stop').length, 1)
})

test('a pause is not silence: the question comes down and the wait carries on after resume', (t) => {
  t.after(() => mock.timers.reset())
  const h = harness({ minutes: 5 })
  h.advance(4 * MINUTE + 5000)
  assert.equal(h.watch.asking(), true)
  h.pause()
  assert.equal(h.watch.asking(), false)
  h.advance(60 * MINUTE)
  assert.equal(h.of('stop').length, 0, 'an hour paused does not stop the recording')
  h.resume()
  h.advance(20000)
  assert.equal(h.watch.asking(), true, 'asked again: the quiet before the pause still counts')
  h.advance(40000)
  assert.equal(h.of('stop').length, 1)
})

test('with the setting off there is no timer at all', (t) => {
  t.after(() => mock.timers.reset())
  let reads = 0
  const h = harness({ minutes: 0, levels: () => { reads += 1; return { mic: DIGITAL_SILENCE } } })
  h.advance(3 * 60 * MINUTE)
  assert.equal(reads, 0)
  assert.equal(h.events.length, 0)
})

test('no audio readings (the audio clock is not moving): nothing is counted', (t) => {
  t.after(() => mock.timers.reset())
  const h = harness({ minutes: 5, levels: () => null })
  h.advance(30 * MINUTE)
  assert.equal(h.events.length, 0)
})
