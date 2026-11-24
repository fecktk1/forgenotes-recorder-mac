// Layout guard for the real recorder window (main.js, preload.js, renderer/). Shared by the
// macOS and Windows apps: keep the two copies identical.
//
//   electron scripts/test-layout.cjs
//
// The window is narrow, and in 2026 it shipped with a recordings list whose four buttons
// squeezed each title to nothing and wrapped its facts one word to a line. This opens every
// view at the default size and at the smallest size the window allows, with awkward content
// (a very long title, a long account name, every kind of saved recording), and fails when:
//   - anything reaches past the window's edge, or the page scrolls sideways;
//   - a label, button, tab or fact takes more than one line, or spills out of its box;
//   - a title or name is squeezed below a readable width;
//   - the Record view, before or during a recording, needs scrolling at the default size.
// Nothing real is captured: the microphone is Chromium's fake device and audio is muted.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_SIZE = [480, 700] // WINDOW_DEFAULT in main.js
const MIN_SIZE = [440, 620] // WINDOW_MIN in main.js

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'forgenotes-layout-test-'))
app.setPath('userData', userData)
// A configured app with nobody signed in: the test records locally and calls no server.
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ supabaseUrl: 'https://layout-test.invalid', supabaseAnonKey: 'sb_publishable_layout_test', forgenotesHost: '' }))
// On a Mac, the call-audio path of a current macOS whatever this machine runs.
process.env.FORGENOTES_FAKE_MACOS_VERSION = process.env.FORGENOTES_FAKE_MACOS_VERSION || '15.5'
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('mute-audio')
if (app.dock) app.dock.hide()

// Saved recordings of every kind the list can show.
const day = 86400000
const seeds = [
  { id: 'rec_1001', meta: { title: 'Quarterly partnership planning sync with the resort operations and regional marketing teams', createdAt: new Date(Date.now() - 3600000).toISOString(), capture_profile: 'remote_dual_track', tracks: ['mic', 'system'], durationSec: 3184, state: 'saved', segments: [] } },
  { id: 'rec_1002', meta: { title: 'Weekly content planning', createdAt: new Date(Date.now() - day).toISOString(), capture_profile: 'remote_dual_track', tracks: ['mic', 'system'], durationSec: 2710, state: 'uploaded', segments: [] } },
  { id: 'rec_1003', meta: { title: '', createdAt: new Date(Date.now() - 9 * day).toISOString(), capture_profile: 'room_single_mic', tracks: ['mic'], durationSec: 7642, state: 'recording', segments: [] } },
  { id: 'rec_1004', meta: null }, // no readable meta.json: listed as damaged
]
for (const seed of seeds) {
  const dir = path.join(userData, 'recordings', seed.id)
  fs.mkdirSync(dir, { recursive: true })
  if (seed.meta) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(seed.meta))
}

app.on('browser-window-created', (_event, window) => {
  window.hide()
  window.webContents.setBackgroundThrottling(false)
})

function finish(code) {
  clearTimeout(timeout)
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.exit(code)
}
const timeout = setTimeout(() => { console.error('Layout test timed out'); finish(1) }, 120000)
process.on('exit', () => {
  if (!path.basename(userData).startsWith('forgenotes-layout-test-')) return
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // left for the system's temporary-file cleanup
  }
})

require('../main.js')

