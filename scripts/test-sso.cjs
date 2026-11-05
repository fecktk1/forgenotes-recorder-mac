// Sign in with SSO (sso.js): the PKCE pair, the callback link, the one waiting sign-in and its
// verifier, the refusals in words, and handing the link from a second copy of the app to the first.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const sso = require('../sso')

const CFG = { supabaseUrl: 'https://project.supabase.co', supabaseAnonKey: 'sb_publishable_test' }

test('PKCE: a 64-character unreserved verifier and its unpadded base64url S256 challenge', () => {
  const verifier = sso.pkceVerifier()
  assert.match(verifier, /^[A-Za-z0-9_-]{64}$/)
  assert.notEqual(sso.pkceVerifier(), verifier, 'fresh per sign-in')
  // RFC 7636 appendix B.
  assert.equal(sso.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  const challenge = sso.pkceChallenge(verifier)
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/, 'no padding')
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
})

test('the work email gives the domain', () => {
  assert.equal(sso.ssoDomainFromEmail('  Dana@Acme.COM '), 'acme.com')
  assert.equal(sso.ssoDomainFromEmail('dana@eu.acme.co.uk.'), 'eu.acme.co.uk')
  for (const bad of ['', 'dana', '@acme.com', 'dana@acme', 'dana@-acme.com', 'dana@acme..com', 'dana@acme.c0m']) {
    assert.equal(sso.ssoDomainFromEmail(bad), null, bad)
  }
})

test('the callback link: a code, a refusal, or not ours', () => {
  assert.equal(sso.REDIRECT_URL, 'forgenotes-recorder://sso-callback')
  const code = crypto.randomUUID()
  assert.deepEqual(sso.parseCallback(`forgenotes-recorder://sso-callback?code=${code}`), { code })
  assert.deepEqual(sso.parseCallback(`forgenotes-recorder://sso-callback/?code=${code}`), { code })
  assert.deepEqual(sso.parseCallback(`FORGENOTES-RECORDER://SSO-CALLBACK?code=${code}`), { code })
  assert.deepEqual(sso.parseCallback(`forgenotes-recorder://sso-callback#code=${code}`), { code })

  // Refusals: GoTrue puts them in the query (PKCE) or the fragment; error_code wins over error.
  assert.deepEqual(sso.parseCallback('forgenotes-recorder://sso-callback?error=access_denied&error_code=sso_email_outside_domains&error_description=outside+the+domains'), {
    error: 'sso_email_outside_domains',
    description: 'outside the domains',
  })
  assert.deepEqual(sso.parseCallback('forgenotes-recorder://sso-callback#error=server_error&error_description=Database+error+saving+new+user'), {
    error: 'server_error',
    description: 'Database error saving new user',
  })
  // An error beats a code that came with it.
  assert.equal(sso.parseCallback(`forgenotes-recorder://sso-callback?code=${code}&error=access_denied`).error, 'access_denied')

  // Ours, but malformed: no code, a code too long, a code with characters a code never has.
  for (const bad of [
    'forgenotes-recorder://sso-callback',
    'forgenotes-recorder://sso-callback?code=',
    `forgenotes-recorder://sso-callback?code=${'a'.repeat(4001)}`,
    'forgenotes-recorder://sso-callback?code=%3Cscript%3E',
    'forgenotes-recorder://sso-callback?code=a%20b',
  ]) {
    assert.deepEqual(sso.parseCallback(bad), { error: 'invalid_callback', description: '' }, bad.slice(0, 60))
  }

  // Not ours at all: ignored.
  for (const other of [
    `forgenotes://sso-callback?code=${code}`, // the iPhone app's scheme
    `https://sso-callback?code=${code}`,
    `forgenotes-recorder://integration-connect?code=${code}`,
    `forgenotes-recorder://sso-callback/extra?code=${code}`,
    `forgenotes-recorder://user:pw@sso-callback?code=${code}`,
    `forgenotes-recorder://sso-callback:99?code=${code}`,
    'not a url',
    `forgenotes-recorder://sso-callback?code=${'a'.repeat(9000)}`,
    null,
    42,
  ]) {
    assert.equal(sso.parseCallback(other), null, String(other).slice(0, 60))
  }
})

