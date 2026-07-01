// ForgeNotes Recorder (macOS) — Electron main process.
//
// macOS captures system/call audio differently from Windows: instead of a screen-share
// loopback, it records the BlackHole 2ch virtual device (which shows up as a normal audio
// INPUT). So there is NO setDisplayMediaRequestHandler here — both tracks come from
// getUserMedia in the renderer. Main stays the trusted shell: window, encrypted token
// storage, and the local-recording (offline) queue.
const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')

const USER_DATA = () => app.getPath('userData')
const AUTH_FILE = () => path.join(USER_DATA(), 'auth.bin')
const REC_DIR = () => path.join(USER_DATA(), 'recordings')

let mainWindow = null

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
      sandbox: false, // preload needs require() for the IPC bridge
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

// ---------- IPC: local recording fallback / offline queue ----------
function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '')
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
      // skip corrupt/partial dir
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
      // missing segment file
    }
  }
  return { meta, segments }
})

ipcMain.handle('rec:delete', async (_e, localId) => {
  const id = safeId(localId)
  if (!id) return false
  await fs.rm(path.join(REC_DIR(), id), { recursive: true, force: true })
  return true
})

// ---------- lifecycle ----------
app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
