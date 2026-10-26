// The recording's clock (sleep and pauses are not audio) and the times a recording reports
// (started_at / ended_at), including a recording uploaded after the app restarted.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const clock = require('../renderer/capture-clock')
const { recordingStore } = require('../recording-store')

const T0 = Date.parse('2026-09-12T15:21:00.000Z')
const S = 1000
const MIN = 60 * S
const HOUR = 60 * MIN

// A heartbeat every 500 ms from `from` to `to` (inclusive), as the renderer runs it, with
// the audio clock (AudioContext currentTime in ms) moving with the wall clock: audio flowing.
const flowing = (t) => t - T0
function beats(c, from, to, step = 500, audio = flowing) {
  const found = []
  for (let t = from; t <= to; t += step) {
    const r = c.beat(t, audio(t))
    if (r.gapMs || r.woke) found.push({ at: t, ...r })
  }
  return found
}

test('without pauses or sleep the clock is the wall clock', () => {
  const c = clock.createCaptureClock(T0)
  beats(c, T0, T0 + 90 * S)
  assert.equal(c.elapsed(T0 + 90 * S), 90 * S)
})

test('a pause is not audio', () => {
  const c = clock.createCaptureClock(T0)
  c.pause(T0 + 10 * S)
  assert.equal(c.elapsed(T0 + 25 * S), 10 * S, 'frozen while paused')
  c.resume(T0 + 30 * S)
  assert.equal(c.elapsed(T0 + 40 * S), 20 * S)
})

test('sleep (powerMonitor suspend/resume) is left out: a one-minute segment that spans a night is one minute', () => {
  // Mac session 0ca7b2a4: a 60 s segment claimed 33,550 s because the Mac slept inside it.
  const c = clock.createCaptureClock(T0)
  beats(c, T0, T0 + 30 * S)
  const segmentStart = c.elapsed(T0)
  assert.equal(c.suspend(T0 + 30 * S), true)
  // The renderer freezes with the computer; its first heartbeat after waking sees the gap.
  const wakeAt = T0 + 30 * S + 9 * HOUR + 18 * MIN
  assert.equal(c.wake(wakeAt), true)
  assert.deepEqual(beats(c, wakeAt + 500, wakeAt + 30 * S), [], 'the known sleep is not found again as a gap')
  const atStop = c.elapsed(wakeAt + 30 * S)
  assert.equal(atStop - segmentStart, 60 * S)
  assert.equal(c.excludedMs(wakeAt + 30 * S), 9 * HOUR + 18 * MIN)
})

test('the segment ended at suspend keeps its length even when the encoder reports after waking', () => {
  const c = clock.createCaptureClock(T0)
  c.suspend(T0 + 42 * S)
  // Read the clock while still asleep and after the wake: both give 42 s.
  assert.equal(c.elapsed(T0 + 42 * S + 5 * HOUR), 42 * S)
  c.wake(T0 + 42 * S + 6 * HOUR)
  assert.equal(c.elapsed(T0 + 42 * S + 6 * HOUR), 42 * S)
})

test('a sleep whose events were missed is found by the heartbeat and left out once', () => {
  const c = clock.createCaptureClock(T0)
  beats(c, T0, T0 + 20 * S)
  const wokeAt = T0 + 20 * S + 2 * HOUR
  // Two hours with no timers and no audio: the audio clock is where it was.
  const found = c.beat(wokeAt, 20 * S)
  assert.equal(found.gapMs, 2 * HOUR)
  // One heartbeat interval (the allowance) is still counted; the rest is left out.
  assert.equal(c.elapsed(wokeAt), 20 * S + clock.BEAT_ALLOWANCE_MS)
  // The suspend arrives late (delivered after waking): it is news of the same sleep.
  assert.equal(c.suspend(T0 + 20 * S + 100), false)
  assert.equal(c.asleep(), false)
  assert.equal(c.wake(wokeAt + 50), false)
  assert.equal(c.elapsed(wokeAt + 10 * S), 30 * S + clock.BEAT_ALLOWANCE_MS)
})

