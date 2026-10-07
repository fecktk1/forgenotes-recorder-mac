// Shell regression test: starts the real main.js (with a throwaway userData folder) and checks
// that the window is sandboxed, the preload bridge still answers the app's own page, IPC is
// refused for any other page, and navigation or window.open away from the app is blocked.
// Physical capture, loopback routing and OS permission prompts remain hardware QA checks.
const { app, BrowserWindow, safeStorage } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// A fixed throwaway folder, emptied at the start of each run: Chromium keeps files in it open
// until the process has exited, so it cannot be removed at the end of the run.
const userData = path.join(os.tmpdir(), 'forgenotes-shell-test')
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)

const timeout = setTimeout(() => {
  console.error('Shell hardening test timed out')
  app.exit(1)
}, 30000)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function loaded(win) {
  if (!win.webContents.isLoading()) return
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
}

async function firstWindow() {
  for (let i = 0; i < 100; i++) {
    const [win] = BrowserWindow.getAllWindows()
    if (win) return win
    await delay(50)
  }
  throw new Error('main.js did not open a window')
}

require('../main.js')

app
  .whenReady()
  .then(async () => {
    const win = await firstWindow()
    await loaded(win)
    const appUrl = win.webContents.getURL()
    const run = (js) => win.webContents.executeJavaScript(js, true)

    assert.equal(win.webContents.getLastWebPreferences().sandbox, true, 'renderer is sandboxed')
    assert.equal(await run('typeof require'), 'undefined', 'no Node in the page')

    const cfg = await run('window.desktop.getConfig()')
    assert.equal(typeof cfg.version, 'string', 'preload bridge answers the app page')

    const token = 'shell-test-refresh-token'
    assert.equal(await run(`window.desktop.secureSet(${JSON.stringify(token)})`), true)
    assert.equal(await run('window.desktop.secureGet()'), token)
    const authFile = path.join(userData, 'auth.bin')
    if (fs.existsSync(authFile)) {
      assert.ok(safeStorage.isEncryptionAvailable(), 'auth.bin is only written when encryption is available')
      assert.ok(!fs.readFileSync(authFile).toString('latin1').includes(token), 'token is encrypted at rest')
    }
    await run('window.desktop.secureClear()')
    assert.equal(fs.existsSync(authFile), false)

    // Navigation and new windows away from the app are refused.
    await run(`location.href = 'https://example.com/'`)
    await delay(500)
    assert.equal(win.webContents.getURL(), appUrl, 'navigation away from the app is blocked')
    assert.equal(await run(`window.open('https://example.com/') === null`), true, 'window.open is denied')
    assert.equal(BrowserWindow.getAllWindows().length, 1)

    // A page that is not the app's own page gets no answers, even with the preload.
    const foreignFile = path.join(userData, 'foreign.html')
    fs.writeFileSync(foreignFile, '<!doctype html><title>foreign</title>')
    for (const load of [(w) => w.loadFile(foreignFile), (w) => w.loadURL('data:text/html,<title>foreign</title>')]) {
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true },
      })
      await load(foreign)
      const answer = await foreign.webContents.executeJavaScript(
        `window.desktop.getConfig().then(() => 'answered', (e) => String(e && e.message))`,
        true,
      )
      assert.match(answer, /ipc_sender_rejected/, `IPC refused for ${foreign.webContents.getURL().slice(0, 40)}`)
      foreign.destroy()
    }

    console.log(
      JSON.stringify({
        electron: process.versions.electron,
        platform: process.platform,
        sandbox: true,
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
        ok: true,
      }),
    )
    clearTimeout(timeout)
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  })