test('the link is found among the arguments of a second copy of the app', () => {
  const url = 'forgenotes-recorder://sso-callback?code=abc'
  assert.equal(sso.findCallbackUrl(['C:\\Program Files\\ForgeNotes Recorder\\ForgeNotes Recorder.exe', '--allow-file-access-from-files', url]), url)
  assert.equal(sso.findCallbackUrl(['electron.exe', '.', 'FORGENOTES-RECORDER://sso-callback?code=x']), 'FORGENOTES-RECORDER://sso-callback?code=x')
  assert.equal(sso.findCallbackUrl(['app.exe', '--flag', 'https://example.com']), null)
  assert.equal(sso.findCallbackUrl(['app.exe', `forgenotes-recorder://${'a'.repeat(9000)}`]), null)
  assert.equal(sso.findCallbackUrl(undefined), null)
})

test('refusals in words', () => {
  const M = sso.MESSAGES
  assert.equal(sso.startErrorMessage(404, { code: 404, error_code: 'sso_provider_not_found', msg: 'No SSO provider assigned for this domain' }), M.NOT_SET_UP)
  assert.equal(sso.startErrorMessage(400, { code: 400, error_code: 'sso_provider_not_found', msg: 'No SSO provider assigned for this domain' }), M.NOT_SET_UP)
  assert.equal(sso.startErrorMessage(400, { code: 400, error_code: 'saml_provider_disabled', msg: 'SAML 2.0 is disabled' }), M.NOT_AVAILABLE)
  assert.equal(sso.startErrorMessage(429, {}), M.RATE_LIMITED)
  assert.equal(sso.startErrorMessage(503, {}), M.UNAVAILABLE)
  assert.equal(sso.startErrorMessage(400, { msg: 'something new' }), M.COULD_NOT_START)

  assert.equal(sso.callbackErrorMessage('access_denied', 'The identity provider refused the sign-in'), M.IDP_REFUSED)
  assert.equal(sso.callbackErrorMessage('sso_email_outside_domains', ''), M.OUTSIDE_DOMAINS)
  assert.equal(sso.callbackErrorMessage('server_error', 'Your organization requires single sign-on. Use Sign in with SSO and your work email.'), M.SSO_REQUIRED)
  assert.equal(sso.callbackErrorMessage('server_error', 'forgenotes_sso_link_refused'), M.LINK_REFUSED)
  assert.equal(sso.callbackErrorMessage('server_error', 'Database error saving new user'), M.DATABASE_REFUSED)
  assert.equal(sso.callbackErrorMessage('invalid_callback', ''), M.BAD_LINK)
  assert.equal(sso.callbackErrorMessage('saml_assertion_invalid', ''), M.DID_NOT_FINISH)

  assert.equal(sso.exchangeErrorMessage(400, { error_code: 'flow_state_expired', msg: 'Flow state has expired' }), M.EXPIRED)
  assert.equal(sso.exchangeErrorMessage(403, { code: 403, msg: 'This sign-in was refused: your identity provider sent an address outside the domains it is set up for.' }), M.OUTSIDE_DOMAINS)
  assert.equal(sso.exchangeErrorMessage(403, { code: 403, msg: 'Your organization requires single sign-on. Use Sign in with SSO and your work email.' }), M.SSO_REQUIRED)
  assert.equal(sso.exchangeErrorMessage(404, { error_code: 'flow_state_not_found', msg: 'invalid flow state, no valid flow state found' }), M.DID_NOT_FINISH)
  for (const message of Object.values(M)) assert.doesNotMatch(message, /_|HTTP|\bnull\b/, 'no raw codes in what people read')
})

// A fake GoTrue: records requests and answers from a table.
function harness({ answers = {}, open } = {}) {
  const requests = []
  const results = []
  const opened = []
  const timers = []
  let clock = 1_000_000
  const flow = sso.createSsoFlow({
    getConfig: async () => CFG,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      requests.push({ url, headers: init.headers, body })
      const path = url.replace(CFG.supabaseUrl, '')
      const answer = answers[path]
      if (answer === 'offline') throw new TypeError('fetch failed')
      const [status, data] = typeof answer === 'function' ? answer(body) : answer || [500, {}]
      return { ok: status >= 200 && status < 300, status, json: async () => data }
    },
    openExternal: open || (async (url) => { opened.push(url) }),
    onResult: (result) => results.push(result),
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (t) => { if (t) t.cleared = true },
  })
  return { flow, requests, results, opened, timers, advance: (ms) => { clock += ms } }
}

