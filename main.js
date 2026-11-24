// ForgeNotes Recorder (macOS) — Electron main process.
//
// Call audio (the other side of a call) is captured in one of two ways, never both:
//
//   * macOS 14.2 and later: natively. The renderer asks for getDisplayMedia({ audio }) and
//     the handler below answers with Electron's system-audio loopback, which Chromium
//     implements with a Core Audio tap. Audio only: no video source is ever granted, so the
//     Screen Recording permission is not involved. macOS asks the user once
//     (NSAudioCaptureUsageDescription, "System Audio Recording Only").
//   * macOS 12.0 to 14.1, or by choice: the BlackHole 2ch virtual device, which shows up as
//     a normal audio INPUT and is opened with getUserMedia in the renderer. The handler
//     refuses every request on those versions.
//
// Which one applies is decided in renderer/system-audio.js (shared with the renderer and
// the tests). Main stays the trusted shell: window, encrypted token storage, the
// local-recording (offline) queue, and the gate on system audio. It also tells the
// renderer when the Mac goes to sleep and wakes (the recording's clock leaves the sleep
// out), and raises the "Still there?" question outside the window.
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell: desktop, safeStorage, session, powerMonitor, Notification } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('node:path')
const fs = require('node:fs/promises')
const systemAudio = require('./renderer/system-audio.js')
const { createShell, windowChrome, glassQuery, HAS_GLASS } = require('./shell')

const USER_DATA = () => app.getPath('userData')
const AUTH_FILE = () => path.join(USER_DATA(), 'auth.bin')
const REC_DIR = () => path.join(USER_DATA(), 'recordings')

let mainWindow = null

// ---------- system audio (call audio) ----------
// Development only: FORGENOTES_FAKE_MACOS_VERSION=13.6 npm start shows what an older Mac
// shows (the BlackHole path) on a newer one. Ignored in a packaged app.
const SYSTEM_VERSION = (!app.isPackaged && process.env.FORGENOTES_FAKE_MACOS_VERSION) || process.getSystemVersion()
const NATIVE_SYSTEM_AUDIO = systemAudio.nativeSupported({ platform: process.platform, systemVersion: SYSTEM_VERSION })

// Chromium blocks its audio service on the macOS permission window the first time a tap is
// opened. If nobody answers for a minute the call times out and, by Chromium's own account
// (media/audio/mac/catap_audio_input_stream.mm), every later Core Audio call in that process
// fails until it is restarted. This feature makes Chromium restart the audio service itself
// in that case; the renderer then reopens its streams. Must be set before the app is ready.
if (NATIVE_SYSTEM_AUDIO) app.commandLine.appendSwitch('enable-features', 'MacCatapRestartAudioProcessOnTimeout')

function isRecorderFrame(frame) {
  if (!frame || !mainWindow || mainWindow.isDestroyed()) return false
  const own = mainWindow.webContents.mainFrame
  return frame.processId === own.processId && frame.routingId === own.routingId
}

function installSystemAudioHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    let trustedFrame = false
    try {
      trustedFrame = isRecorderFrame(request.frame)
    } catch {
      // the frame went away while the request was in flight
    }
    const answer = systemAudio.displayMediaResponse(request, { nativeSupported: NATIVE_SYSTEM_AUDIO, trustedFrame })
    appendLog(`system-audio: capture request ${answer ? 'answered with native loopback' : 'refused'} (macOS ${SYSTEM_VERSION})`)
    if (answer) callback(answer)
    else callback() // getDisplayMedia() rejects in the renderer
  })
}

async function loadConfig() {
  // A real user config (userData for packaged installs, repo config.json for dev) wins.
  // If it EXISTS but is malformed, surface that loudly instead of silently falling back to
  // the example — otherwise a typo (e.g. an unquoted anon key) just looks like "key not set".
  for (const file of [path.join(USER_DATA(), 'config.json'), path.join(__dirname, 'config.json')]) {
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      continue // no config at this location
    }
    try {
      return { ...JSON.parse(raw), _source: file }
    } catch (e) {
      return {
        supabaseUrl: '',
        supabaseAnonKey: '',
        forgenotesHost: '',
        _source: file,
        _parseError: `${path.basename(file)} is not valid JSON (${e.message})`,
      }
    }
  }
  // No user config anywhere → committed example (URL/host defaults, empty key = "Setup needed").
  try {
    const example = JSON.parse(await fs.readFile(path.join(__dirname, 'config.example.json'), 'utf8'))
    return { ...example, _source: 'config.example.json' }
  } catch {
    return { supabaseUrl: '', supabaseAnonKey: '', forgenotesHost: '', _source: null }
  }
}

