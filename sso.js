// "Sign in with SSO" for the desktop recorder, main-process side. Supabase Auth's SAML sign-in in
// the PKCE flow that supabase-js signInWithSSO({ domain }) uses, spoken to GoTrue directly (the
// app has no supabase-js), the same three steps as the iPhone app:
//
//  1. POST /auth/v1/sso {domain, redirect_to, skip_http_redirect, code_challenge, s256} -> {url},
//     the identity provider's sign-in page. The verifier never leaves this process.
//  2. That page opens in the system browser (IdPs block embedded browsers, and password managers
//     and passkeys need the real one) and ends on forgenotes-recorder://sso-callback?code=...
//     Windows starts a second copy of the app with the link on its command line (handed to the
//     first copy by the single-instance lock); macOS sends the running app an open-url event.
//  3. POST /auth/v1/token?grant_type=pkce {auth_code, code_verifier} -> a session, which the
//     renderer stores exactly like a password sign-in (the refresh token, encrypted at rest).
//
// One sign-in can be waiting at a time, for five minutes. A callback is used once, and only while
// a sign-in this app started is waiting: a link that arrives at any other time is dropped (PKCE
// means a code is worthless without this run's verifier anyway). GoTrue keeps the PKCE flow state
// on its side, so there is no separate state parameter to compare.
//
// No Electron here, so scripts/test-sso.cjs runs it under plain Node.
const crypto = require('node:crypto')

const SCHEME = 'forgenotes-recorder'
const REDIRECT_URL = `${SCHEME}://sso-callback`
const FLOW_TIMEOUT_MS = 5 * 60 * 1000
const MAX_CODE_LENGTH = 4000
const MAX_URL_LENGTH = 8192

const MESSAGES = {
  NEED_EMAIL: 'Enter your work email, then choose Sign in with SSO.',
  NOT_WORK_EMAIL: 'Enter your work email address (name@company.com) to sign in with SSO.',
  NOT_SET_UP: 'Single sign-on is not set up for that domain. Sign in with your email and password instead, or ask your team admin.',
  NOT_AVAILABLE: 'Single sign-on is not available yet. Sign in with your email and password.',
  SSO_REQUIRED: 'Your organization requires single sign-on. Use Sign in with SSO and your work email.',
  OUTSIDE_DOMAINS: 'That sign-in was refused: your identity provider sent an address outside the domains it is set up for. Ask your IT team.',
  LINK_REFUSED: 'That single sign-on account cannot be joined to an existing password account. Ask your team admin.',
  IDP_REFUSED: 'Your identity provider did not sign you in. Try again, or ask your IT team to check that you have access to ForgeNotes.',
  DID_NOT_FINISH: 'Single sign-on did not finish. Try again, or ask your team admin to check the setup.',
  DATABASE_REFUSED: "That sign-in was refused. If you used single sign-on, ask your team admin to check that your address is on one of the team's verified domains.",
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  COULD_NOT_START: 'Single sign-on could not start. Try again.',
  OFFLINE: "Couldn't reach ForgeNotes. Check your internet connection and try again.",
  UNAVAILABLE: "Couldn't reach ForgeNotes. Try again in a moment.",
  TIMED_OUT: 'Single sign-on timed out. Choose Sign in with SSO to try again.',
  EXPIRED: 'That sign-in took too long to finish. Choose Sign in with SSO to try again.',
  NOT_WAITING: 'That sign-in link arrived after the sign-in was cancelled or timed out. Choose Sign in with SSO to try again.',
  BAD_LINK: 'The sign-in link the browser sent back was not complete. Choose Sign in with SSO to try again.',
  SETUP_NEEDED: 'This app is not set up to reach ForgeNotes yet.',
  BROWSER_FAILED: "Couldn't open your web browser to sign in. Try again.",
}

// ---------- PKCE (RFC 7636) ----------
// 48 random bytes as unpadded base64url: 64 characters, all from the unreserved set.
function pkceVerifier(randomBytes = crypto.randomBytes) {
  return Buffer.from(randomBytes(48)).toString('base64url')
}

// BASE64URL(SHA256(ASCII(verifier))), unpadded: the S256 challenge.
function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(String(verifier), 'ascii').digest('base64url')
}

// ---------- the work email ----------
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