const START = '/auth/v1/sso'
const EXCHANGE = '/auth/v1/token?grant_type=pkce'
const IDP = [200, { url: 'https://idp.example.com/saml?SAMLRequest=abc' }]
const SESSION = [200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, expires_at: 2_000_000_000, token_type: 'bearer', user: { id: 'u1', email: 'dana@acme.com', app_metadata: { provider: 'sso:1' } } }]

test('a whole sign-in: start, browser, callback, exchange with the same verifier', async () => {
  const h = harness({ answers: { [START]: IDP, [EXCHANGE]: SESSION } })
  assert.deepEqual(await h.flow.start('Dana@Acme.com'), { ok: true, domain: 'acme.com' })
  assert.deepEqual(h.opened, ['https://idp.example.com/saml?SAMLRequest=abc'])
  assert.equal(h.flow.isWaiting(), true)

  const startBody = h.requests[0].body
  assert.equal(h.requests[0].headers.apikey, CFG.supabaseAnonKey)
  assert.deepEqual(Object.keys(startBody).sort(), ['code_challenge', 'code_challenge_method', 'domain', 'redirect_to', 'skip_http_redirect'])
  assert.equal(startBody.domain, 'acme.com')
  assert.equal(startBody.redirect_to, 'forgenotes-recorder://sso-callback')
  assert.equal(startBody.skip_http_redirect, true)
  assert.equal(startBody.code_challenge_method, 's256')
  assert.equal(h.timers[0].ms, sso.FLOW_TIMEOUT_MS)

  assert.equal(await h.flow.handleUrl('forgenotes-recorder://sso-callback?code=1b2c3d'), true)
  const exchange = h.requests[1].body
  assert.equal(exchange.auth_code, '1b2c3d')
  assert.equal(sso.pkceChallenge(exchange.code_verifier), startBody.code_challenge, 'the verifier matches the challenge sent at the start')
  assert.equal(h.timers[0].cleared, true)
  assert.equal(h.flow.isWaiting(), false)
  assert.deepEqual(h.results, [{ ok: true, session: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, expires_at: 2_000_000_000, user: { id: 'u1', email: 'dana@acme.com' } } }])

  // The same link again (a replay, or the browser opening it twice) is not exchanged again.
  await h.flow.handleUrl('forgenotes-recorder://sso-callback?code=1b2c3d')
  assert.equal(h.requests.length, 2)
  assert.equal(h.results[1].reason, 'not_waiting')
})

test('each sign-in has its own verifier, and a new start replaces the one waiting', async () => {
  const h = harness({ answers: { [START]: IDP, [EXCHANGE]: SESSION } })
  await h.flow.start('dana@acme.com')
  await h.flow.start('dana@acme.com')
  assert.notEqual(h.requests[0].body.code_challenge, h.requests[1].body.code_challenge)
  assert.equal(h.timers[0].cleared, true, 'the first wait was dropped')
  await h.flow.handleUrl('forgenotes-recorder://sso-callback?code=abc')
  assert.equal(sso.pkceChallenge(h.requests[2].body.code_verifier), h.requests[1].body.code_challenge, 'the latest verifier is used')
})

test('a link with no sign-in waiting is never exchanged', async () => {
  const h = harness({ answers: { [EXCHANGE]: SESSION } })
  assert.equal(await h.flow.handleUrl('forgenotes-recorder://sso-callback?code=planted'), true)
  assert.equal(h.requests.length, 0)
  assert.deepEqual(h.results, [{ ok: false, reason: 'not_waiting', message: sso.MESSAGES.NOT_WAITING }])
  // And a link that is not ours is not even answered.
  assert.equal(await h.flow.handleUrl('https://example.com/?code=x'), false)
  assert.equal(h.results.length, 1)
})