test('a suspend and a heartbeat gap for the same sleep are not subtracted twice', () => {
  const c = clock.createCaptureClock(T0)
  beats(c, T0, T0 + 10 * S)
  c.suspend(T0 + 10 * S)
  const wakeAt = T0 + 10 * S + HOUR
  // The heartbeat runs before the resume event arrives: it ends the sleep itself.
  const found = c.beat(wakeAt + 200)
  assert.equal(found.woke, true)
  assert.equal(c.asleep(), false)
  assert.equal(c.wake(wakeAt), false, 'the late resume changes nothing')
  assert.equal(c.elapsed(wakeAt + 200 + 5 * S), 15 * S)
})

test('timers that keep running for a while after a suspend: there was no sleep, recording carries on', () => {
  const c = clock.createCaptureClock(T0)
  c.suspend(T0 + 5 * S)
  const found = beats(c, T0 + 5 * S, T0 + 5 * S + clock.SUSPEND_GRACE_MS + S)
  assert.equal(found.length, 1)
  assert.equal(found[0].woke, true)
  assert.equal(c.asleep(), false)
  // Nothing was recorded between the suspend and the restart, so that time is not audio.
  const restartedAt = found[0].at
  assert.equal(c.elapsed(restartedAt + 10 * S), 5 * S + 10 * S)
})

test('normal timer jitter is not a gap', () => {
  const c = clock.createCaptureClock(T0)
  c.beat(T0, 0)
  assert.deepEqual(c.beat(T0 + 4 * S, 0), {})
  assert.deepEqual(c.beat(T0 + 4 * S + clock.GAP_MS, 4 * S), {}, 'exactly GAP_MS is still running')
  assert.equal(c.elapsed(T0 + 4 * S + clock.GAP_MS), 4 * S + clock.GAP_MS)
})

test('late timers while audio keeps flowing are not a sleep (a busy renderer, macOS App Nap)', () => {
  const c = clock.createCaptureClock(T0)
  beats(c, T0, T0 + 20 * S)
  // 45 s without a heartbeat, but the audio clock moved 45 s: audio was being captured.
  assert.deepEqual(c.beat(T0 + 65 * S, 65 * S), {})
  assert.equal(c.elapsed(T0 + 65 * S), 65 * S)
})

test('only the part of a gap in which no audio flowed is left out', () => {
  const c = clock.createCaptureClock(T0)
  beats(c, T0, T0 + 20 * S)
  // Two minutes without timers; audio flowed for 30 s of them (before the computer slept).
  const found = c.beat(T0 + 20 * S + 2 * MIN, 50 * S)
  assert.equal(found.gapMs, 90 * S)
  assert.equal(c.elapsed(T0 + 20 * S + 2 * MIN), 50 * S + clock.BEAT_ALLOWANCE_MS)
})

test('without an audio clock a late timer is never taken for a sleep: only suspend/resume stop the clock', () => {
  const c = clock.createCaptureClock(T0)
  beats(c, T0, T0 + 20 * S, 500, () => undefined)
  assert.deepEqual(c.beat(T0 + 20 * S + HOUR), {})
  assert.equal(c.elapsed(T0 + 20 * S + HOUR), 20 * S + HOUR)
})

test('sleep during a pause is counted once', () => {
  const c = clock.createCaptureClock(T0)
  c.pause(T0 + 10 * S)
  c.suspend(T0 + 20 * S)
  c.wake(T0 + 2 * HOUR)
  c.resume(T0 + 2 * HOUR + 10 * S)
  assert.equal(c.elapsed(T0 + 2 * HOUR + 20 * S), 20 * S)
})

test('started_at and ended_at come from the recording, not the upload', () => {
  const meta = { startedAt: '2026-09-12T15:21:00.000Z', createdAt: '2026-09-12T15:21:00.000Z', endedAt: '2026-09-13T15:16:00.000Z' }
  assert.deepEqual(clock.createSessionTimes(meta, 'rec_1757690460000'), { started_at: '2026-09-12T15:21:00.000Z' })
  assert.deepEqual(clock.finalizeTimes(meta, 'rec_1757690460000'), { ended_at: '2026-09-13T15:16:00.000Z' })
})

