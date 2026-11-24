// Playing a saved recording in the real recorder window. Shared by the macOS and Windows
// apps: keep the two copies identical.
//
//   electron scripts/test-playback.cjs
//
// Records a few seconds with Chromium's fake microphone, opens the saved recording and
// presses Play: the audio has to load and its clock has to move, Pause has to hold it, and
// choosing another recording has to stop it. Audio output is muted.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'forgenotes-playback-test-'))
app.setPath('userData', userData)
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ supabaseUrl: 'https://playback-test.invalid', supabaseAnonKey: 'sb_publishable_playback_test', forgenotesHost: '' }))
fs.writeFileSync(path.join(userData, 'tray-notice-shown'), '1')
process.env.FORGENOTES_FAKE_MACOS_VERSION = process.env.FORGENOTES_FAKE_MACOS_VERSION || '15.5'
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('mute-audio')
if (app.dock) app.dock.hide()
app.on('browser-window-created', (_event, window) => {
  window.hide()
  window.webContents.setBackgroundThrottling(false)
})

function finish(code) {
  clearTimeout(timeout)
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.exit(code)
}
const timeout = setTimeout(() => { console.error('Playback test timed out'); finish(1) }, 90000)
process.on('exit', () => {
  if (!path.basename(userData).startsWith('forgenotes-playback-test-')) return
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // left for the system's temporary-file cleanup
  }
})

require('../main.js')

app.whenReady().then(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let window = null
  for (let i = 0; i < 200 && !window; i++) { window = BrowserWindow.getAllWindows()[0] || null; if (!window) await sleep(50) }
  assert.ok(window, 'the recorder window opened')
  if (window.webContents.isLoading()) await new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
  const said = []
  window.webContents.on('console-message', (event) => { said.push(String(event.message || '')) })
  const js = (code) => window.webContents.executeJavaScript(code, true)
  async function until(what, code, ms = 15000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await js(`(() => { try { return ${code} } catch (e) { return false } })()`)) return
      await sleep(100)
    }
    throw new Error(`timed out waiting for: ${what}\nstatus: ${await js(`document.getElementById('status').textContent`)}\nconsole: ${said.slice(-6).join(' | ')}`)
  }
  const step = (name) => console.log(`  ok  ${name}`)
  const seconds = () => js(`(() => { const t = document.querySelector('#local-player .time'); const m = t && /^(\\d+):(\\d\\d)/.exec(t.textContent); return m ? Number(m[1]) * 60 + Number(m[2]) : -1 })()`)

  await js(`localStorage.setItem('fn_live_captions', 'off'); localStorage.setItem('fn_announce_recording', 'false'); localStorage.setItem('fn_seen_intro', '1'); localStorage.setItem('forgenotes_capture_profile', 'room_single_mic'); true`)
  window.webContents.reload()
  await new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
  await until('the sign-in view', `!document.getElementById('login-view').classList.contains('hidden')`)
  await js(`document.getElementById('local-record-btn').click()`)
  await until('the device check', `document.getElementById('pf-mic') && !/Checking/.test(document.getElementById('pf-mic').textContent)`)

  // Two short recordings.
  for (const title of ['First', 'Second']) {
    await js(`document.getElementById('new-rec').click(); document.getElementById('title').value = ${JSON.stringify(title)}; document.getElementById('start-btn').click()`)
    await until('recording to start', `rec && rec.mic && document.body.classList.contains('is-recording')`)
    await sleep(4200)
    await js(`document.getElementById('stop-btn').click()`)
    await until('recording to be saved', `!rec && !document.body.classList.contains('is-recording')`)
  }
  await until('both recordings in the list', `document.querySelectorAll('li[data-local-id]').length === 2`)

  // Open one and press Play, as a person does.
  await js(`[...document.querySelectorAll('li[data-local-id] .row')].find((r) => /First/.test(r.textContent)).click()`)
  await until('the recording to open', `document.body.dataset.view === 'detail' && document.querySelector('#local-player .play')`)
  assert.equal(await js(`document.querySelector('#local-player .play').disabled`), false, 'Play can be pressed')
  await js(`document.querySelector('#local-player .play').click()`)
  await until('the player to load the audio', `document.querySelector('#local-player select') && document.querySelector('#local-player .play').getAttribute('aria-label') === 'Pause'`)
  await until('the clock to move', `(() => { const m = /^(\\d+):(\\d\\d)/.exec(document.querySelector('#local-player .time').textContent); return m && Number(m[2]) >= 1 })()`, 12000)
  assert.equal(await js(`document.getElementById('status').classList.contains('hidden') || !/could not be played/.test(document.getElementById('status').textContent)`), true, 'no playback error is shown')
  step('Play loads the saved audio and its clock moves')

  await js(`document.querySelector('#local-player .play').click()`)
  await until('Pause', `document.querySelector('#local-player .play').getAttribute('aria-label') === 'Play'`)
  const held = await seconds()
  await sleep(1500)
  assert.equal(await seconds(), held, 'Pause holds the position')
  step('Pause holds the position')

  await js(`[...document.querySelectorAll('li[data-local-id] .row')].find((r) => /Second/.test(r.textContent)).click()`)
  await until('the other recording', `/Second/.test(document.getElementById('d-title').textContent)`)
  assert.equal(await js(`document.querySelector('#local-player select')`), null, 'the first recording stopped and the player is fresh')
  assert.equal(await js(`playingLocalId`), null)
  step('choosing another recording stops the one playing')

  finish(0)
}).catch((error) => {
  console.error(error && error.message ? error.message : error)
  finish(1)
})
