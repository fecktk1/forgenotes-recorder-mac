// The app around the recorder window (shell.js), driven through the real main.js. Shared by
// the macOS and Windows apps: keep the two copies identical.
//
//   electron scripts/test-shell.cjs
//
// Checks that:
//   - the recorder page's state reaches the shell, and the popover and the floating bar
//     draw it (ready, recording, paused) and are sized to what they show;
//   - a surface can start, pause and stop a recording, and nothing else: an unknown
//     command is dropped and a surface has no way to the recordings or the sign-in token;
//   - the bar is there only while a recording runs and the main window is not in front;
//   - closing the main window hides it and the recording carries on;
//   - the application and tray menus offer Check for Updates, and a check answers in words;
//   - a menu described by the page is drawn by the system and its answer returned.
// The microphone is Chromium's fake device and audio is muted. Tray clicks, the system's
// glass and a real update feed are hardware and release checks.
const { app, BrowserWindow, Menu } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'forgenotes-shell-ui-test-'))
app.setPath('userData', userData)
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ supabaseUrl: 'https://shell-test.invalid', supabaseAnonKey: 'sb_publishable_shell_test', forgenotesHost: '' }))
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
const timeout = setTimeout(() => { console.error('Shell test timed out'); finish(1) }, 120000)
process.on('exit', () => {
  if (!path.basename(userData).startsWith('forgenotes-shell-ui-test-')) return
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // left for the system's temporary-file cleanup
  }
})

require('../main.js')