// Runs in the page. Returns what is wrong with what is on screen now.
function probe(noScroll) {
  const problems = []
  const root = document.documentElement
  const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''} "${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48)}"`
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const lines = (el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top / 4))).size
  }
  if (root.scrollWidth > root.clientWidth) problems.push(`the page scrolls sideways by ${root.scrollWidth - root.clientWidth}px`)
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') || el.tagName === 'OPTION' || el.tagName === 'OPTGROUP' || el.tagName === 'SCRIPT' || !shown(el)) continue
    const box = el.getBoundingClientRect()
    if (box.width && (box.right > root.clientWidth + 0.5 || box.left < -0.5)) problems.push(`reaches past the window: ${name(el)}`)
  }
  const oneLine = '.btn, .tab, .mode-option, .field > span, .line .k, .line .v, .st, .s, .t, .cap, .set .txt b, .set .txt span, .group h3, #mode-hint, #consent-copy, .live-title, .live-badge, .time, .head-title, .brand-ver, .update-flag, #now-title, #now-sub, .menu button, .checkbox span'
  for (const el of document.querySelectorAll(oneLine)) {
    if (!shown(el) || !el.textContent.trim()) continue
    if (lines(el) > 1) problems.push(`wraps onto ${lines(el)} lines: ${name(el)}`)
    const style = getComputedStyle(el)
    if (style.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1 && style.display !== 'inline') problems.push(`spills out of its box: ${name(el)}`)
  }
  for (const el of document.querySelectorAll('.t, .s, #now-title, #account-email, #details-summary')) {
    if (shown(el) && el.textContent.trim() && el.clientWidth < 90) problems.push(`squeezed to ${el.clientWidth}px: ${name(el)}`)
  }
  if (noScroll) {
    const view = document.querySelector(`#view-${document.body.dataset.view}`)
    if (view.scrollHeight > view.clientHeight) problems.push(`the ${document.body.dataset.view} view needs ${view.scrollHeight - view.clientHeight}px of scrolling`)
  }
  return problems
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
    while (Date.now() < deadline) {
      if (await js(`(() => { try { return ${code} } catch (e) { return false } })()`)) return
      await sleep(100)
    }
    throw new Error(`timed out waiting for: ${what}`)
  }
  const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`)
  const exists = (id) => js(`Boolean(document.getElementById(${JSON.stringify(id)}))`)

  assert.deepEqual(window.getContentSize(), DEFAULT_SIZE, 'the window opens at the default size')

  const failures = []
  let checked = 0
  // Measures what is showing at both sizes. noScroll: must fit the default size without scrolling.
  async function check(what, { noScroll = false } = {}) {
    for (const [width, height] of [DEFAULT_SIZE, MIN_SIZE]) {
      window.setContentSize(width, height)
      await until(`the page to be ${width} wide`, `window.innerWidth === ${width} && window.innerHeight === ${height}`)
      await sleep(120)
      const isDefault = width === DEFAULT_SIZE[0]
      const problems = await js(`(${probe.toString()})(${noScroll && isDefault})`)
      checked += 1
      // FORGENOTES_LAYOUT_SHOTS=<folder> keeps a picture of every view measured.
      if (process.env.FORGENOTES_LAYOUT_SHOTS) {
        fs.mkdirSync(process.env.FORGENOTES_LAYOUT_SHOTS, { recursive: true })
        const image = await window.webContents.capturePage()
        fs.writeFileSync(path.join(process.env.FORGENOTES_LAYOUT_SHOTS, `${String(checked).padStart(2, '0')}-${what.replace(/[^a-z0-9]+/gi, '-')}-${width}x${height}.png`), image.toPNG())
      }
      for (const problem of problems) failures.push(`${what} at ${width}x${height}: ${problem}`)
      console.log(`  ${problems.length ? 'FAIL' : 'ok  '}  ${what} at ${width}x${height}`)
    }
    window.setContentSize(...DEFAULT_SIZE)
  }

  await until('the sign-in view', `!document.getElementById('login-view').classList.contains('hidden')`)
  await js(`localStorage.setItem('fn_live_captions', 'off'); localStorage.setItem('fn_announce_recording', 'false'); true`)
  await check('sign in')

  await click('local-record-btn')
  await until('the device check', `document.getElementById('pf-mic') && !/Checking/.test(document.getElementById('pf-mic').textContent)`)
  if (await exists('first-run')) {
    if (await js(`!document.getElementById('first-run').classList.contains('hidden')`)) {
      await check('first run')
      await click('first-run-dismiss')
    }
  }
  // Online call fits when nothing needs attention. (An older Mac's BlackHole fields and an
  // open device check are extra rows by design; a Windows or Linux host gives the macOS app both.)
  const plain = await js(`!document.getElementById('preflight').classList.contains('open') && !(document.getElementById('blackhole-fields') && document.getElementById('blackhole-fields').getClientRects().length)`)
  await check('record, online call', { noScroll: plain })
  await click('details-toggle')
  await check('record, details open')
  await click('details-toggle')
  await click('mode-room')
  await until('the room device check', `!/Checking/.test(document.getElementById('preflight-results').textContent)`)
  await check('record, in person', { noScroll: true })
  // The device check opened, as it is when something needs attention.
  await click('pf-toggle')
  await check('record, device check open')
  await click('pf-toggle')

  await click('tab-recordings')
  await until('the saved recordings', `document.querySelectorAll('.pending-item').length === ${seeds.length}`)
  assert.equal(await js(`document.getElementById('pending-count').textContent`), String(seeds.length))
  await check('recordings')
  await js(`document.querySelector('.pending-item .icon-btn').click()`)
  await until('the more menu', `document.querySelector('.menu')`)
  await check('recordings, menu open')
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  // A title must keep most of the row, and its facts one line: the 2026 fault.
  const row = await js(`(() => { const li = document.querySelector('.pending-item'); return { title: li.querySelector('.t').clientWidth, row: li.clientWidth, height: li.offsetHeight } })()`)
  assert.ok(row.title > row.row * 0.9, `a recording's title has the row's width (${row.title} of ${row.row}px)`)
  assert.ok(row.height < 110, `a recording's row is compact (${row.height}px)`)

  await click('settings-open')
  await js(`document.getElementById('account-email').textContent = 'a.very.long.account.name.for.testing@a-long-company-domain.thecontentforge.io'; true`)
  await check('settings')
  await click('settings-close')
  assert.equal(await js('document.body.dataset.view'), 'recordings', 'Settings returns to the tab it was opened from')

  // During a recording, with a title far longer than the window.
  await click('tab-record')
  await js(`document.getElementById('title').value = 'Quarterly partnership planning sync with the resort operations and regional marketing teams'; true`)
  await click('start-btn')
  await until('recording to start', `rec && rec.mic && document.body.classList.contains('is-recording')`)
  await check('recording', { noScroll: true })
  await click('stop-btn')
  await until('recording to be saved', `!rec && !document.body.classList.contains('is-recording')`)
  await check('record, after a recording')

  assert.deepEqual(failures, [], `layout problems:\n  ${failures.join('\n  ')}`)
  console.log(`Layout test passed: ${checked} measurements, nothing wraps, spills or scrolls sideways.`)
  finish(0)
}).catch((error) => {
  console.error(error && error.message ? error.message : error)
  finish(1)
})
