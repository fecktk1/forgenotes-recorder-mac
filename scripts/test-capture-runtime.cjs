// Runtime test of the real app (main.js and the renderer) with a fake, digitally silent
// microphone and a throwaway userData folder. In room mode, with stop on silence set to one
// minute (the shortest the setting allows):
//   - a sleep, sent the way main.js forwards powerMonitor (power:state suspend, then resume
//     three seconds later), ends the segment and is left out of the recording's length;
//   - a renderer blocked for 12 s while audio flows is not taken for a sleep;
//   - "Still there?" goes up after 30 s of quiet, with the sentence, the window title and the
//     notification request to main;
//   - nobody answers, so the recording stops itself after 60 s of quiet and says why;
//   - meta.json keeps the true start and end (sent later as started_at / ended_at) and segment
//     durations that add up to the audio, not to the wall clock.
// Notifications are intercepted here (no toast is shown) and audio output is muted.
// Physical devices, BlackHole, a real sleep and the system notification remain hardware QA
// checks on a Mac. The test itself is not macOS-specific and also runs on the Windows binary.
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// A fixed throwaway folder, emptied at the start of each run (Chromium keeps files in it open
// until the process exits).
const userData = path.join(os.tmpdir(), 'forgenotes-mac-capture-test')
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
// No account and no server: the test records locally, like "Record locally without signing in".
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ supabaseUrl: '', supabaseAnonKey: '', forgenotesHost: '' }))

// One second of 48 kHz mono 16-bit zeros, looped by Chromium as the microphone.
function silentWav(file) {
  const rate = 48000
  const data = Buffer.alloc(rate * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([header, data]))
}
const wav = path.join(userData, 'silence.wav')
silentWav(wav)
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav)
app.commandLine.appendSwitch('mute-audio')

const timeout = setTimeout(() => {
  console.error('Capture runtime test timed out')
  app.exit(1)
}, 180000)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function firstWindow() {
  for (let i = 0; i < 100; i++) {
    const [win] = BrowserWindow.getAllWindows()
    if (win) return win
    await delay(50)
  }
  throw new Error('main.js did not open a window')
}

async function loaded(win) {
  if (!win.webContents.isLoading()) return
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
}

async function until(label, check, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(200)
  }
}

require('../main.js')