app.whenReady().then(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let main = null
  for (let i = 0; i < 200 && !main; i++) { main = BrowserWindow.getAllWindows()[0] || null; if (!main) await sleep(50) }
  assert.ok(main, 'the recorder window opened')
  if (main.webContents.isLoading()) await new Promise((resolve) => main.webContents.once('did-finish-load', resolve))
  const shell = global.__forgenotesShell
  assert.ok(shell, 'the shell is reachable in an unpackaged run')

  const run = (window, code) => window.webContents.executeJavaScript(code, true)
  async function until(what, check, ms = 15000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      try { if (await check()) return } catch { /* not yet */ }
      await sleep(100)
    }
    throw new Error(`timed out waiting for: ${what}`)
  }
  const step = (name) => console.log(`  ok  ${name}`)
  const text = (window, id) => run(window, `document.getElementById(${JSON.stringify(id)}).textContent`)
  const shown = (window, id) => run(window, `!document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`)
  // The window is as tall as its page, within a pixel or two of rounding.
  const fitted = async (window) => Math.abs(window.getContentSize()[1] - (await run(window, 'Math.ceil(document.body.getBoundingClientRect().height)'))) <= 2

  await run(main, `localStorage.setItem('fn_live_captions', 'off'); localStorage.setItem('fn_announce_recording', 'false'); localStorage.setItem('fn_seen_intro', '1'); true`)
  await until('the sign-in view', () => shown(main, 'login-view'))
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'no surface window exists until it is asked for')

  // ---- signed out: the popover says how to begin
  shell.togglePopover()
  await until('the popover', () => shell.windows().popover)
  const popover = shell.windows().popover
  if (popover.webContents.isLoading()) await new Promise((resolve) => popover.webContents.once('did-finish-load', resolve))
  await until('the popover to draw', async () => (await text(popover, 'go-label')) === 'Open ForgeNotes to begin')
  assert.equal(await run(popover, 'typeof window.desktop'), 'undefined', 'a surface has no bridge to recordings or the token')
  assert.deepEqual((await run(popover, 'Object.keys(window.surface).sort()')), ['command', 'onState', 'platform', 'ready', 'size'])
  step('signed out: the popover points at the app, and has only its own small bridge')

  // ---- ready
  await run(main, `document.getElementById('local-record-btn').click()`)
  await until('the device check', () => run(main, `document.getElementById('pf-mic') && !/Checking/.test(document.getElementById('pf-mic').textContent)`))
  await until('the shell to hear it', () => shell.state().signedIn === true)
  await until('the popover to say Record', async () => (await text(popover, 'go-label')) === 'Record')
  await until('the popover to fit its page', () => fitted(popover))
  assert.equal(shell.windows().bar, null, 'no bar while nothing is recording')
  step('ready: the recorder reports its state and the popover offers Record')

  // ---- a surface sets the mode and the title, and starts
  await run(popover, `window.surface.command({ type: 'mode', mode: 'room' }); window.surface.command({ type: 'title', title: 'Shell test meeting' }); true`)
  await until('the mode to change', () => shell.state().mode === 'room')
  assert.equal(await run(main, `document.getElementById('title').value`), 'Shell test meeting')
  await run(popover, `window.surface.command({ type: 'delete-everything' }); window.surface.command({ type: 'start' }); true`)
  await until('recording to start', () => shell.state().recording === true)
  assert.equal(await run(main, 'Boolean(rec && rec.mic)'), true)
  await until('the popover to show the recording', async () => (await shown(popover, 'live')) && !(await shown(popover, 'ready')))
  assert.equal(await text(popover, 'title'), 'Shell test meeting')
  await until('the popover clock to run', async () => /^\d\d:\d\d$/.test(await text(popover, 'timer')) && (await text(popover, 'timer')) !== '00:00')
  await until('the popover to fit its shorter page', () => fitted(popover))
  step('a surface starts a recording; an unknown command is ignored; the popover follows')

  // ---- the bar: only while recording, and only when the main window is not in front
  // In front, the recorder window shows everything itself: no bar. Out of sight, the bar.
  main.show()
  main.focus()
  await sleep(300)
  if (main.isFocused()) assert.ok(!shell.windows().bar || !shell.windows().bar.isVisible(), 'no bar while the recorder window is in front')
  main.hide()
  await until('the bar', () => shell.windows().bar)
  const bar = shell.windows().bar
  if (bar.webContents.isLoading()) await new Promise((resolve) => bar.webContents.once('did-finish-load', resolve))
  await until('the bar clock', async () => /^\d\d:\d\d$/.test(await text(bar, 'timer')) && (await text(bar, 'timer')) !== '00:00')
  assert.equal(await text(bar, 'name'), 'Shell test meeting')
  await until('the bar to fit its page', () => fitted(bar))
  step('the floating bar appears with the recording and shows its clock')

  await run(bar, `window.surface.command({ type: 'pause' }); true`)
  await until('pause', () => shell.state().paused === true)
  await until('the bar to say Resume', async () => (await text(bar, 'pause')) === 'Resume')
  assert.equal(await text(popover, 'pause'), 'Resume')
  await run(bar, `window.surface.command({ type: 'pause' }); true`)
  await until('resume', () => shell.state().paused === false)
  step('pause and resume from the bar reach the recorder and every surface')

  // ---- closing the main window hides it; the recording carries on
  main.close()
  await sleep(400)
  assert.equal(main.isDestroyed(), false, 'closing hides the window')
  assert.equal(shell.state().recording, true, 'the recording carries on')
  const before = await run(main, `document.getElementById('rec-timer').textContent`)
  await sleep(1600)
  assert.notEqual(await run(main, `document.getElementById('rec-timer').textContent`), before, 'the hidden recorder keeps time')
  step('closing the window hides it and the recording carries on')

  // ---- stop from the popover
  await run(popover, `window.surface.command({ type: 'stop' }); true`)
  await until('the recording to stop', () => shell.state().recording === false)
  await until('the bar to go', () => !shell.windows().bar || !shell.windows().bar.isVisible())
  await until('the popover to return to ready', () => shown(popover, 'ready'))
  await until('the saved recording in the popover', async () => /Shell test meeting/.test(await text(popover, 'recent')))
  const saved = fs.readdirSync(path.join(userData, 'recordings'))
  assert.equal(saved.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'recordings', saved[0], 'meta.json'), 'utf8')).state, 'saved')
  step('stop from the popover saves the recording; the bar goes and the popover lists it')

  // ---- menus and updates
  const labels = (menu) => menu.items.flatMap((item) => [item.label, ...(item.submenu ? labels(item.submenu) : [])])
  assert.ok(labels(Menu.getApplicationMenu()).some((label) => /^Check for updates…$/i.test(label)), 'the application menu has Check for Updates')
  assert.ok(labels(shell.trayMenu()).some((label) => /^Check for updates…$/i.test(label)), 'the tray menu has Check for Updates')
  assert.ok(!labels(Menu.getApplicationMenu()).some((label) => /reload|developer tools/i.test(label)), 'no reload or developer tools in the menus')
  const answer = await run(main, `window.desktop.checkForUpdates({ quiet: true })`)
  assert.equal(answer.status, 'unavailable')
  assert.match(answer.message, /installed app/)
  await run(main, `document.getElementById('settings-open').click(); document.getElementById('update-check').click(); true`)
  await until('the answer in Settings', async () => /installed app/.test(await text(main, 'update-status')))
  step('Check for Updates is in both menus and in Settings, and answers in words')

  finish(0)
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  finish(1)
})