// The window opens at the size the person last left it and, the first time, at 860 x 580:
// the list of recordings beside the pane. Narrower than 620 the two take turns behind tabs,
// down to 380 x 520. Sizes are the page's own area (useContentSize), and nothing in the
// page wraps at any of them (scripts/test-layout.cjs).
const WINDOW_DEFAULT = { width: 860, height: 580 }
const WINDOW_MIN = { width: 380, height: 520 }
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json')

function readWindowSize() {
  try {
    const saved = JSON.parse(require('node:fs').readFileSync(windowStateFile(), 'utf8'))
    const width = Math.round(Number(saved.width))
    const height = Math.round(Number(saved.height))
    if (width >= WINDOW_MIN.width && height >= WINDOW_MIN.height && width <= 4000 && height <= 4000) return { width, height }
  } catch {
    // first run, or an unreadable file: the default size
  }
  return { ...WINDOW_DEFAULT }
}

function rememberWindowSize(window, opening) {
  // Hiding the menu bar after the window is made changes the page's area on Windows, so the
  // size is set again here, where the frame is final.
  window.setContentSize(opening.width, opening.height)
  // The minimum is given for the page too: add what the frame takes on this system.
  const [outerWidth, outerHeight] = window.getSize()
  const [innerWidth, innerHeight] = window.getContentSize()
  window.setMinimumSize(WINDOW_MIN.width + outerWidth - innerWidth, WINDOW_MIN.height + outerHeight - innerHeight)
  let timer = null
  window.on('resize', () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) return
      const [width, height] = window.getContentSize()
      try {
        require('node:fs').writeFileSync(windowStateFile(), JSON.stringify({ width, height }))
      } catch {
        // not worth interrupting anyone: the default size is used next time
      }
    }, 400)
  })
}

function createWindow() {
  const opening = readWindowSize()
  mainWindow = new BrowserWindow({
    ...opening,
    useContentSize: true,
    title: 'ForgeNotes',
    ...windowChrome(nativeTheme.shouldUseDarkColors),
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed preloads can still use Electron's contextBridge/ipcRenderer
      // polyfill; this preload does not need unrestricted Node.js access.
      sandbox: true,
      // A recorder is mostly used hidden behind the call. Chromium slows the timers of a
      // hidden page (down to one wake-up a minute after a few minutes), and the
      // recording's timers must keep time: segment rotation, the sleep heartbeat and the
      // stop-on-silence readings.
      backgroundThrottling: false,
    },
  })

  mainWindow.setMenuBarVisibility(false)
  rememberWindowSize(mainWindow, opening)
  shell.attach(mainWindow)
  const window = mainWindow
  window.webContents.on('will-prevent-unload', () => { void askToStopForQuit(window) })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), glassQuery())
}

// ---------- quitting during a recording ----------
// The page refuses to unload while it records (its beforeunload), and Electron then cancels
// the close or the Quit without a word. In 0.13.0 that left a recording whose Stop could not
// be pressed with no way out but Force Quit. Now Quit asks: Keep Recording, or Stop and
// Quit, which saves the recording on this Mac (no upload) and quits. If the page does not
// report back in time the app quits anyway; the minute-long checkpoints already on disk are
// listed at the next start, ready to upload.
const STOP_FOR_QUIT_MS = 20000
let quitQuestionOpen = false
let quitFallback = null

// Development only: the recorder UI test answers the question through this, since it cannot
// press a button in a native dialog. Ignored in a packaged app.
function testQuitAnswer() {
  const answer = !app.isPackaged && process.env.FORGENOTES_TEST_QUIT_ANSWER
  return answer === 'keep' ? 0 : answer === 'stop' ? 1 : null
}

