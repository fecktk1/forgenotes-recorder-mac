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
// local-recording (offline) queue, and the gate on system audio.
const { app, BrowserWindow, ipcMain, shell, safeStorage, session } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('node:path')
const fs = require('node:fs/promises')
const systemAudio = require('./renderer/system-audio.js')

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 820,
    minWidth: 420,
    minHeight: 680,
    title: 'ForgeNotes Recorder',
    backgroundColor: '#09090b',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed preloads can still use Electron's contextBridge/ipcRenderer
      // polyfill; this preload does not need unrestricted Node.js access.
      sandbox: true,
    },
  })

  mainWindow.setMenuBarVisibility(false)
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

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
    await shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AudioCapture')
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

// ---------- IPC: external links ----------
ipcMain.handle('open:external', async (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url)
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
ipcMain.handle('rec:finish', (_e, localId) => localStore().update(localId, { state: 'saved' }))
ipcMain.handle('rec:uploaded', (_e, { localId, sessionId }) => localStore().update(localId, { state: 'uploaded', sessionId }))
ipcMain.handle('rec:segment', (_e, { localId, segment }) => localStore().readSegment(localId, segment))
ipcMain.handle('rec:playback', (_e, localId) => localStore().playback(localId))
ipcMain.handle('rec:folder', async (_e, localId) => {
  const dir = localStore().directory(localId)
  if (!(await fs.stat(dir)).isDirectory()) throw new Error('recording_folder_missing')
  const error = await shell.openPath(dir)
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
      out.push({ localId: ent.name, meta: { title: 'Interrupted recording — inspect saved files', state: 'damaged' } })
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

// ---------- lifecycle ----------
app.whenReady().then(() => {
  installSystemAudioHandler()
  createWindow()
  initAutoUpdate()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