test('a recording saved by an older build still sends its start: createdAt, else the local id', () => {
  assert.deepEqual(clock.createSessionTimes({ createdAt: '2026-09-12T15:21:00.000Z' }, 'rec_1757690460000'), { started_at: '2026-09-12T15:21:00.000Z' })
  assert.deepEqual(clock.createSessionTimes({}, `rec_${T0}`), { started_at: new Date(T0).toISOString() })
  assert.deepEqual(clock.createSessionTimes({ title: 'Interrupted recording — inspect saved files', state: 'damaged' }, 'something_else'), {}, 'unknown: the server decides')
  assert.deepEqual(clock.createSessionTimes({ startedAt: 'not a date' }, 'nope'), {})
})

test('the end of a recording cut off without Stop is its last checkpoint, or its newest file', () => {
  const started = '2026-09-12T15:21:00.000Z'
  assert.deepEqual(clock.finalizeTimes({ startedAt: started, checkpointedAt: '2026-09-12T16:00:00.000Z' }, 'x'), { ended_at: '2026-09-12T16:00:00.000Z' })
  const files = [{ writtenAt: '2026-09-12T15:30:00.000Z' }, { writtenAt: '2026-09-12T15:45:00.000Z' }, { writtenAt: 'garbage' }]
  assert.deepEqual(clock.finalizeTimes({ createdAt: started }, 'x', files), { ended_at: '2026-09-12T15:45:00.000Z' })
  // An end before the start (a clock that went backwards) is not sent.
  assert.deepEqual(clock.finalizeTimes({ startedAt: started, endedAt: '2026-09-12T15:00:00.000Z' }, 'x'), {})
  assert.deepEqual(clock.finalizeTimes({ startedAt: started }, 'x'), {})
})

test('the start and end are kept on disk: an upload after an app restart sends the original times', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forgenotes-times-test-'))
  try {
    const startedAt = T0
    const localId = `rec_${startedAt}`
    const meta = { title: 'Weekly sync', startedAt: new Date(startedAt).toISOString(), createdAt: new Date(startedAt).toISOString() }
    const segment = (track, seq) => ({ track, seq, startOffsetMs: seq * 60000, durationMs: 60000, data: new Uint8Array([1, 2, 3, seq]).buffer })
    const store = recordingStore(root)
    await store.checkpoint(localId, meta, segment('mic', 0))
    await store.checkpoint(localId, meta, segment('mic', 1))
    await store.finish(localId, { endedAt: '2026-09-12T15:23:05.000Z', stopReason: 'silence', sneaky: 'dropped' })

    // The app restarts; the upload (or its retry) reads only what is on disk.
    const { meta: saved, files } = await recordingStore(root).playback(localId)
    assert.equal(saved.state, 'saved')
    assert.equal(saved.stopReason, 'silence')
    assert.equal(saved.sneaky, undefined)
    assert.equal(saved.durationSec, 120)
    assert.deepEqual(clock.createSessionTimes(saved, localId), { started_at: '2026-09-12T15:21:00.000Z' })
    assert.deepEqual(clock.finalizeTimes(saved, localId, files), { ended_at: '2026-09-12T15:23:05.000Z' })

    // A recording cut off while recording (no Stop) ends at its last checkpoint.
    const cutId = `rec_${startedAt + 1}`
    await store.checkpoint(cutId, { ...meta, startedAt: new Date(startedAt + 1).toISOString() }, segment('mic', 0))
    const cut = await recordingStore(root).playback(cutId)
    assert.equal(cut.meta.state, 'recording')
    assert.ok(Date.parse(cut.meta.checkpointedAt) >= Date.now() - 60000)
    assert.deepEqual(clock.finalizeTimes(cut.meta, cutId, cut.files), { ended_at: cut.meta.checkpointedAt })
    assert.ok(cut.files.every((f) => typeof f.writtenAt === 'string'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