async function askToStopForQuit(window) {
  if (quitQuestionOpen || quitFallback || window.isDestroyed()) return
  quitQuestionOpen = true
  let response = 0
  try {
    response = testQuitAnswer() ?? (await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Keep Recording', 'Stop and Quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'A recording is in progress.',
      detail: 'Stop and Quit saves the recording on this Mac. It is listed under Recordings the next time you open ForgeNotes, ready to upload.',
    })).response
  } catch {
    response = 0
  } finally {
    quitQuestionOpen = false
  }
  if (response !== 1 || window.isDestroyed()) {
    shell.quitCancelled() // closing the window hides it again
    return
  }
  void appendLog('quit: stopping the recording to quit')
  quitFallback = setTimeout(() => {
    void appendLog('quit: the recording did not stop in time; quitting anyway')
    quitNow()
  }, STOP_FOR_QUIT_MS)
  window.webContents.send('app:stop-for-quit')
}

// Destroying the windows skips their beforeunload: by now the page has saved what it could.
function quitNow() {
  if (quitFallback) clearTimeout(quitFallback)
  quitFallback = null
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.quit()
}

ipcMain.handle('app:quit', (event) => {
  if (!isRecorderFrame(event.senderFrame)) return false
  quitNow()
  return true
})

// ---------- IPC: config ----------
ipcMain.handle('config:get', async () => {
  const cfg = await loadConfig()
  return {
    supabaseUrl: cfg.supabaseUrl || '',
    supabaseAnonKey: cfg.supabaseAnonKey || '',
    forgenotesHost: cfg.forgenotesHost || 'https://notes.thecontentforge.io',
    version: app.getVersion(),
    _parseError: cfg._parseError || null,
  }
})

// ---------- IPC: system audio ----------
ipcMain.handle('system-audio:info', async () => ({
  platform: process.platform,
  systemVersion: SYSTEM_VERSION,
  nativeSupported: NATIVE_SYSTEM_AUDIO,
  nativeMinVersion: systemAudio.NATIVE_MIN_MACOS_LABEL,
}))

// Opens the pane where macOS lists the apps allowed to record system audio. A fixed
// address: the renderer cannot make main open anything else through this call.
ipcMain.handle('system-audio:open-settings', async () => {
  try {
    await desktop.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AudioCapture')
    return true
  } catch {
    return false
  }
})

// ---------- IPC: recording-announcement voices ----------
// renderer/announce/voices.json lists the voice clips that ship with the app and names the
// default. The page's CSP only lets the renderer connect to https:, so it cannot fetch the
// file itself; main reads it (this also works from inside app.asar). null = no list, and
// the renderer then reports that the announcement could not be played.
ipcMain.handle('announce:voices', async () => {
  try {
    return JSON.parse(await fs.readFile(path.join(__dirname, 'renderer', 'announce', 'voices.json'), 'utf8'))
  } catch (e) {
    console.warn('[forgenotes] could not read the announcement voices:', (e && e.message) || e)
    return null
  }
})

// ---------- IPC: encrypted token storage ----------
ipcMain.handle('secure:get', async () => {
  try {
    const buf = await fs.readFile(AUTH_FILE())
    if (!safeStorage.isEncryptionAvailable()) return buf.toString('utf8')
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
})

ipcMain.handle('secure:set', async (_e, token) => {
  if (!token) return false
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(String(token))
    : Buffer.from(String(token), 'utf8')
  await fs.mkdir(USER_DATA(), { recursive: true })
  await fs.writeFile(AUTH_FILE(), data)
  return true
})

ipcMain.handle('secure:clear', async () => {
  try {
    await fs.unlink(AUTH_FILE())
  } catch {
    // already gone
  }
  return true
})

// ---------- IPC: this install's device id ----------
// Sent with each recording's real start so ForgeNotes can tell two installs recording at the
// same time on one account (see device-id.js). null when it cannot be kept on disk.
const { createDeviceIdStore } = require('./device-id')
let deviceIdStore = null
const deviceIds = () =>
  deviceIdStore ||
  (deviceIdStore = createDeviceIdStore({
    dir: USER_DATA(),
    prefix: 'mac',
    log: (line) => {
      console.warn(`[forgenotes] ${line}`)
      void appendLog(line)
    },
  }))

ipcMain.handle('device:id', async () => deviceIds().get())

// ---------- IPC: external links ----------
ipcMain.handle('open:external', async (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) await desktop.openExternal(url)
  return true
})

// Free disk space on the recordings volume (preflight). statfs is Node 18.15+/Electron;
// returns null if unavailable so the renderer degrades gracefully (recording still works).
ipcMain.handle('disk:free', async () => {
  try {
    if (typeof fs.statfs !== 'function') return null
    const s = await fs.statfs(USER_DATA())
    return { freeBytes: s.bavail * s.bsize }
  } catch {
    return null
  }
})