// "acme.com" from "Dana@Acme.com"; null when it is not an address on a domain. Same rule as the web.
function ssoDomainFromEmail(email) {
  const value = String(email || '').trim().toLowerCase()
  const at = value.lastIndexOf('@')
  if (at < 1) return null
  const domain = value.slice(at + 1).replace(/\.+$/, '')
  return DOMAIN_RE.test(domain) ? domain : null
}

// ---------- the callback link ----------
// The first command-line argument that is one of this app's links (Windows hands the link to the
// app as an argument; Chromium may put its own switches before it).
function findCallbackUrl(argv) {
  for (const arg of Array.isArray(argv) ? argv : []) {
    if (typeof arg !== 'string' || arg.length > MAX_URL_LENGTH) continue
    if (arg.toLowerCase().startsWith(`${SCHEME}:`)) return arg
  }
  return null
}

// Reads forgenotes-recorder://sso-callback?code=... (or ?error=...). Returns null for anything that
// is not that link, { code } for a code, and { error, description } for a refusal or a malformed
// link of ours. GoTrue answers in the query; the fragment is read too, as the web does.
function parseCallback(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${SCHEME}:`) return null
  if (url.hostname.toLowerCase() !== 'sso-callback') return null
  if (url.pathname !== '' && url.pathname !== '/') return null
  if (url.username || url.password || url.port) return null

  const query = url.searchParams
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  const read = (name) => String(fragment.get(name) || query.get(name) || '').trim()

  const error = read('error_code') || read('error')
  const description = read('error_description')
  if (error || description) return { error: (error || 'error').slice(0, 200), description: description.slice(0, 500) }

  const code = read('code')
  if (!code || code.length > MAX_CODE_LENGTH || !/^[A-Za-z0-9._~-]+$/.test(code)) {
    return { error: 'invalid_callback', description: '' }
  }
  return { code }
}

// ---------- refusals, in words ----------
// A refusal that came back on the callback (the IdP, the auth hook's 403, the database refusing the
// account). Mirrors ssoCallbackError on the web (src/lib/sso.js), with words for the rest.
function callbackErrorMessage(error, description) {
  const text = `${error || ''} ${description || ''}`.toLowerCase()
  if (/invalid_callback/.test(text)) return MESSAGES.BAD_LINK
  if (/requires single sign-on/.test(text)) return MESSAGES.SSO_REQUIRED
  if (/outside the domains|sso_email_outside_domains/.test(text)) return MESSAGES.OUTSIDE_DOMAINS
  if (/sso_provider_not_found|no sso provider/.test(text)) return MESSAGES.NOT_SET_UP
  if (/forgenotes_sso_link_refused/.test(text)) return MESSAGES.LINK_REFUSED
  if (/access_denied|unauthorized_client|saml.*(denied|refused|failed)|identity provider.*(denied|refused)/.test(text)) {
    return MESSAGES.IDP_REFUSED
  }
  if (/database error/.test(text)) return MESSAGES.DATABASE_REFUSED
  return MESSAGES.DID_NOT_FINISH
}

function bodyText(body) {
  const b = body || {}
  return `${b.error_code || ''} ${b.msg || ''} ${b.error || ''} ${b.error_description || ''} ${b.message || ''}`.toLowerCase()
}

// POST /auth/v1/sso refused.
function startErrorMessage(status, body) {
  const text = bodyText(body)
  if (status === 429 || /rate limit|too many/.test(text)) return MESSAGES.RATE_LIMITED
  if (/sso_provider_not_found|no sso provider/.test(text) || status === 404) return MESSAGES.NOT_SET_UP
  if (/saml.*disabled|sso.*disabled|not enabled/.test(text)) return MESSAGES.NOT_AVAILABLE
  if (/requires single sign-on/.test(text)) return MESSAGES.SSO_REQUIRED
  if (status >= 500) return MESSAGES.UNAVAILABLE
  return MESSAGES.COULD_NOT_START
}

// POST /auth/v1/token?grant_type=pkce refused.
function exchangeErrorMessage(status, body) {
  const text = bodyText(body)
  if (status === 429 || /rate limit|too many/.test(text)) return MESSAGES.RATE_LIMITED
  if (/flow_state_expired|expired/.test(text)) return MESSAGES.EXPIRED
  if (/requires single sign-on/.test(text)) return MESSAGES.SSO_REQUIRED
  if (/outside the domains|sso_email_outside_domains/.test(text)) return MESSAGES.OUTSIDE_DOMAINS
  if (/forgenotes_sso_link_refused/.test(text)) return MESSAGES.LINK_REFUSED
  if (/database error/.test(text)) return MESSAGES.DATABASE_REFUSED
  if (status >= 500) return MESSAGES.UNAVAILABLE
  return MESSAGES.DID_NOT_FINISH
}

// Only what the renderer's setAuth() reads; nothing else of GoTrue's answer crosses to the page.
function sessionForRenderer(data) {
  const user = data && data.user ? { id: data.user.id || null, email: data.user.email || '' } : null
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    expires_at: data.expires_at,
    user,
  }
}

// ---------- the flow ----------
// fetch, openExternal and getConfig are injected so tests can drive the whole flow. onResult gets
// { ok: true, session } or { ok: false, message, reason } once per sign-in that reaches step 2.
function createSsoFlow({
  fetch: fetchImpl,
  openExternal,
  getConfig,
  onResult = () => {},
  log = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  timeoutMs = FLOW_TIMEOUT_MS,
  randomBytes = crypto.randomBytes,
}) {
  let pending = null // { id, verifier, expiresAt, timer }
  let nextId = 1
  let generation = 0 // bumped by cancel(), so a start still talking to GoTrue is abandoned

  function drop() {
    if (!pending) return null
    const flow = pending
    pending = null
    try { clearTimer(flow.timer) } catch { /* already fired */ }
    return flow
  }

  async function config() {
    const cfg = (await getConfig()) || {}
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !/^https:\/\//i.test(cfg.supabaseUrl)) return null
    return { url: String(cfg.supabaseUrl).replace(/\/+$/, ''), key: cfg.supabaseAnonKey }
  }

  async function postJson(url, key, body) {
    let res
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      return { offline: true }
    }
    const data = await res.json().catch(() => ({}))
    return { status: res.status, ok: res.ok, data: data || {} }
  }

  // Whether to offer the button: the anon-callable forgenotes_sso_available(). Anything but true,
  // a failed call included, means no (the web and iPhone apps read it the same way).
  async function available() {
    const cfg = await config()
    if (!cfg) return false
    const answer = await postJson(`${cfg.url}/rest/v1/rpc/forgenotes_sso_available`, cfg.key, {})
    return Boolean(answer.ok && answer.data === true)
  }

  // Step 1 and the start of step 2. Resolves { ok: true, domain } once the browser was asked to
  // open, or { ok: false, message }.
  async function start(email) {
    const startedIn = ++generation // taken before any await, so a cancel() at any point counts
    if (!String(email || '').trim()) return { ok: false, message: MESSAGES.NEED_EMAIL }
    const domain = ssoDomainFromEmail(email)
    if (!domain) return { ok: false, message: MESSAGES.NOT_WORK_EMAIL }
    const cfg = await config()
    if (!cfg) return { ok: false, message: MESSAGES.SETUP_NEEDED }

    if (startedIn !== generation) return { ok: false, cancelled: true, message: '' }
    drop() // a new attempt replaces one still waiting
    const verifier = pkceVerifier(randomBytes)
    const answer = await postJson(`${cfg.url}/auth/v1/sso`, cfg.key, {
      domain,
      redirect_to: REDIRECT_URL,
      skip_http_redirect: true,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 's256',
    })
    if (startedIn !== generation) return { ok: false, cancelled: true, message: '' }
    if (answer.offline) return { ok: false, message: MESSAGES.OFFLINE }
    if (!answer.ok) {
      log(`sso: start refused: HTTP ${answer.status} ${answer.data.error_code || ''} ${answer.data.msg || answer.data.message || ''}`.trim())
      return { ok: false, message: startErrorMessage(answer.status, answer.data) }
    }
    let idpUrl
    try {
      idpUrl = new URL(String(answer.data.url || ''))
    } catch {
      idpUrl = null
    }
    if (!idpUrl || idpUrl.protocol !== 'https:') {
      log('sso: start answered without an https sign-in page')
      return { ok: false, message: MESSAGES.COULD_NOT_START }
    }

    const id = nextId++
    const timer = setTimer(() => {
      if (!pending || pending.id !== id) return
      drop()
      log('sso: timed out waiting for the browser')
      onResult({ ok: false, reason: 'timeout', message: MESSAGES.TIMED_OUT })
    }, timeoutMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    pending = { id, verifier, expiresAt: now() + timeoutMs, timer }

    try {
      await openExternal(idpUrl.toString())
    } catch {
      drop()
      return { ok: false, message: MESSAGES.BROWSER_FAILED }
    }
    log(`sso: browser opened for ${domain}`)
    return { ok: true, domain }
  }

  function cancel() {
    generation++
    const had = Boolean(drop())
    if (had) log('sso: cancelled')
    return had
  }

  // Step 3. Returns false when the link is not ours (the caller ignores it), true otherwise.
  async function handleUrl(raw) {
    const parsed = parseCallback(raw)
    if (!parsed) return false
    const flow = drop() // used once, whatever happens next
    if (!flow) {
      log('sso: callback arrived with no sign-in waiting; dropped')
      onResult({ ok: false, reason: 'not_waiting', message: MESSAGES.NOT_WAITING })
      return true
    }
    if (now() > flow.expiresAt) {
      onResult({ ok: false, reason: 'timeout', message: MESSAGES.TIMED_OUT })
      return true
    }
    if (parsed.error) {
      log(`sso: callback refused: ${parsed.error} ${parsed.description}`.trim())
      onResult({ ok: false, reason: 'refused', message: callbackErrorMessage(parsed.error, parsed.description) })
      return true
    }
    const cfg = await config()
    if (!cfg) {
      onResult({ ok: false, reason: 'setup', message: MESSAGES.SETUP_NEEDED })
      return true
    }
    const answer = await postJson(`${cfg.url}/auth/v1/token?grant_type=pkce`, cfg.key, {
      auth_code: parsed.code,
      code_verifier: flow.verifier,
    })
    if (answer.offline) {
      onResult({ ok: false, reason: 'offline', message: MESSAGES.OFFLINE })
      return true
    }
    if (!answer.ok || !answer.data.access_token || !answer.data.refresh_token) {
      log(`sso: code exchange refused: HTTP ${answer.status} ${answer.data.error_code || ''} ${answer.data.msg || answer.data.message || ''}`.trim())
      onResult({ ok: false, reason: 'refused', message: exchangeErrorMessage(answer.status, answer.data) })
      return true
    }
    log('sso: signed in')
    onResult({ ok: true, session: sessionForRenderer(answer.data) })
    return true
  }

  return { available, start, cancel, handleUrl, isWaiting: () => Boolean(pending) }
}

// ---------- getting the link to the running app ----------
// Links can arrive before the app is ready (a cold start from the link, or macOS's open-url before
// 'ready'); they wait here until ready() and are then handled in order.
function createUrlInbox(handle) {
  let isReady = false
  const queue = []
  return {
    deliver(url) {
      if (typeof url !== 'string') return
      if (isReady) void handle(url)
      else if (queue.length < 5) queue.push(url)
    },
    ready() {
      isReady = true
      for (const url of queue.splice(0)) void handle(url)
    },
  }
}

// Windows (and Linux): a link opens a second copy of the app with the link in its argv. Only the
// first copy keeps running; the second hands its argv over through 'second-instance' and quits.
// Returns false in the second copy (which should do nothing more).
function claimSingleInstance({ app, argv = process.argv, onUrl, onFocus = () => {} }) {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('second-instance', (_event, otherArgv) => {
    onFocus()
    const url = findCallbackUrl(otherArgv)
    if (url) onUrl(url)
  })
  const first = findCallbackUrl(argv)
  if (first) onUrl(first)
  return true
}

module.exports = {
  SCHEME,
  REDIRECT_URL,
  FLOW_TIMEOUT_MS,
  MESSAGES,
  pkceVerifier,
  pkceChallenge,
  ssoDomainFromEmail,
  findCallbackUrl,
  parseCallback,
  callbackErrorMessage,
  startErrorMessage,
  exchangeErrorMessage,
  sessionForRenderer,
  createSsoFlow,
  createUrlInbox,
  claimSingleInstance,
}
