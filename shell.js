// The app around the recorder window. Shared by the macOS and Windows apps: keep the two
// copies identical.
//
// The recorder itself is one page (renderer/index.html in the main window): it captures,
// checkpoints and uploads, and it stays loaded for as long as the app runs. Everything here
// is a way to see it and reach it without that window in front:
//   - the menu bar (macOS) or tray (Windows) icon, with a popover to start and stop;
//   - a small bar that floats over the call while a recording runs;
//   - the application and tray menus, with Check for Updates;
//   - closing the window hides it, so a recording is never ended by a stray click.
// The popover and the bar are separate pages with their own tiny preload
// (preload-surface.js). They are shown the recorder's state and can ask for a handful of
// named actions; they cannot reach recordings, the sign-in token or anything else.
'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, screen, shell: desktop } = require('electron')

const IS_MAC = process.platform === 'darwin'
const SURFACE_DIR = path.join(__dirname, 'renderer', 'surfaces')
const STORE_PAGE = 'ms-windows-store://pdp/?productid=9P45688V8XJJ' // ForgeNotes in the Microsoft Store
// What a surface may ask for. Anything else is dropped.
const TO_RECORDER = new Set(['start', 'stop', 'pause', 'mode', 'keep', 'captions', 'title'])
const TO_SHELL = new Set(['recordings', 'settings', 'open', 'updates', 'hide', 'quit'])
const STOP_FOR_QUIT_MS = 20000

// The system's own glass behind a window: vibrancy on macOS, Mica and Acrylic on Windows 11
// 22H2 and later. Elsewhere the pages paint a plain background.
const HAS_GLASS = IS_MAC || (process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621)
const glassQuery = () => ({ query: { glass: HAS_GLASS ? '1' : '0' } })