// ---------- IPC: upload diagnostics log ----------
// Failed uploads used to leave only a transient status line; this keeps the real error
// (status, chunk, attempt) on disk at userData/upload-log.txt for support/debugging.
const LOG_FILE = () => path.join(USER_DATA(), 'upload-log.txt')
const LOG_MAX_BYTES = 512 * 1024

async function appendLog(line) {
  try {
    const file = LOG_FILE()
    try {
      const stat = await fs.stat(file)
      if (stat.size > LOG_MAX_BYTES) await fs.rename(file, `${file}.1`) // keep one rotation
    } catch {
      // no log yet
    }
    await fs.appendFile(file, `${new Date().toISOString()} ${String(line ?? '')}\n`, 'utf8')
  } catch {
    // diagnostics only — never fail the caller
  }
  return true
}

ipcMain.handle('log:append', async (_e, line) => appendLog(line))

// ---------- auto-update ----------
// Updates download quietly in the background and are applied the next time the user
// quits. We deliberately never call quitAndInstall(): this app records live meetings,
// and restarting mid-recording would destroy a capture that cannot be recreated.
// autoInstallOnAppQuit swaps the app in on exit, so the next launch is the new version.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let updateState = { status: 'idle', version: null }

function setUpdateState(status, version) {
  updateState = { status, version: version ?? updateState.version }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', updateState)
}

function initAutoUpdate() {
  // An unpackaged run has no code signature for Squirrel to validate, and electron-updater
  // throws instead of no-opping. Dev simply does not auto-update.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => appendLog('update: checking'))
  autoUpdater.on('update-available', (info) => {
    setUpdateState('downloading', info?.version)
    appendLog(`update: ${info?.version} available, downloading`)
  })
  autoUpdater.on('update-not-available', () => setUpdateState('idle'))
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState('ready', info?.version)
    appendLog(`update: ${info?.version} downloaded, applies on next quit`)
  })
  autoUpdater.on('error', (err) => {
    // A failed update must never be user-visible noise — the app still works on the
    // current version, and the next check retries.
    setUpdateState('idle')
    appendLog(`update: error ${err?.message || err}`)
  })

  const check = () => {
    autoUpdater.checkForUpdates().catch((e) => appendLog(`update: check failed ${e?.message || e}`))
  }
  setTimeout(check, 10_000) // let the window settle and the network come up first
  setInterval(check, UPDATE_CHECK_INTERVAL_MS)
}

// The renderer loads after the first events may already have fired, so let it ask.
ipcMain.handle('update:state', async () => updateState)

// ---------- IPC: local recording fallback / offline queue ----------
const { recordingStore } = require('./recording-store')
const store = () => recordingStore(REC_DIR())
let recordings
const localStore = () => recordings || (recordings = store())
ipcMain.handle('rec:checkpoint', (_e, { localId, meta, segment }) => localStore().checkpoint(localId, meta, segment))
// details: { endedAt, stopReason }, filtered by recording-store's finishDetails.
ipcMain.handle('rec:finish', (_e, { localId, details } = {}) => localStore().finish(localId, details))
ipcMain.handle('rec:uploaded', (_e, { localId, sessionId }) => localStore().update(localId, { state: 'uploaded', sessionId }))
ipcMain.handle('rec:segment', (_e, { localId, segment }) => localStore().readSegment(localId, segment))
ipcMain.handle('rec:playback', (_e, localId) => localStore().playback(localId))
ipcMain.handle('rec:folder', async (_e, localId) => {
  const dir = localStore().directory(localId)
  if (!(await fs.stat(dir)).isDirectory()) throw new Error('recording_folder_missing')
  const error = await desktop.openPath(dir)
  if (error) throw new Error(error)
})

function safeId(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(id || ''))) throw new Error('invalid_local_id')
  return id
}

ipcMain.handle('rec:save', async (_e, { localId, meta, segments }) => {
  const id = safeId(localId)
  if (!id) throw new Error('invalid_local_id')
  const dir = path.join(REC_DIR(), id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta ?? {}, null, 2), 'utf8')
  for (const s of segments || []) {
    if (!s || !s.track || s.data == null) continue
    const name = `${safeId(s.track)}-${String(s.seq ?? 0).padStart(4, '0')}.webm`
    await fs.writeFile(path.join(dir, name), Buffer.from(s.data))
  }
  return true
})

