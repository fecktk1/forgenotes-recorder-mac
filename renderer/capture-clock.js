// The recording's own clock, and the times a recording reports to the server.
//
// Two things a desktop recording has to get right, and that the wall clock gets wrong:
//
//   * When it started. A recording is saved on this computer and uploaded after Stop, or
//     days later after a restart, so "now" at upload time is not when the meeting began.
//     The start is kept with the local recording (meta.json: startedAt) and sent to
//     forgenotes-create-session as started_at; the end (meta.json: endedAt) is sent to
//     forgenotes-finalize-session as ended_at. Without them the server dates the meeting
//     by the upload: a recording started 12 Sep 15:21 UTC showed as starting 13 Sep 15:16.
//   * How much audio it holds. Nothing is captured while the computer sleeps, but
//     Date.now() keeps going: measured by the wall clock, a one-minute segment that
//     spanned a night claimed 33,550 seconds (Mac session 0ca7b2a4). This clock stops
//     while the recording is paused and while the computer is asleep, so segment offsets,
//     segment durations and the meeting's length count only time in which audio was
//     being captured.
//
// Sleep is known two ways. The main process forwards Electron's powerMonitor suspend and
// resume with the times they fired (suspend / wake). Because a suspend can be missed or
// arrive late, the renderer's heartbeat (beat) also notices when its own timers did not
// run for longer than GAP_MS AND the audio clock (the AudioContext's currentTime, which
// advances only while audio is flowing) did not move either: the computer was asleep, so
// nothing was captured. Timers that were merely late (a busy or throttled renderer, macOS
// App Nap) while audio kept flowing are not a gap. Both become intervals left out of the
// clock, merged, so a sleep seen both ways is subtracted once.
//
// Pure: no timers, no DOM, no Electron. A plain script: index.html loads it before app.js
// (window.FnCaptureClock) and the node tests require it.
'use strict'
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.FnCaptureClock = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // A heartbeat that did not run for this long means the process was frozen (asleep).
  const GAP_MS = 10 * 1000
  // Of such a gap, this much is only a late timer and is still counted as recorded.
  const BEAT_ALLOWANCE_MS = 1000
  // A suspend with no wake that is followed by this long of normal heartbeats: the computer
  // did not go to sleep after all (or the resume was lost), and every second of waiting is
  // audio not recorded. The recording carries on; if the computer does sleep later, the
  // heartbeat finds that gap. (An operating system sleeps within a couple of seconds of
  // announcing it.)
  const SUSPEND_GRACE_MS = 5 * 1000

  // Total length of the union of [from, to] intervals.
  function unionLength(intervals) {
    const list = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
    let total = 0
    let from = null
    let to = null
    for (const [a, b] of list) {
      if (to === null || a > to) {
        if (to !== null) total += to - from
        from = a
        to = b
      } else if (b > to) {
        to = b
      }
    }
    if (to !== null) total += to - from
    return total
  }

  // startedAt: Date.now() when capture began. Every other time is a Date.now() too.
  function createCaptureClock(startedAt, options = {}) {
    const gapMs = options.gapMs ?? GAP_MS
    const allowanceMs = options.allowanceMs ?? BEAT_ALLOWANCE_MS
    const graceMs = options.suspendGraceMs ?? SUSPEND_GRACE_MS
    const closed = [] // wall-clock intervals in which nothing was captured
    let pausedAt = null // a pause in progress
    let suspendedAt = null // the computer said it is going to sleep, and has not woken yet
    let lastBeat = startedAt
    let lastAudio = null // the audio clock at the previous heartbeat, when there is one
    let lastGapEnd = null // the end of the latest gap the heartbeat found

    function exclude(from, to) {
      if (to > from) closed.push([from, to])
    }

    function excludedMs(now) {
      const open = []
      if (pausedAt !== null) open.push([pausedAt, now])
      if (suspendedAt !== null) open.push([suspendedAt, now])
      return unionLength([...closed, ...open].map(([a, b]) => [Math.max(a, startedAt), Math.min(b, now)]))
    }

    function wake(at) {
      if (suspendedAt === null) return false
      exclude(suspendedAt, Math.max(suspendedAt, at))
      suspendedAt = null
      lastBeat = Math.max(lastBeat, at)
      return true
    }

    return {
      startedAt,
      // Milliseconds of capture between startedAt and `now`.
      elapsed(now) {
        return Math.max(0, now - startedAt - excludedMs(now))
      },
      excludedMs,
      pause(at) {
        if (pausedAt === null) pausedAt = at
      },
      resume(at) {
        if (pausedAt === null) return
        exclude(pausedAt, Math.max(pausedAt, at))
        pausedAt = null
        lastBeat = Math.max(lastBeat, at)
      },
      // powerMonitor 'suspend', with the time it fired. False when it changes nothing: a
      // sleep is already in progress, or this suspend is news of a sleep the heartbeat has
      // already found and left out (the event was delivered after the computer woke).
      suspend(at) {
        if (suspendedAt !== null) return false
        if (lastGapEnd !== null && at <= lastGapEnd) return false
        suspendedAt = Math.max(startedAt, at)
        return true
      },
      // powerMonitor 'resume'. True when this ended a sleep the clock knew about.
      wake,
      paused: () => pausedAt !== null,
      asleep: () => suspendedAt !== null,
      // Called by a timer that runs about every second, with the audio clock in ms (the
      // AudioContext's currentTime * 1000) when there is one. Answers what it found:
      //   { gapMs }  this long passed with neither timers nor audio: left out
      //   { woke }   a suspend is over (the gap after it, or a sleep that never came)
      //   {}         nothing
      // Without an audio clock only a suspend/resume can stop the clock: a late timer alone
      // is never taken for a sleep.
      beat(now, audioMs) {
        const gap = now - lastBeat
        const audioKnown = Number.isFinite(audioMs) && lastAudio !== null
        const audioGap = audioKnown ? Math.max(0, audioMs - lastAudio) : null
        lastBeat = Math.max(lastBeat, now)
        if (Number.isFinite(audioMs)) lastAudio = audioMs
        if (suspendedAt !== null) {
          // The process froze and has come back, so the computer slept and woke even though
          // no resume has arrived (yet): the sleep ends now.
          if (gap > gapMs) return { woke: wake(now) }
          // Running normally for a while after a suspend: there was no sleep, or its resume
          // was lost. Nothing was recorded meanwhile (the segment ended at suspend), so the
          // interval stays out of the clock and recording carries on.
          if (now - suspendedAt > graceMs) return { woke: wake(now) }
          return {}
        }
        if (gap > gapMs && audioKnown) {
          // The part of the gap in which no audio flowed either.
          const silentGap = gap - audioGap
          if (silentGap > gapMs) {
            exclude(now - silentGap + allowanceMs, now)
            lastGapEnd = now
            return { gapMs: silentGap }
          }
        }
        return {}
      },
    }
  }

  // ---- the times a recording reports ------------------------------------------------

  const LOCAL_ID_STARTED = /^rec_(\d{12,14})$/

  function isoOrNull(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
    const date = new Date(typeof value === 'number' ? value : String(value))
    const time = date.getTime()
    if (!Number.isFinite(time) || time <= 0) return null
    return date.toISOString()
  }

  // When the recording began: meta.startedAt (written at Start), else meta.createdAt (the
  // same instant, written by builds before startedAt existed), else the time in the local
  // id (rec_<Date.now() at Start>). Null when none of them is a date.
  function recordingStartedAt(meta, localId) {
    const fromMeta = isoOrNull(meta && meta.startedAt) || isoOrNull(meta && meta.createdAt)
    if (fromMeta) return fromMeta
    const match = LOCAL_ID_STARTED.exec(String(localId || ''))
    return match ? isoOrNull(Number(match[1])) : null
  }

  // When it ended: Stop (meta.endedAt). A recording cut off by a crash or power loss has
  // no Stop; its end is when its last segment reached the disk (meta.checkpointedAt, or for
  // builds that did not write it, the newest segment file's time). Null when unknown or
  // earlier than the start, and then the server uses the time of finalize, as before.
  function recordingEndedAt(meta, localId, files) {
    const started = recordingStartedAt(meta, localId)
    let ended = isoOrNull(meta && meta.endedAt) || isoOrNull(meta && meta.checkpointedAt)
    if (!ended && Array.isArray(files)) {
      const written = files.map((f) => Date.parse(f && f.writtenAt)).filter(Number.isFinite)
      if (written.length) ended = isoOrNull(Math.max(...written))
    }
    if (!ended) return null
    if (started && Date.parse(ended) < Date.parse(started)) return null
    return ended
  }

  // Fields for forgenotes-create-session: started_at whenever the start is known.
  function createSessionTimes(meta, localId) {
    const started = recordingStartedAt(meta, localId)
    return started ? { started_at: started } : {}
  }

  // Fields for forgenotes-finalize-session: ended_at whenever the end is known.
  function finalizeTimes(meta, localId, files) {
    const ended = recordingEndedAt(meta, localId, files)
    return ended ? { ended_at: ended } : {}
  }

  return {
    GAP_MS,
    BEAT_ALLOWANCE_MS,
    SUSPEND_GRACE_MS,
    createCaptureClock,
    unionLength,
    recordingStartedAt,
    recordingEndedAt,
    createSessionTimes,
    finalizeTimes,
  }
})