test('the wait times out after five minutes and drops the verifier', async () => {
  const h = harness({ answers: { [START]: IDP, [EXCHANGE]: SESSION } })
  await h.flow.start('dana@acme.com')
  h.timers[0].fn()
  assert.equal(h.flow.isWaiting(), false)
  assert.deepEqual(h.results, [{ ok: false, reason: 'timeout', message: sso.MESSAGES.TIMED_OUT }])
  await h.flow.handleUrl('forgenotes-recorder://sso-callback?code=late')
  assert.equal(h.requests.length, 1, 'no exchange after the timeout')

  // The clock is checked too, in case the timer was held up (a sleeping computer).
  const h2 = harness({ answers: { [START]: IDP, [EXCHANGE]: SESSION } })
  await h2.flow.start('dana@acme.com')
  h2.advance(sso.FLOW_TIMEOUT_MS + 1)
  await h2.flow.handleUrl('forgenotes-recorder://sso-callback?code=late')
  assert.equal(h2.requests.length, 1)
  assert.equal(h2.results[0].reason, 'timeout')
})

test('cancel drops the waiting sign-in, including one still starting', async () => {
  const h = harness({ answers: { [START]: IDP, [EXCHANGE]: SESSION } })
  await h.flow.start('dana@acme.com')
  assert.equal(h.flow.cancel(), true)
  assert.equal(h.flow.cancel(), false)
  await h.flow.handleUrl('forgenotes-recorder://sso-callback?code=abc')
  assert.equal(h.requests.length, 1)

  let release
  const slow = harness({ answers: { [START]: IDP } })
  const gate = new Promise((resolve) => { release = resolve })
  const flow = sso.createSsoFlow({
    getConfig: async () => CFG,
    fetch: async () => { await gate; return { ok: true, status: 200, json: async () => IDP[1] } },
    openExternal: async (url) => slow.opened.push(url),
  })
  const starting = flow.start('dana@acme.com')
  flow.cancel()
  release()
  assert.equal((await starting).cancelled, true)
  assert.equal(slow.opened.length, 0, 'the browser is not opened for a cancelled start')
  assert.equal(flow.isWaiting(), false)
})

test('refusals on the way', async () => {
  const M = sso.MESSAGES
  let h = harness()
  assert.deepEqual(await h.flow.start(''), { ok: false, message: M.NEED_EMAIL })
  assert.deepEqual(await h.flow.start('dana'), { ok: false, message: M.NOT_WORK_EMAIL })
  assert.equal(h.requests.length, 0)

  h = harness({ answers: { [START]: [404, { code: 404, error_code: 'sso_provider_not_found', msg: 'No SSO provider assigned for this domain' }] } })
  assert.deepEqual(await h.flow.start('dana@gmail.com'), { ok: false, message: M.NOT_SET_UP })
  assert.equal(h.flow.isWaiting(), false)

  h = harness({ answers: { [START]: 'offline' } })
  assert.deepEqual(await h.flow.start('dana@acme.com'), { ok: false, message: M.OFFLINE })

  // Only an https sign-in page is ever opened.
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'http://idp.example.com', '']) {
    h = harness({ answers: { [START]: [200, { url }] } })
    assert.deepEqual(await h.flow.start('dana@acme.com'), { ok: false, message: M.COULD_NOT_START }, url)
    assert.equal(h.opened.length, 0)
  }

  h = harness({ answers: { [START]: IDP }, open: async () => { throw new Error('no browser') } })
  assert.deepEqual(await h.flow.start('dana@acme.com'), { ok: false, message: M.BROWSER_FAILED })
  assert.equal(h.flow.isWaiting(), false)

  // The IdP said no.
  h = harness({ answers: { [START]: IDP } })
  await h.flow.start('dana@acme.com')
  await h.flow.handleUrl('forgenotes-recorder://sso-callback?error=access_denied&error_description=User+not+assigned+to+app')
  assert.deepEqual(h.results, [{ ok: false, reason: 'refused', message: M.IDP_REFUSED }])
  assert.equal(h.requests.length, 1)

  // The hook refused the session at the exchange.
  h = harness({ answers: { [START]: IDP, [EXCHANGE]: [403, { code: 403, msg: 'This sign-in was refused: your identity provider sent an address outside the domains it is set up for.' }] } })
  await h.flow.start('dana@acme.com')
  await h.flow.handleUrl('forgenotes-recorder://sso-callback?code=abc')
  assert.deepEqual(h.results, [{ ok: false, reason: 'refused', message: M.OUTSIDE_DOMAINS }])

  // A link of ours that is broken.
  h = harness({ answers: { [START]: IDP } })
  await h.flow.start('dana@acme.com')
  await h.flow.handleUrl('forgenotes-recorder://sso-callback')
  assert.deepEqual(h.results, [{ ok: false, reason: 'refused', message: M.BAD_LINK }])
})