app
  .whenReady()
  .then(async () => {
    // Stand in for the system notification: record what the renderer asked main to show.
    const asked = []
    let cleared = 0
    ipcMain.removeHandler('silence:ask')
    ipcMain.removeHandler('silence:clear')
    ipcMain.handle('silence:ask', (_e, payload) => { asked.push(payload); return true })
    ipcMain.handle('silence:clear', () => { cleared += 1; return true })

    const win = await firstWindow()
    await loaded(win)
    const run = (js) => win.webContents.executeJavaScript(js, true)
    const visible = (id) => run(`!document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`)

    // The person chose "after 1 minute" earlier (the cached account value), records in a
    // room, and has the spoken announcement and live captions off.
    await run(`localStorage.setItem('forgenotes.record.silenceMinutes', '1');
      localStorage.setItem('forgenotes_capture_profile', 'room_single_mic');
      localStorage.setItem('fn_announce_recording', 'false');
      localStorage.setItem('fn_live_captions', 'off'); localStorage.setItem('fn_seen_intro', '1'); true`)
    win.webContents.reload()
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
    assert.equal(await run(`document.getElementById('silence-minutes').value`), '1', 'the setting shows the last value seen')

    await run(`document.getElementById('local-record-btn').click(); true`)
    await until('the recorder view', () => visible('recorder-view'), 10000)
    await until('the device check', () => run(`document.getElementById('pf-mic')?.classList.contains('ok')`), 10000)

    const startedAt = Date.now()
    await run(`document.getElementById('start-btn').click(); true`)
    await until('recording to start', () => visible('stop-btn'), 10000)

    // A sleep: main.js sends power:state with the time each powerMonitor event fired.
    await delay(4000)
    win.webContents.send('power:state', { state: 'suspend', at: Date.now() })
    await delay(3000)
    win.webContents.send('power:state', { state: 'resume', at: Date.now() })

    // A renderer that is busy (or throttled) for 12 s while audio keeps flowing is not asleep:
    // the heartbeat sees the gap, the audio clock shows audio flowed, and nothing is left out.
    // (Readings stop meanwhile, so the quiet is under-counted and the question comes later.)
    await delay(1000)
    await run('(() => { const end = Date.now() + 12000; while (Date.now() < end) {} return true })()')

    // "Still there?" after 30 s of quiet on the recording clock (the sleep is not quiet).
    await until('the question', () => visible('silence-question'), 60000)
    const askedAt = Date.now()
    const question = await run(`document.getElementById('silence-question-text').textContent`)
    assert.match(question, /^Still there\? It has been quiet for \d+ seconds\. Recording stops in \d+ seconds?\.$/)
    assert.equal(await run('document.title'), 'Still there? Recording is about to stop')
    assert.equal(asked.length, 1, 'main was asked for one notification')
    assert.equal(asked[0].body, 'ForgeNotes will stop recording in 30 seconds unless you choose Keep recording.')
    assert.ok(askedAt - startedAt >= 32000, `asked ${askedAt - startedAt} ms after Start: the 3 s sleep must not count as quiet`)

    // Nobody answers.
    await until('the recording to stop itself', () => visible('stop-note'), 60000)
    const stoppedAt = Date.now()
    assert.equal(await run(`document.getElementById('stop-note').textContent`),
      'The recording stopped by itself because the room had been quiet for 1 minute and nobody answered. All of it is kept on this Mac.')
    assert.equal(await visible('silence-question'), false)
    assert.equal(await run('document.title'), 'ForgeNotes Recorder', 'the title is put back')
    assert.ok(cleared >= 1, 'main was told to take the notification down')
    assert.ok(stoppedAt - askedAt >= 28000 && stoppedAt - askedAt <= 36000, `stopped ${stoppedAt - askedAt} ms after asking`)

    // What was saved, and what an upload would send.
    const recordings = path.join(userData, 'recordings')
    const meta = await until('the saved recording', () => {
      const [dir] = fs.existsSync(recordings) ? fs.readdirSync(recordings) : []
      if (!dir) return null
      const saved = JSON.parse(fs.readFileSync(path.join(recordings, dir, 'meta.json'), 'utf8'))
      return saved.state === 'saved' ? { ...saved, localId: dir } : null
    }, 20000)
    assert.equal(meta.stopReason, 'silence')
    assert.equal(meta.capture_profile, 'room_single_mic')
    assert.deepEqual(meta.tracks, ['mic'])
    const metaStart = Date.parse(meta.startedAt)
    const metaEnd = Date.parse(meta.endedAt)
    assert.ok(Math.abs(metaStart - startedAt) < 3000, 'startedAt is when Start was pressed')
    assert.ok(Math.abs(metaEnd - stoppedAt) < 3000, 'endedAt is when the recording stopped')

    const segments = meta.segments.filter((s) => s.track === 'mic').sort((a, b) => a.seq - b.seq)
    assert.ok(segments.length >= 2, 'the sleep ended a segment and a new one started')
    assert.ok(Math.abs(segments[0].durationMs - 4000) < 1500, `the segment before the sleep is about 4 s (${segments[0].durationMs} ms)`)
    for (let i = 1; i < segments.length; i++) {
      const gap = segments[i].startOffsetMs - (segments[i - 1].startOffsetMs + segments[i - 1].durationMs)
      assert.ok(Math.abs(gap) < 500, `segments follow each other on the recording clock (gap ${gap} ms)`)
    }
    const audioMs = segments.reduce((sum, s) => sum + s.durationMs, 0)
    const wallMs = metaEnd - metaStart
    assert.ok(audioMs > 58000 && audioMs < 75000, `a minute of quiet plus what the busy renderer did not read (${audioMs} ms)`)
    assert.ok(wallMs - audioMs > 2000 && wallMs - audioMs < 6000, `only the 3 s sleep is left out, not the busy 12 s (wall ${wallMs} ms, audio ${audioMs} ms)`)
    assert.ok(Math.abs(meta.durationSec - audioMs / 1000) <= 1.5, 'durationSec (sent as duration_seconds) is the audio')

    const log = fs.readFileSync(path.join(userData, 'upload-log.txt'), 'utf8')
    assert.match(log, /Mac going to sleep/)
    assert.match(log, /Mac woke up/)
    assert.doesNotMatch(log, /with no timers/, 'no false sleep found by the heartbeat')

    console.log(JSON.stringify({
      electron: process.versions.electron,
      platform: process.platform,
      askedAfterMs: askedAt - startedAt,
      stoppedAfterAskMs: stoppedAt - askedAt,
      segments: segments.map((s) => ({ seq: s.seq, startOffsetMs: s.startOffsetMs, durationMs: s.durationMs })),
      audioMs,
      wallMs,
      ok: true,
    }))
    clearTimeout(timeout)
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  })