ipcMain.handle('rec:list', async () => {
  const out = []
  let entries = []
  try {
    entries = await fs.readdir(REC_DIR(), { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    try {
      const meta = JSON.parse(await fs.readFile(path.join(REC_DIR(), ent.name, 'meta.json'), 'utf8'))
      out.push({ localId: ent.name, meta })
    } catch {
      out.push({ localId: ent.name, meta: { title: 'Unreadable recording', state: 'damaged' } })
    }
  }
  out.sort((a, b) => String(b.meta?.createdAt || '').localeCompare(String(a.meta?.createdAt || '')))
  return out
})

ipcMain.handle('rec:read', async (_e, localId) => {
  const id = safeId(localId)
  const dir = path.join(REC_DIR(), id)
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'))
  const segments = []
  for (const seg of meta.segments || []) {
    try {
      const name = `${safeId(seg.track)}-${String(seg.seq ?? 0).padStart(4, '0')}.webm`
      const buf = await fs.readFile(path.join(dir, name))
      segments.push({ track: seg.track, seq: seg.seq ?? 0, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })
    } catch {
      throw new Error('Recording is incomplete: a saved audio segment is missing.')
    }
  }
  return { meta, segments }
})

ipcMain.handle('rec:delete', async (_e, localId) => {
  const id = safeId(localId)
  if (!id) return false
  const target = localStore().directory(id)
  await fs.rm(target, { recursive: true, force: true })
  return true
})

// ---------- sleep and wake ----------
// Nothing is captured while the Mac sleeps, but the wall clock keeps going: a one-minute
// segment that spanned a sleep used to claim the whole night as audio (session 0ca7b2a4:
// 33,550 s). The renderer is told when the Mac suspends and resumes, with the time each
// event fired here, so it can end the segment at suspend, start a new one at resume and
// keep the sleep out of the recording's clock (renderer/capture-clock.js). Logged for
// support as well.
function sendPower(state) {
  const at = Date.now()
  void appendLog(`power: ${state}`)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('power:state', { state, at })
}

// ---------- "Still there?" ----------
// Stop on silence (renderer/silence.js) asks before it stops a recording, and the question
// has to be noticed by someone who is not looking at this window: the renderer chimes and
// changes the window title, and main adds a system notification and bounces the Dock icon.
// Answering the notification is answering "Keep recording".
let silenceNotice = null // kept referenced so its click handler is not collected
let dockBounce = null

function clearSilenceAttention() {
  if (silenceNotice) {
    const note = silenceNotice
    silenceNotice = null
    try { note.close() } catch { /* already gone */ }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.flashFrame(false) } catch { /* not supported */ }
  }
  if (dockBounce !== null && app.dock) {
    try { app.dock.cancelBounce(dockBounce) } catch { /* not supported */ }
  }
  dockBounce = null
}

ipcMain.handle('silence:ask', async (_e, { body } = {}) => {
  clearSilenceAttention()
  const text = typeof body === 'string' ? body.slice(0, 240) : ''
  try {
    if (Notification.isSupported()) {
      const note = new Notification({ title: 'Still there?', body: text, silent: true, timeoutType: 'never' })
      note.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
          mainWindow.webContents.send('silence:keep')
        }
      })
      note.show()
      silenceNotice = note
    }
  } catch (e) {
    console.warn('[forgenotes] could not show the silence notification:', (e && e.message) || e)
  }
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
    try { mainWindow.flashFrame(true) } catch { /* not supported */ }
    if (app.dock) {
      try { dockBounce = app.dock.bounce('critical') } catch { dockBounce = null }
    }
  }
  return true
})

ipcMain.handle('silence:clear', async () => {
  clearSilenceAttention()
  return true
})

// ---------- the app around the recorder window ----------
// Menu bar icon and popover, the floating bar, the menus and Check for Updates (shell.js).
const shell = createShell({
  getMainWindow: () => mainWindow,
  isRecorderFrame,
  handle: (channel, listener) => ipcMain.handle(channel, listener),
  getUpdater: () => autoUpdater,
  log: appendLog,
})

// ---------- lifecycle ----------
app.whenReady().then(() => {
  if (!shell.start()) return
  installSystemAudioHandler()
  createWindow()
  initAutoUpdate()
  powerMonitor.on('suspend', () => sendPower('suspend'))
  powerMonitor.on('resume', () => sendPower('resume'))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
