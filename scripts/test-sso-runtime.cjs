// Runtime test of Sign in with SSO in the real app (main.js and the renderer), with a fake
// GoTrue in the main process and a throwaway userData folder:
//   - the button shows because forgenotes_sso_available() answers true;
//   - Sign in with SSO sends the work email's domain and an S256 challenge, opens the identity
//     provider's page in the browser (intercepted here), and shows the waiting state;
//   - the forgenotes-recorder://sso-callback link arrives the way the OS delivers it, the code is
//     exchanged with the verifier that matches the challenge, and the page is signed in;
//   - the refresh token is stored through secure:set (encrypted when safeStorage can);
//   - a page that is not the recorder's own gets no answer from the SSO channels.
// A real identity provider (Okta) and the OS handing the link to the app remain manual checks.
const electron = require('electron')
const { app, BrowserWindow, shell, safeStorage } = electron
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const userData = path.join(os.tmpdir(), 'forgenotes-sso-runtime-test')
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
const SUPABASE = 'https://sso-test.invalid'
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ supabaseUrl: SUPABASE, supabaseAnonKey: 'sb_publishable_runtime_test', forgenotesHost: '' }))

// The fake GoTrue: main.js calls the global fetch for every SSO request.
const requests = []
const REFRESH = 'rt-sso-runtime-test'
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null
  requests.push({ url: String(url), body })
  const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
  const where = String(url).replace(SUPABASE, '')
  if (where === '/rest/v1/rpc/forgenotes_sso_available') return reply(200, true)
  if (where === '/auth/v1/sso') return reply(200, { url: 'https://idp.example.com/sso/saml?SAMLRequest=runtime' })
  if (where === '/auth/v1/token?grant_type=pkce') {
    return reply(200, { access_token: 'at-sso', refresh_token: REFRESH, expires_in: 3600, token_type: 'bearer', user: { id: '00000000-0000-4000-8000-000000000001', email: 'dana@acme.com' } })
  }
  return reply(404, {})
}
const opened = []
shell.openExternal = async (url) => { opened.push(url) }

const timeout = setTimeout(() => {
  console.error('SSO runtime test timed out')
  app.exit(1)
}, 45000)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    const value = await check()
    if (value) return value
    await delay(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// How the OS hands over the link: macOS sends open-url to the running app; Windows starts a second
// copy whose argv reaches this one through second-instance.
function deliverLink(url) {
  if (process.platform === 'darwin' || app.listenerCount('second-instance') === 0) {
    app.emit('open-url', { preventDefault() {} }, url)
  } else {
    app.emit('second-instance', {}, [process.execPath, '--some-switch', url], process.cwd())
  }
}

require('../main.js')

app
  .whenReady()
  .then(async () => {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'the window')
    if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
    const run = (js) => win.webContents.executeJavaScript(js, true)

    await until(() => run(`!document.getElementById('sso-block').classList.contains('hidden')`), 'the SSO button')
    await run(`document.getElementById('login-email').value = 'Dana@Acme.com'; document.getElementById('sso-btn').click(); true`)
    await until(() => opened.length === 1, 'the browser to open')
    assert.equal(opened[0], 'https://idp.example.com/sso/saml?SAMLRequest=runtime')
    assert.equal(await run(`!document.getElementById('sso-wait').classList.contains('hidden')`), true, 'waiting state shown')

    const start = requests.find((r) => r.url.endsWith('/auth/v1/sso'))
    assert.equal(start.body.domain, 'acme.com')
    assert.equal(start.body.redirect_to, 'forgenotes-recorder://sso-callback')
    assert.equal(start.body.code_challenge_method, 's256')
    assert.match(start.body.code_challenge, /^[A-Za-z0-9_-]{43}$/)

    deliverLink('forgenotes-recorder://sso-callback?code=runtime-code')
    await until(() => run(`document.getElementById('login-view').classList.contains('hidden')`), 'the page to sign in')
    assert.equal(await run(`document.getElementById('account-email').textContent`), 'dana@acme.com')

    const exchange = requests.find((r) => r.url.endsWith('grant_type=pkce'))
    assert.equal(exchange.body.auth_code, 'runtime-code')
    const challenge = crypto.createHash('sha256').update(exchange.body.code_verifier).digest('base64url')
    assert.equal(challenge, start.body.code_challenge, 'the verifier matches the challenge')

    // Stored like a password sign-in.
    assert.equal(await until(() => run('window.desktop.secureGet()'), 'the stored sign-in'), REFRESH)
    const authFile = path.join(userData, 'auth.bin')
    if (safeStorage.isEncryptionAvailable() && fs.existsSync(authFile)) {
      assert.ok(!fs.readFileSync(authFile).toString('latin1').includes(REFRESH), 'refresh token encrypted at rest')
    }

    // The link again: used once, never exchanged twice.
    deliverLink('forgenotes-recorder://sso-callback?code=runtime-code')
    await delay(300)
    assert.equal(requests.filter((r) => r.url.endsWith('grant_type=pkce')).length, 1)

    // A page that is not the recorder's own gets no answer.
    const foreign = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true } })
    await foreign.loadURL('data:text/html,<title>foreign</title>')
    const answer = await foreign.webContents.executeJavaScript(
      `window.desktop.ssoStart('dana@acme.com').then(() => 'answered', (e) => String(e && e.message))`,
      true,
    )
    assert.match(answer, /ipc_sender_rejected/)
    foreign.destroy()

    console.log(JSON.stringify({ electron: process.versions.electron, platform: process.platform, ok: true }))
    clearTimeout(timeout)
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  })