test('the button is offered only when the server says SSO is on', async () => {
  const on = harness({ answers: { '/rest/v1/rpc/forgenotes_sso_available': [200, true] } })
  assert.equal(await on.flow.available(), true)
  for (const answer of [[200, false], [200, 'true'], [404, {}], [500, true], 'offline']) {
    const h = harness({ answers: { '/rest/v1/rpc/forgenotes_sso_available': answer } })
    assert.equal(await h.flow.available(), false, JSON.stringify(answer))
  }
  const unset = sso.createSsoFlow({ getConfig: async () => ({ supabaseUrl: '', supabaseAnonKey: '' }), fetch: () => assert.fail('no request'), openExternal: () => {} })
  assert.equal(await unset.available(), false)
  assert.deepEqual(await unset.start('dana@acme.com'), { ok: false, message: sso.MESSAGES.SETUP_NEEDED })
})

test('links that arrive before the app is ready wait, then are handled in order', () => {
  const handled = []
  const inbox = sso.createUrlInbox((url) => handled.push(url))
  inbox.deliver('forgenotes-recorder://sso-callback?code=1')
  inbox.deliver('forgenotes-recorder://sso-callback?code=2')
  assert.deepEqual(handled, [])
  inbox.ready()
  assert.deepEqual(handled, ['forgenotes-recorder://sso-callback?code=1', 'forgenotes-recorder://sso-callback?code=2'])
  inbox.deliver('forgenotes-recorder://sso-callback?code=3')
  assert.equal(handled.length, 3)
})

test('single instance: the second copy hands its link to the first and quits', () => {
  // The first copy: holds the lock, listens for second-instance.
  class FakeApp extends EventEmitter {
    constructor(lock) { super(); this.lock = lock; this.quit = () => { this.quitCalled = true } }
    requestSingleInstanceLock() { return this.lock }
  }
  const first = new FakeApp(true)
  const urls = []
  let focused = 0
  assert.equal(sso.claimSingleInstance({ app: first, argv: ['app.exe'], onUrl: (u) => urls.push(u), onFocus: () => focused++ }), true)
  assert.equal(first.quitCalled, undefined)

  // The second copy, started by Windows for the link: no lock, quits, handles nothing itself.
  const second = new FakeApp(false)
  const secondUrls = []
  assert.equal(sso.claimSingleInstance({ app: second, argv: ['app.exe', 'forgenotes-recorder://sso-callback?code=abc'], onUrl: (u) => secondUrls.push(u) }), false)
  assert.equal(second.quitCalled, true)
  assert.deepEqual(secondUrls, [])

  // Electron delivers the second copy's argv to the first.
  first.emit('second-instance', {}, ['app.exe', '--some-chromium-switch', 'forgenotes-recorder://sso-callback?code=abc'], 'C:\\')
  assert.deepEqual(urls, ['forgenotes-recorder://sso-callback?code=abc'])
  assert.equal(focused, 1)
  // Opening the app again without a link only brings the window forward.
  first.emit('second-instance', {}, ['app.exe'], 'C:\\')
  assert.equal(urls.length, 1)
  assert.equal(focused, 2)

  // A cold start from the link (the app was not running): the link is in this copy's own argv.
  const cold = new FakeApp(true)
  const coldUrls = []
  sso.claimSingleInstance({ app: cold, argv: ['app.exe', 'forgenotes-recorder://sso-callback?code=cold'], onUrl: (u) => coldUrls.push(u) })
  assert.deepEqual(coldUrls, ['forgenotes-recorder://sso-callback?code=cold'])
})