// 1.10.0 is newer than 1.9.3.
function isNewer(candidate, current) {
  const parts = (v) => String(v || '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const a = parts(candidate); const b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

// options:
//   getMainWindow()        the recorder window, or null
//   isRecorderFrame(frame) true for the recorder page's own top frame
//   handle(channel, fn)    registers an IPC handler answered only for the recorder page
//   getUpdater()           electron-updater's autoUpdater, or null when it cannot be used
//   log(line)              the diagnostics log
//   quitWhileRecording     'ask' when the shell must ask before quitting during a recording
//                          (Windows); omitted where main already does (macOS)
function createShell(options) {
  const { getMainWindow, isRecorderFrame, getUpdater, log } = options
  let tray = null
  let popover = null
  let bar = null
  let barPlaced = false
  let quitting = false
  let state = { signedIn: false, recording: false, paused: false, timer: '00:00', recent: [], count: 0 }

  const mainWindow = () => { const w = getMainWindow(); return w && !w.isDestroyed() ? w : null }
  const alive = (w) => Boolean(w) && !w.isDestroyed()

  // ---------------------------------------------------------------- the recorder window
  function showMain(command) {
    const w = mainWindow()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
    if (command) w.webContents.send('shell:command', command)
  }

  function toRecorder(command) {
    const w = mainWindow()
    if (w) w.webContents.send('shell:command', command)
  }

  // Closing the window hides it: the recorder keeps running and stays one click away.
  function attach(window) {
    window.on('close', (event) => {
      if (quitting) return
      event.preventDefault()
      window.hide()
      noteStillRunning()
    })
    for (const name of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) window.on(name, syncBar)
  }

  // Windows gives no sign that an app with no window is still running. Say so, once.
  function noteStillRunning() {
    if (IS_MAC || !tray) return
    const flag = path.join(app.getPath('userData'), 'tray-notice-shown')
    try {
      if (fs.existsSync(flag)) return
      fs.writeFileSync(flag, '1')
      tray.displayBalloon({ title: 'ForgeNotes is still running', content: 'Find it in the system tray, next to the clock. Right-click it to quit.' })
    } catch {
      // not worth interrupting anyone
    }
  }

  // ---------------------------------------------------------------- surfaces
  function surfaceWindow(file, material, extra) {
    // Windows draws Acrylic only for the active window, and the bar never is: it gets a
    // plain background in the theme's colour there.
    const glass = IS_MAC || (HAS_GLASS && material.win !== 'plain')
    const window = new BrowserWindow({
      show: false,
      frame: false,
      // The system rounds the corners, casts the shadow and supplies the glass.
      ...(IS_MAC
        ? { vibrancy: material.mac, visualEffectState: 'active', backgroundColor: '#00000000' }
        : glass ? { backgroundMaterial: 'acrylic' } : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3' }),
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      ...extra,
      webPreferences: {
        preload: path.join(__dirname, 'preload-surface.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    window.loadFile(path.join(SURFACE_DIR, file), { query: { glass: glass ? '1' : '0' } })
    return window
  }

  const surfaces = () => [popover, bar].filter(alive)
  const isSurface = (event) => {
    const frame = event.senderFrame
    return Boolean(frame) && !frame.parent && surfaces().some((w) => w.webContents === event.sender)
  }
  function broadcast() {
    for (const w of surfaces()) w.webContents.send('surface:state', state)
  }

  // The popover hangs from the icon: under the menu bar on macOS, above the tray on Windows.
  function placePopover() {
    if (!alive(popover) || !tray) return
    const icon = tray.getBounds()
    const [width, height] = popover.getSize()
    const area = screen.getDisplayNearestPoint({ x: icon.x, y: icon.y }).workArea
    let x = Math.round(icon.x + icon.width / 2 - width / 2)
    let y = icon.y < area.y + area.height / 2 ? icon.y + icon.height + 6 : icon.y - height - 12
    if (!icon.width) { x = area.x + area.width - width - 8; y = IS_MAC ? area.y + 4 : area.y + area.height - height - 8 }
    x = Math.max(area.x + 4, Math.min(x, area.x + area.width - width - 4))
    y = Math.max(area.y + 4, Math.min(y, area.y + area.height - height - 4))
    popover.setPosition(x, y, false)
  }

  function togglePopover() {
    if (alive(popover) && popover.isVisible()) { popover.hide(); return }
    if (!alive(popover)) {
      popover = surfaceWindow('popover.html', { mac: 'popover' }, { width: 300, height: 300, movable: false })
      popover.on('blur', () => { if (alive(popover) && !popover.webContents.isDevToolsOpened()) popover.hide() })
      popover.once('ready-to-show', () => { placePopover(); popover.show() })
      return
    }
    toRecorder({ type: 'sync' })
    placePopover()
    popover.show()
  }

  // The bar is there while a recording runs and the recorder window is not what the person
  // is looking at. It never takes the keyboard away from the call.
  function syncBar() {
    const w = mainWindow()
    const inFront = Boolean(w) && w.isVisible() && !w.isMinimized() && w.isFocused()
    const wanted = Boolean(state.recording) && !inFront && !quitting
    if (!wanted) { if (alive(bar) && bar.isVisible()) bar.hide(); return }
    if (!alive(bar)) {
      bar = surfaceWindow('bar.html', { mac: 'hud', win: 'plain' }, { width: 380, height: 44, focusable: !IS_MAC })
      barPlaced = false
      bar.setAlwaysOnTop(true, 'floating')
      if (IS_MAC) bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      bar.once('ready-to-show', () => { placeBar(); if (state.recording) bar.showInactive() })
      return
    }
    if (!bar.isVisible()) { placeBar(); bar.showInactive() }
  }

  // Top centre of the screen the pointer is on, until the person drags it somewhere else.
  function placeBar() {
    if (!alive(bar) || barPlaced) return
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const [width] = bar.getSize()
    bar.setPosition(Math.round(area.x + (area.width - width) / 2), area.y + 12, false)
    barPlaced = true
  }

  // ---------------------------------------------------------------- state and commands
  ipcMain.on('shell:state', (event, next) => {
    if (!isRecorderFrame(event.senderFrame) || !next || typeof next !== 'object') return
    let text
    try { text = JSON.stringify(next) } catch { return }
    if (text.length > 20000) return
    const wasRecording = state.recording
    state = JSON.parse(text)
    if (tray) {
      if (IS_MAC) tray.setTitle(state.recording ? ` ${state.timer}` : '', { fontType: 'monospacedDigit' })
      tray.setToolTip(state.recording ? `ForgeNotes: ${state.paused ? 'paused at' : 'recording'} ${state.timer}` : 'ForgeNotes')
    }
    if (wasRecording !== Boolean(state.recording)) { buildMenus(); if (state.recording) barPlaced = false }
    broadcast()
    syncBar()
  })

  ipcMain.handle('surface:ready', (event) => (isSurface(event) ? state : null))

  ipcMain.on('surface:size', (event, size) => {
    if (!isSurface(event)) return
    const window = BrowserWindow.fromWebContents(event.sender)
    const height = Math.max(44, Math.min(640, Math.round(Number(size && size.height) || 0)))
    if (!window || !height) return
    const [width, current] = window.getSize()
    if (current === height) return
    // A window that cannot be resized by hand will not shrink from code either on Windows.
    window.setResizable(true)
    window.setSize(width, height, false)
    window.setResizable(false)
    if (window === popover) placePopover()
  })

  ipcMain.on('surface:command', (event, command) => {
    if (!isSurface(event) || !command || typeof command.type !== 'string') return
    const type = command.type
    if (TO_RECORDER.has(type)) {
      toRecorder({ type, mode: command.mode === 'room' ? 'room' : 'online', title: typeof command.title === 'string' ? command.title.slice(0, 200) : '' })
    } else if (TO_SHELL.has(type)) {
      if (type === 'recordings') showMain({ type: 'recordings' })
      else if (type === 'settings') showMain({ type: 'settings' })
      else if (type === 'open') showMain({ type: 'open', id: String(command.id || '').slice(0, 80) })
      else if (type === 'updates') void checkForUpdates()
      else if (type === 'quit') requestQuit()
      if (type !== 'updates' && alive(popover)) popover.hide()
    }
  })

  // ---------------------------------------------------------------- updates
  // Returns { status, message } and, unless quiet, shows it. Updates download in the
  // background and install on quit (main never restarts the app under a recording); this
  // only lets a person ask now instead of waiting for the next timed check.
  let checking = null
  function checkForUpdates({ quiet = false } = {}) {
    if (checking) return checking
    const run = async () => {
      const current = app.getVersion()
      let answer
      if (process.windowsStore || process.mas) {
        answer = { status: 'store', message: 'This copy of ForgeNotes updates through the Store.' }
        if (process.windowsStore) void desktop.openExternal(STORE_PAGE).catch(() => {})
      } else {
        const updater = app.isPackaged ? getUpdater() : null
        if (!updater) {
          answer = { status: 'unavailable', message: 'Updates are checked in the installed app.' }
        } else {
          try {
            const result = await updater.checkForUpdates()
            const latest = result && result.updateInfo && result.updateInfo.version
            answer = latest && isNewer(latest, current)
              ? { status: 'downloading', message: `Version ${latest} is downloading. It installs when you quit ForgeNotes.` }
              : { status: 'current', message: `ForgeNotes ${current} is the latest version.` }
          } catch (e) {
            void log(`update: manual check failed ${(e && e.message) || e}`)
            answer = { status: 'error', message: 'Could not check for updates. Try again later.' }
          }
        }
      }
      void log(`update: manual check -> ${answer.status}`)
      if (!quiet) {
        const box = { type: 'info', buttons: ['OK'], message: answer.message }
        const w = mainWindow()
        void (w && w.isVisible() ? dialog.showMessageBox(w, box) : dialog.showMessageBox(box))
      }
      return answer
    }
    checking = run().finally(() => { checking = null })
    return checking
  }
  options.handle('update:check', (_event, request) => checkForUpdates({ quiet: Boolean(request && request.quiet) }))

  // ---------------------------------------------------------------- a menu at the pointer
  // The recorder page describes a short menu and the system draws it. Resolves to the id
  // of what was chosen, or null.
  options.handle('menu:popup', (event, items) => new Promise((resolve) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || !Array.isArray(items)) { resolve(null); return }
    let chosen = null
    const template = items.slice(0, 12).map((item) => (item && item.type === 'separator'
      ? { type: 'separator' }
      : { label: String((item && item.label) || '').slice(0, 60), enabled: !item || item.enabled !== false, click: () => { chosen = String(item.id || '') } }))
    Menu.buildFromTemplate(template).popup({ window, callback: () => resolve(chosen) })
  }))

  // ---------------------------------------------------------------- quitting
  function quitNow() {
    quitting = true
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    app.quit()
  }

  // Quit from a menu. Where main does not already ask (Windows), a recording in progress is
  // never ended without a question, and Stop and Quit saves it first.
  async function requestQuit() {
    if (!state.recording || options.quitWhileRecording !== 'ask') { app.quit(); return }
    const box = {
      type: 'warning',
      buttons: ['Keep Recording', 'Stop and Quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'A recording is in progress.',
      detail: 'Stop and Quit saves the recording on this computer. It is listed under Recordings the next time you open ForgeNotes, ready to upload.',
    }
    const w = mainWindow()
    const { response } = await (w && w.isVisible() ? dialog.showMessageBox(w, box) : dialog.showMessageBox(box))
    if (response !== 1) return
    void log('quit: stopping the recording to quit')
    toRecorder({ type: 'stop' })
    const deadline = Date.now() + STOP_FOR_QUIT_MS
    const wait = setInterval(() => {
      if (state.recording && Date.now() < deadline) return
      clearInterval(wait)
      if (state.recording) void log('quit: the recording did not stop in time; quitting anyway')
      quitNow()
    }, 250)
  }

  // ---------------------------------------------------------------- menus
  function buildMenus() {
    const recording = Boolean(state.recording)
    const record = recording
      ? [
        { label: 'Stop and Save', click: () => toRecorder({ type: 'stop' }) },
        { label: state.paused ? 'Resume' : 'Pause', click: () => toRecorder({ type: 'pause' }) },
      ]
      : [{ label: 'New Recording', accelerator: 'CmdOrCtrl+N', click: () => showMain({ type: 'recordings' }) }]
    const updates = { label: IS_MAC ? 'Check for Updates…' : 'Check for updates…', click: () => void checkForUpdates() }
    const settings = { label: IS_MAC ? 'Settings…' : 'Settings', accelerator: 'CmdOrCtrl+,', click: () => showMain({ type: 'settings' }) }

    const template = IS_MAC
      ? [
        { label: app.name, submenu: [{ role: 'about' }, updates, { type: 'separator' }, settings, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: `Quit ${app.name}`, accelerator: 'Cmd+Q', click: requestQuit }] },
        { label: 'File', submenu: [...record, { type: 'separator' }, { role: 'close' }] },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]
      : [
        { label: 'File', submenu: [...record, { type: 'separator' }, settings, updates, { type: 'separator' }, { label: 'Exit', click: requestQuit }] },
        { role: 'editMenu' },
      ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))

    if (tray) {
      tray.__menu = Menu.buildFromTemplate([
        ...(recording ? record : [{ label: 'Start Recording', enabled: Boolean(state.signedIn), click: () => toRecorder({ type: 'start' }) }]),
        { type: 'separator' },
        { label: 'Open ForgeNotes', click: () => showMain() },
        { label: IS_MAC ? 'Settings…' : 'Settings', click: () => showMain({ type: 'settings' }) },
        updates,
        { type: 'separator' },
        { label: IS_MAC ? 'Quit ForgeNotes' : 'Exit', click: requestQuit },
      ])
    }
  }

  // ---------------------------------------------------------------- start
  function start() {
    // One recorder per profile: a second copy would write to the same recordings folder.
    if (!app.requestSingleInstanceLock()) { quitting = true; app.quit(); return false }
    app.on('second-instance', () => showMain())
    app.on('before-quit', () => { quitting = true; syncBar() })
    app.on('activate', () => showMain())
    try {
      const icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'brand', IS_MAC ? 'trayTemplate.png' : 'tray.png'))
      if (IS_MAC) icon.setTemplateImage(true)
      tray = new Tray(icon)
      tray.setToolTip('ForgeNotes')
      tray.on('click', togglePopover)
      tray.on('right-click', () => { if (tray.__menu) tray.popUpContextMenu(tray.__menu) })
    } catch (e) {
      // No tray on this system: the window and the menus still do everything.
      void log(`shell: no tray icon (${(e && e.message) || e})`)
      tray = null
    }
    buildMenus()
    nativeTheme.on('updated', () => { for (const fn of themeListeners) fn(nativeTheme.shouldUseDarkColors) })
    return true
  }

  const themeListeners = []

  const api = {
    start,
    attach,
    showMain,
    checkForUpdates,
    requestQuit,
    // A quit was called off (Keep Recording): closing the window hides it again.
    quitCancelled: () => { quitting = false; syncBar() },
    isQuitting: () => quitting,
    onTheme: (fn) => { themeListeners.push(fn) },
    // For tests.
    state: () => state,
    windows: () => ({ popover: alive(popover) ? popover : null, bar: alive(bar) ? bar : null }),
    togglePopover,
    trayMenu: () => (tray && tray.__menu) || null,
  }
  // Development and tests only: a way to reach the shell from a script that started main.js.
  if (!app.isPackaged) global.__forgenotesShell = api
  return api
}

// How the recorder window sits in the system, for the current theme: the inset title bar
// and sidebar vibrancy on macOS; on Windows the caption buttons drawn over the page, and
// Mica behind it where Windows has it.
function windowChrome(dark) {
  if (IS_MAC) return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#ffffff' : '#000000', height: 44 },
    ...(HAS_GLASS ? { backgroundMaterial: 'mica' } : { backgroundColor: dark ? '#202020' : '#f3f3f3' }),
  }
}

module.exports = { createShell, windowChrome, isNewer, glassQuery, HAS_GLASS }
