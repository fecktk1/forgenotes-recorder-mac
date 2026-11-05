// ForgeNotes Recorder (macOS). Captures the microphone and the call audio as separate
// one-minute segments, checkpointed locally before optional upload. Call audio comes from
// macOS itself on 14.2 and later (a Core Audio tap, through getDisplayMedia) and from the
// BlackHole input elsewhere: one or the other, decided in system-audio.js, never both.
// A crash can lose the current segment; completed checkpoints remain recoverable.
//
// Time: the recording's clock (capture-clock.js) stops while paused and while the Mac
// sleeps, so segment offsets and durations count captured audio only; a suspend ends the
// segment and a resume starts a new one. The true start and end are kept with the local
// recording and sent as started_at / ended_at, however late the upload is.
// Stop on silence (silence.js): off unless the person turned it on.
'use strict'

const SA = window.FNSystemAudio

const $ = (id) => document.getElementById(id)
const show = (id) => $(id).classList.remove('hidden')
const hide = (id) => $(id).classList.add('hidden')

const ROTATE_MS = 60 * 1000 // segment length — keeps each uploaded file small
const HEARTBEAT_MS = 500 // the timer display and the recording clock's sleep check

// Played once through the default audio output when a recording starts. The wording must
// match the pre-rendered clips in renderer/announce/ ("phrase" in voices.json).
const ANNOUNCE_TEXT = 'This meeting is being recorded.'
const ANNOUNCE_KEY = 'fn_announce_recording' // localStorage: 'false' = off, anything else = on
const ANNOUNCE_VOICE_KEY = 'fn_announce_voice' // localStorage: a voice id from voices.json
const ANNOUNCE_VOICES_WAIT_MS = 1000 // longest the announcement waits for the voice list
const ANNOUNCE_START_TIMEOUT_MS = 5000 // the clip never started playing — tell the user

let CFG = null
let analytics = null
let auth = null // { access_token, refresh_token, expires_at(ms), email }
let rec = null // active recording state
let preflightMeter = null // live mic meter used by the pre-record device check
let announceVoices = { voices: [], defaultId: '' } // from renderer/announce/voices.json
let announceVoicesLoaded = Promise.resolve() // settles once the voice list has been read
let announceClip = null // the announcement or preview clip that is playing, if any

// Call audio. The preference is the one setting ('auto' or 'blackhole'); "asked" records that
// macOS has already answered the permission question for native capture, so the app knows
// whether opening the capture can still raise the macOS window.
const SYSTEM_AUDIO_PREF_KEY = 'fn_system_audio_pref'
const NATIVE_ASKED_KEY = 'fn_native_audio_asked'
// Waits around the macOS permission window. Measured on macOS 27 with Electron 43: while the
// window is unanswered, the display-media request neither resolves nor rejects, and it was
// still pending 88 s later, so every wait on it here is bounded.
const NATIVE_WAIT = {
  answerMs: 70 * 1000, // first request: macOS gives up on an unanswered window after 60 s
  unansweredAfterMs: 55 * 1000, // a track ending this late is that timeout, not a refusal
  settleMs: 2500, // permission already answered: frames arrive or the track ends fast
  startMs: 4000, // at Start and when reopening: never hold the recording up longer than this
  abandonMs: 80 * 1000, // a request macOS has not answered by now will never be answered
}
const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
const REACQUIRE_DELAYS_MS = [300, 1500, 4000] // a track ended mid-recording: reopen it
let systemAudioInfo = { platform: 'darwin', systemVersion: '', nativeSupported: false, nativeMinVersion: SA.NATIVE_MIN_MACOS_LABEL }
let nativeCheck = null // the native call-audio check in flight, if any (one at a time)
let nativeOpening = null // a native capture request macOS has not answered yet: { startedAt, late }
let starting = false // Start pressed and not yet recording (it can wait on the macOS window)

// ---------------------------------------------------------------- boot
async function boot() {
  CFG = await window.desktop.getConfig()
  try {
    systemAudioInfo = { ...systemAudioInfo, ...(await window.desktop.systemAudioInfo()) }
  } catch (e) {
    console.warn('[forgenotes] could not read the system-audio capability:', (e && e.message) || e)
  }
  const verEl = $('app-version')
  if (verEl && CFG.version) verEl.textContent = `v${CFG.version}`
  wireUpdateBadge(verEl)
  analytics = FnAnalytics.createAnalytics({ rpc: callRpc, platform: 'macos', version: CFG.version || 'unknown' })
  $('analytics-choice').addEventListener('change', async event => {
    const desired = event.target.checked
    event.target.disabled = true
    try { event.target.checked = await analytics.setEnabled(desired); $('analytics-status').textContent = 'Account preference saved.' }
    catch { event.target.checked = false; $('analytics-status').textContent = 'Could not save. Analytics is off on this device; retry to update your account.' }
    finally { event.target.disabled = false }
  })
  wireEvents()
  if (CFG._parseError || !CFG.supabaseUrl || !CFG.supabaseAnonKey) {
    if (CFG._parseError) {
      const detail = document.querySelector('#config-error p')
      if (detail) {
        detail.textContent = `${CFG._parseError}. Open config.json and make sure every value — especially the publishable key — is wrapped in double quotes, then restart.`
      }
    }
    show('config-error')
    show('login-view')
    $('login-btn').disabled = true
    await refreshPending()
    return
  }
  void offerSso()
  const refresh = await window.desktop.secureGet()
  if (refresh) {
    try {
      await refreshSession(refresh)
      await enterRecorder()
    } catch (e) {
      // A team that turned on Require SSO refuses a password session at its next refresh.
      if (e && e.message === FnSignIn.SSO_REQUIRED) showLoginError(e.message)
      show('login-view')
    }
  } else {
    show('login-view')
  }
  await refreshPending()
}

// Updates install on quit, never mid-session, so the badge is the only signal a user
// gets that a newer build is already staged. Deliberately passive — nothing to click,
// nothing that could interrupt a recording in progress.
function wireUpdateBadge(verEl) {
  if (!verEl || !window.desktop.onUpdateState) return
  const render = (state) => {
    if (state?.status !== 'ready') return
    verEl.textContent = `v${CFG.version} · update ready`
    verEl.classList.add('brand-ver-update')
    verEl.title = `Version ${state.version} has been downloaded and installs the next time you quit ForgeNotes Recorder.`
  }
  // Poll once as well as subscribe: the download can finish before this view loads.
  window.desktop.getUpdateState().then(render).catch(() => {})
  window.desktop.onUpdateState(render)
}

// ---------------------------------------------------------------- auth (GoTrue REST)
async function signIn(email, password) {
  let res
  try {
    res = await fetch(`${CFG.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: CFG.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    throw new Error(FnSignIn.OFFLINE)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // The server's own words go to the log for support; the person gets FnSignIn's copy.
    await diag(['sign-in refused: HTTP', res.status, data.error_code, data.msg || data.error_description || data.message].filter(Boolean).join(' '))
    throw new Error(FnSignIn.signInFailureMessage(res.status, data))
  }
  setAuth(data)
}

async function refreshSession(refreshToken) {
  const res = await fetch(`${CFG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: CFG.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  const data = await res.json().catch(() => ({}))
  // A refused key is this build's problem, not the session's: say so instead of "session_expired".
  if (FnSignIn.isAppKeyRefused(res.status, data)) throw new Error(FnSignIn.APP_KEY_REFUSED)
  if (res.status === 403 && FnSignIn.signInFailureMessage(403, data) === FnSignIn.SSO_REQUIRED) throw new Error(FnSignIn.SSO_REQUIRED)
  if (!res.ok || !data.access_token) throw new Error('session_expired')
  setAuth(data)
}

function setAuth(data) {
  auth = {
    user_id: data.user?.id || auth?.user_id,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3600) * 1000,
    email: (data.user && data.user.email) || (auth && auth.email) || '',
  }
  window.desktop.secureSet(data.refresh_token)
  void analytics?.identify(auth.user_id).then(value => { $('analytics-choice').checked = value })
}

async function getToken() {
  if (!auth) throw new Error('Not signed in')
  if (Date.now() > auth.expires_at - 60000) await refreshSession(auth.refresh_token)
  return auth.access_token
}

// ---------------------------------------------------------------- Sign in with SSO
// Main runs the flow (sso.js): it opens the identity provider in the browser and, when the
// browser comes back on forgenotes-recorder://sso-callback, exchanges the code and sends the
// session here. The button shows only when ForgeNotes says single sign-on is on.
async function offerSso() {
  let on = false
  try { on = (await window.desktop.ssoAvailable()) === true } catch { on = false }
  $('sso-block').classList.toggle('hidden', !on)
}

function showLoginError(text) {
  $('login-error').textContent = text
  show('login-error')
}

function setSsoWaiting(waiting) {
  $('sso-wait').classList.toggle('hidden', !waiting)
  $('sso-btn').disabled = waiting
  $('login-btn').disabled = waiting
  if (waiting) $('sso-wait').scrollIntoView({ block: 'nearest' })
}

async function startSso() {
  hide('login-error')
  setSsoWaiting(true)
  let started
  try {
    started = await window.desktop.ssoStart($('login-email').value.trim())
  } catch {
    started = { ok: false, message: 'Single sign-on could not start. Try again.' }
  }
  if (started && started.ok) return // waiting for the browser; onSsoResult finishes it
  setSsoWaiting(false)
  if (started && started.message) showLoginError(started.message)
}

async function onSsoResult(result) {
  setSsoWaiting(false)
  if (!result || !result.ok) {
    if (result && result.message && !auth) showLoginError(result.message)
    return
  }
  if (auth) return // already signed in (a stray second result)
  try {
    setAuth(result.session)
    hide('login-error')
    await diag('sign-in: single sign-on')
    await enterRecorder()
  } catch (e) {
    showLoginError((e && e.message) || 'Single sign-on did not finish. Try again.')
  }
}

async function signOut() {
  analytics?.reset()
  $('analytics-choice').checked = false
  auth = null
  stopPreflightMeter()
  await window.desktop.secureClear()
  hide('recorder-view')
  show('login-view')
}

// ---------------------------------------------------------------- edge fn call
async function callFn(name, options = {}) {
  return analytics.operation(name, () => callFnRaw(name, options))
}

async function callFnRaw(name, { body, formData } = {}) {
  const token = await getToken()
  const headers = { apikey: CFG.supabaseAnonKey, Authorization: `Bearer ${token}` }
  if (!formData) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${CFG.supabaseUrl}/functions/v1/${name}`, {
    method: 'POST',
    headers,
    body: formData || JSON.stringify(body || {}),
  })
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    // Surface the server's detail (e.g. the real Storage error) and keep the HTTP status
    // on the error so the upload loop can tell a 4xx rejection from a retryable 5xx.
    // A non-JSON body means the response came from an upstream proxy/WAF, not ForgeNotes —
    // include a text snippet of it (e.g. a Cloudflare block page with its Ray ID).
    const rawSnippet = data.raw
      ? String(data.raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
      : ''
    const message = data.detail
      ? `${data.error || 'error'}: ${data.detail}`
      : (data.error || data.message || `${name} failed (${res.status})${rawSnippet ? `: ${rawSnippet}` : ''}`)
    const err = new Error(message)
    err.httpStatus = res.status
    throw err
  }
  return data
}

// ---------------------------------------------------------------- database function call
// PostgREST RPC as the signed-in person (the capture setting lives behind two of these).
async function callRpc(name, args, expectedUser) {
  const token = await getToken()
  if (expectedUser && auth?.user_id !== expectedUser) throw new Error('Account changed')
  const res = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: CFG.supabaseAnonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `${name} failed (${res.status})`)
    err.httpStatus = res.status
    throw err
  }
  return data
}

// ---------------------------------------------------------------- recorder view
async function enterRecorder() {
  hide('login-view')
  show('recorder-view')
  $('account-email').textContent = auth?.email || 'Recording locally'
  $('signout-btn').textContent = auth ? 'Sign out' : 'Sign in'
  void loadSilenceSetting()
  await populateMics()
  runPreflight()
}

// ---------------------------------------------------------------- stop on silence: the setting
// Stored per account on the server (the web recorder's setting), read here when signed in,
// and the last value seen is kept in localStorage: Start reads that copy and never waits for
// the network. Signed out, a choice is kept on this Mac only. With nothing seen, off.
let silenceMinutes = FnSilence.SILENCE_DEFAULT_MINUTES
let silenceRequest = 0 // the newest load or save wins

function prefs() {
  try { return window.localStorage } catch { return null }
}

function renderSilenceSetting(minutes) {
  silenceMinutes = minutes
  const sel = $('silence-minutes')
  sel.replaceChildren()
  for (const option of FnSilence.silenceOptions(minutes)) {
    const opt = document.createElement('option')
    opt.value = String(option.minutes)
    opt.textContent = option.label
    sel.appendChild(opt)
  }
  sel.value = String(minutes)
  const more = $('silence-more')
  if (minutes > 0) {
    more.textContent = 'The question comes as a chime, a notification and the window title. A very quiet voice, ' +
      'or a voice over a steady noise such as a fan, can be taken for silence, which is why it always asks first. ' +
      'Pausing a recording is not silence. ' +
      (auth ? 'Your choice is kept with your account, so it also applies when you record on the web.' : 'While you are signed out it is kept on this Mac.')
    show('silence-more')
  } else {
    hide('silence-more')
  }
}

function setSilenceMessage(text, ok) {
  const el = $('silence-message')
  if (!text) {
    el.textContent = ''
    hide('silence-message')
    return
  }
  el.textContent = text
  el.classList.toggle('saved-ok', ok)
  el.classList.toggle('saved-error', !ok)
  show('silence-message')
}

async function loadSilenceSetting() {
  const request = ++silenceRequest
  hide('silence-load-failed')
  const cached = FnSilence.readCachedSilenceMinutes(prefs())
  if (!auth || !CFG || !CFG.supabaseUrl) {
    renderSilenceSetting(cached)
    return
  }
  try {
    const minutes = FnSilence.silenceMinutesFrom(await callRpc('forgenotes_capture_settings'))
    if (request !== silenceRequest) return
    FnSilence.cacheSilenceMinutes(minutes, prefs())
    renderSilenceSetting(minutes)
  } catch (e) {
    if (request !== silenceRequest) return
    renderSilenceSetting(cached)
    $('silence-load-text').textContent = 'Your recording setting could not be loaded. Until it can, recordings here ' +
      (cached === 0 ? 'keep going until you stop them.' : `use the choice this app last saw: stop after ${FnSilence.describeDuration(cached * 60000)} of silence.`)
    show('silence-load-failed')
    void diag(`silence setting could not be loaded: ${e.message}`)
  }
}

async function saveSilenceSetting(value) {
  const request = ++silenceRequest
  const previous = silenceMinutes
  const sel = $('silence-minutes')
  sel.disabled = true
  setSilenceMessage('')
  try {
    let saved
    if (auth) {
      saved = FnSilence.silenceMinutesFrom(await callRpc('forgenotes_set_capture_settings', { p_silence_stop_minutes: value }))
    } else {
      saved = FnSilence.normalizeSilenceMinutes(value)
    }
    FnSilence.cacheSilenceMinutes(saved, prefs())
    if (request === silenceRequest) {
      hide('silence-load-failed')
      renderSilenceSetting(saved)
      setSilenceMessage(FnSilence.silenceSettingSentence(saved, { local: !auth, recording: Boolean(rec), place: 'this Mac' }), true)
    }
  } catch (e) {
    if (request === silenceRequest) {
      renderSilenceSetting(previous)
      setSilenceMessage('That setting could not be saved. Try again.', false)
    }
    void diag(`silence setting could not be saved: ${e.message}`)
  } finally {
    sel.disabled = false
  }
}

// ---------------------------------------------------------------- preflight
function captureProfile() {
  return $('mode-room')?.classList.contains('active') ? 'room_single_mic' : 'remote_dual_track'
}

function setCaptureProfile(profile, { syncSource = true, check = true } = {}) {
  const room = profile === 'room_single_mic'
  $('mode-room').classList.toggle('active', room)
  $('mode-online').classList.toggle('active', !room)
  $('system-audio-fields').classList.toggle('hidden', room)
  $('meter-system-row').classList.toggle('hidden', room)
  $('mic-label').textContent = room ? 'Room microphone' : 'Microphone'
  $('cap-mic').textContent = room ? 'Room mic' : 'You (mic)'
  $('mode-hint').textContent = room
    ? 'Uses one microphone for everyone in the room and separates speakers during transcription.'
    : systemAudioChoice().path === 'native'
      ? 'Captures your microphone and the call audio as separate tracks.'
      : 'Captures your microphone and the call audio (through BlackHole) as separate tracks.'
  renderConsentCopy()
  if (syncSource) {
    if (room) $('source').value = 'in_person'
    else if ($('source').value === 'in_person') $('source').value = 'other'
  }
  localStorage.setItem('forgenotes_capture_profile', room ? 'room_single_mic' : 'remote_dual_track')
  if (check && !rec) runPreflight()
}

// The consent line has to stay truthful: it only promises the spoken notice while the
// "Announce recording aloud" setting is on.
function renderConsentCopy() {
  const room = captureProfile() === 'room_single_mic'
  const base = room
    ? '🔴 Recording captures everyone in the room. Place the microphone near the center and make sure all participants consent.'
    : '🔴 Recording captures your mic and (if enabled) everyone on the call. Make sure participants consent before you start.'
  const spoken = room
    ? ` ForgeNotes will say “${ANNOUNCE_TEXT}” when you start — people in the room only hear it if your speakers are on.`
    : ` ForgeNotes will say “${ANNOUNCE_TEXT}” when you start — people on a call only hear it if your speakers are on.`
  $('consent-copy').textContent = announceEnabled() ? base + spoken : base
}

// ---------------------------------------------------------------- call audio: which path
function storedSystemAudioPref() {
  try { return localStorage.getItem(SYSTEM_AUDIO_PREF_KEY) } catch { return null }
}

// { path: 'native' | 'blackhole', nativeSupported, reason }. The single place the renderer
// decides how call audio is captured.
function systemAudioChoice() {
  return SA.choosePath({
    platform: systemAudioInfo.platform,
    systemVersion: systemAudioInfo.systemVersion,
    preference: storedSystemAudioPref(),
  })
}

function nativeAsked() {
  try { return localStorage.getItem(NATIVE_ASKED_KEY) === '1' } catch { return false }
}

function setNativeAsked(asked) {
  try {
    if (asked) localStorage.setItem(NATIVE_ASKED_KEY, '1')
    else localStorage.removeItem(NATIVE_ASKED_KEY)
  } catch { /* storage unavailable: the app asks again next time */ }
}

// Shows the controls of the path in use and hides the other one's. A Mac that records call
// audio natively never sees the BlackHole instructions unless its user picks BlackHole.
function renderSystemAudioFields() {
  const choice = systemAudioChoice()
  const native = choice.path === 'native'
  $('native-audio-fields').classList.toggle('hidden', !native)
  $('blackhole-fields').classList.toggle('hidden', native)
  $('system-audio-pref-row').classList.toggle('hidden', !choice.nativeSupported)
  $('system-audio-pref').value = native ? 'auto' : 'blackhole'
  $('first-run-audio').textContent = native
    ? 'Call audio is recorded by macOS itself: there is nothing to install.'
    : choice.nativeSupported
      ? ''
      : `On this version of macOS, call audio needs the free BlackHole driver (the README has the steps). macOS ${systemAudioInfo.nativeMinVersion} and later record it without a driver.`
}

// ---------------------------------------------------------------- call audio: native capture
// Audio only. Main answers with Electron's system-audio loopback and never grants a video
// source, so macOS is asked for "System Audio Recording Only" and not for Screen Recording.
function openNativeSystemStream() {
  return navigator.mediaDevices.getDisplayMedia({ audio: { ...RAW_AUDIO }, video: false })
}

// Asks macOS for call audio and waits at most waitMs for it.
//   resolves to the stream   macOS handed one over (it may already have ended: a refusal)
//   resolves to null         macOS has not answered yet (its permission window is open).
//                            If the stream arrives later, onLate receives it; with no
//                            onLate it is closed.
//   rejects                  the request was refused before reaching macOS
// Only one request is ever outstanding: while macOS is still deciding an earlier one, a new
// call does not ask again, it takes over the late delivery of that one.
function openNativeWithin(waitMs, onLate) {
  if (nativeOpening && performance.now() - nativeOpening.startedAt < NATIVE_WAIT.abandonMs) {
    nativeOpening.late = onLate || null
    return Promise.resolve(null)
  }
  const pending = { startedAt: performance.now(), late: onLate || null }
  nativeOpening = pending // an older, abandoned request is closed if it ever arrives
  return new Promise((resolve, reject) => {
    let waiting = true
    const timer = setTimeout(() => {
      waiting = false
      resolve(null)
    }, waitMs)
    openNativeSystemStream().then((stream) => {
      const current = nativeOpening === pending
      if (current) nativeOpening = null
      if (waiting) {
        waiting = false
        clearTimeout(timer)
        resolve(stream)
      } else if (current && pending.late) {
        pending.late(stream)
      } else {
        stream.getTracks().forEach((t) => t.stop())
      }
    }, (error) => {
      if (nativeOpening === pending) nativeOpening = null
      if (waiting) {
        waiting = false
        clearTimeout(timer)
        reject(error)
      }
    })
  })
}

// Frames macOS has delivered to a track so far, or null where Chromium cannot say.
function deliveredFrames(track) {
  try {
    const stats = track && track.stats
    return stats && typeof stats.deliveredFrames === 'number' ? stats.deliveredFrames : null
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Waits for a native track that macOS has handed over to prove itself. A refusal is only
// reported by the track ending, with no error (Electron's desktopCapturer docs call it a
// dead stream).
//   'ok'        audio frames are arriving (silence counts: frames, not loudness)
//   'ended'     macOS refused
//   'no_frames' still live after waitMs but nothing has been delivered
async function settleNativeTrack(track, waitMs) {
  const started = performance.now()
  for (;;) {
    if (!track || track.readyState === 'ended') return 'ended'
    const frames = deliveredFrames(track)
    if (frames === null) {
      // No frame counter in this Chromium: a track still live after a moment is the best
      // evidence available.
      if (performance.now() - started >= 1200) return 'ok'
    } else if (frames > 0) {
      return 'ok'
    }
    if (performance.now() - started >= waitMs) return 'no_frames'
    await sleep(150)
  }
}

function renderNativeAudioState(state) {
  const copy = state === 'checking'
    ? { row: 'checking', text: 'Checking…', allow: false, settings: false }
    : SA.nativePermissionCopy(state)
  // A check can finish after the user has moved to the room setup or to BlackHole: the
  // device-check row then belongs to that setup and is left alone.
  if (captureProfile() === 'remote_dual_track' && systemAudioChoice().path === 'native') {
    setPreflightRow('system', copy.row, 'Call audio', copy.text)
  }
  $('native-audio-allow').classList.toggle('hidden', !copy.allow)
  $('native-audio-settings').classList.toggle('hidden', !copy.settings)
  const status = $('native-audio-status')
  if (state === 'ready') status.textContent = 'macOS records the call audio directly. No driver and no audio routing.'
  else if (state === 'checking') status.textContent = 'Checking call audio…'
  else status.textContent = copy.text
}

// Judges a stream macOS handed over for a check, closes it, and returns
// 'ok' | 'ended' | 'no_frames' (see settleNativeTrack).
async function judgeNativeStream(stream, requestedAt, waitMs) {
  try {
    let outcome = await settleNativeTrack(stream.getAudioTracks()[0], waitMs)
    // A track that ends about a minute after the request was not refused by a person:
    // macOS gave up on an unanswered window. Still unanswered.
    if (outcome === 'ended' && performance.now() - requestedAt >= NATIVE_WAIT.unansweredAfterMs) outcome = 'no_frames'
    return outcome
  } finally {
    stream.getTracks().forEach((t) => t.stop())
  }
}

// Records what macOS answered and shows it. Returns the state shown:
// 'ready' | 'denied' | 'unanswered'.
async function applyNativeOutcome(outcome) {
  // 'ok' and 'ended' are both answers from macOS; its window will not appear again.
  if (outcome === 'ok' || outcome === 'ended') setNativeAsked(true)
  const state = outcome === 'ok' ? 'ready' : outcome === 'no_frames' ? 'unanswered' : 'denied'
  await diag(`system-audio: native check -> ${outcome} (${state})`)
  if (!rec) renderNativeAudioState(state)
  return state
}

// Opens native call audio for a moment to learn whether macOS allows it, then closes it.
// Nothing is recorded. With interactive false this never raises the macOS window: a Mac
// that has not been asked yet is only told what to click. Resolves to the state shown:
// 'ready' | 'needs_permission' | 'denied' | 'unanswered'. Always resolves, and within
// NATIVE_WAIT.answerMs: an answer that comes later still updates the device check.
function checkNativeAudio({ interactive = false } = {}) {
  if (nativeCheck) return nativeCheck
  const run = async () => {
    const asked = nativeAsked()
    if (!asked && !interactive && !nativeOpening) {
      renderNativeAudioState('needs_permission')
      return 'needs_permission'
    }
    renderNativeAudioState(asked ? 'checking' : 'asking')
    const requestedAt = nativeOpening ? nativeOpening.startedAt : performance.now()
    const waitMs = asked ? NATIVE_WAIT.settleMs : NATIVE_WAIT.answerMs
    let outcome = 'absent'
    try {
      const stream = await openNativeWithin(waitMs, (late) => {
        // The macOS window was answered after this check stopped waiting.
        void judgeNativeStream(late, requestedAt, NATIVE_WAIT.settleMs).then(applyNativeOutcome)
      })
      outcome = stream ? await judgeNativeStream(stream, requestedAt, NATIVE_WAIT.settleMs) : 'no_frames'
    } catch (e) {
      console.warn('[forgenotes] native call audio could not be opened:', (e && e.name) || '', (e && e.message) || e)
    }
    return applyNativeOutcome(outcome)
  }
  nativeCheck = run().finally(() => { nativeCheck = null })
  return nativeCheck
}

// A pre-record device check: is the mic live (with a level meter to prove it), will call
// audio be captured (natively, or through a selected BlackHole input), and is there enough
// disk for a long meeting? Informational — Start still works; capture errors also surface
// on Start.
function setPreflightRow(id, state, label, detail) {
  const panel = $('preflight-results')
  let row = document.getElementById(`pf-${id}`)
  if (!row) {
    row = document.createElement('li')
    row.id = `pf-${id}`
    row.innerHTML = '<span class="pf-ic"></span><span class="pf-body"><span class="pf-label"></span><span class="pf-detail"></span></span>'
    panel.appendChild(row)
  }
  row.className = `pf-row ${state}`
  row.querySelector('.pf-ic').textContent = { checking: '…', ok: '✓', warn: '!', fail: '✕', skip: '–' }[state] || '…'
  row.querySelector('.pf-label').textContent = label
  row.querySelector('.pf-detail').textContent = detail
}

function stopPreflightMeter() {
  if (preflightMeter) { preflightMeter.stop(); preflightMeter = null }
}

function startPreflightMeter(stream) {
  stopPreflightMeter()
  let ctx
  try { ctx = new AudioContext() } catch { return }
  const src = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  src.connect(analyser)
  const data = new Uint8Array(analyser.fftSize)
  let raf = 0
  const tick = () => {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (const v of data) { const x = (v - 128) / 128; sum += x * x }
    const level = Math.min(100, Math.round(Math.sqrt(sum / data.length) * 280))
    const el = $('pf-meter-fill')
    if (el) el.style.width = `${level}%`
    raf = requestAnimationFrame(tick)
  }
  tick()
  show('pf-meter')
  preflightMeter = {
    stop() {
      if (raf) cancelAnimationFrame(raf)
      ctx.close().catch(() => {})
      stream.getTracks().forEach((t) => t.stop())
      const el = $('pf-meter-fill')
      if (el) el.style.width = '0%'
      hide('pf-meter')
    },
  }
}

async function runPreflight() {
  if (rec) return // don't probe devices mid-recording
  setPreflightRow('mic', 'checking', 'Microphone', 'Checking…')
  setPreflightRow('system', 'checking', 'Call audio source', 'Checking…')
  setPreflightRow('disk', 'checking', 'Disk space', 'Checking…')

  // Mic: open the selected device and run a live meter so the user can SEE input.
  try {
    const micId = $('mic').value
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    startPreflightMeter(stream)
    const micTrack = stream.getAudioTracks()[0]
    const bluetooth = SA.looksLikeBluetoothMic({ label: micTrack && micTrack.label, sampleRate: micTrack && micTrack.getSettings().sampleRate })
    if (bluetooth) setPreflightRow('mic', 'warn', 'Microphone', `Working. ${SA.BLUETOOTH_MIC_NOTE}`)
    else setPreflightRow('mic', 'ok', 'Microphone', 'Ready — speak and watch the level move.')
  } catch (e) {
    setPreflightRow('mic', 'fail', 'Microphone', `Not available (${e.name || e.message}). Allow microphone access in System Settings → Privacy & Security → Microphone, then re-check.`)
  }

  if (captureProfile() === 'room_single_mic') {
    setPreflightRow('system', 'ok', 'Recording setup', 'Room microphone only. Call audio is not recorded in this mode.')
  } else if (systemAudioChoice().path === 'native') {
    // macOS records the call audio itself. Never raises the macOS window from here.
    await checkNativeAudio({ interactive: false })
  } else {
    // Call-audio source: the BlackHole (or chosen) input that carries the meeting audio.
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
      const hasBlackhole = inputs.some((d) => /blackhole/i.test(d.label || ''))
      const sysSel = $('system-source')
      const selected = sysSel && sysSel.value
      const selectedLabel = selected ? (inputs.find((d) => d.deviceId === selected)?.label || 'selected input') : ''
      if (selected && FnInputDevices.sameInput($('mic').value, selected, inputs)) {
        setPreflightRow('system', 'fail', 'Call audio source',
          `The microphone is “${FnInputDevices.inputName(selected, inputs)}” too: the call would be recorded twice and your own voice not at all. Pick the microphone you speak into above.`)
      } else if (selected) setPreflightRow('system', 'ok', 'Call audio source', `Capturing “${selectedLabel}” — route the meeting into it via a Multi-Output Device.`)
      else if (hasBlackhole) setPreflightRow('system', 'warn', 'Call audio source', 'BlackHole is available but not selected — pick it above to capture call audio.')
      else if (systemAudioChoice().nativeSupported) setPreflightRow('system', 'warn', 'Call audio source', 'BlackHole 2ch is not installed. Set “Call audio capture” to “Built into macOS” to record calls without it.')
      else setPreflightRow('system', 'warn', 'Call audio source', `No system-audio source. On this version of macOS, call audio needs BlackHole 2ch (the README has the steps); macOS ${systemAudioInfo.nativeMinVersion} and later do not need it.`)
    } catch {
      setPreflightRow('system', 'warn', 'Call audio source', 'Could not check the system-audio source.')
    }
  }

  // Disk space on the recordings volume (long meetings write a lot before upload).
  try {
    const info = await window.desktop.diskFree()
    if (info && typeof info.freeBytes === 'number') {
      const gb = info.freeBytes / (1024 ** 3)
      const label = `${gb.toFixed(1)} GB free`
      if (gb >= 2) setPreflightRow('disk', 'ok', 'Disk space', `${label} — plenty for a long meeting.`)
      else if (gb >= 0.5) setPreflightRow('disk', 'warn', 'Disk space', `${label} — OK for a short meeting; free up space for long calls.`)
      else setPreflightRow('disk', 'fail', 'Disk space', `${label} — too low; free up space before recording.`)
    } else {
      setPreflightRow('disk', 'skip', 'Disk space', 'Could not read free space (recording still works).')
    }
  } catch {
    setPreflightRow('disk', 'skip', 'Disk space', 'Could not read free space (recording still works).')
  }
}

async function populateMics() {
  try {
    // One permission grant so enumerateDevices returns labels.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    probe.getTracks().forEach((t) => t.stop())
  } catch {
    // continue; the device may still be selectable by default
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices.filter((d) => d.kind === 'audioinput')

  // Microphone dropdown.
  const micSel = $('mic')
  micSel.innerHTML = ''
  if (!inputs.length) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = 'Default microphone'
    micSel.appendChild(opt)
  } else {
    inputs.forEach((d, i) => {
      const opt = document.createElement('option')
      opt.value = d.deviceId
      opt.textContent = d.label || `Microphone ${i + 1}`
      micSel.appendChild(opt)
    })
  }

  // System-audio source dropdown — capture the BlackHole input (auto-selected if present).
  const sysSel = $('system-source')
  if (sysSel) {
    sysSel.innerHTML = ''
    const none = document.createElement('option')
    none.value = ''
    none.textContent = 'None (microphone only)'
    sysSel.appendChild(none)
    let blackholeId = ''
    inputs.forEach((d, i) => {
      const opt = document.createElement('option')
      opt.value = d.deviceId
      opt.textContent = d.label || `Input ${i + 1}`
      sysSel.appendChild(opt)
      // The device itself, never the "Default - BlackHole 2ch" entry that follows macOS.
      if (/blackhole/i.test(d.label || '') && !FnInputDevices.isPseudo(d.deviceId)) blackholeId = d.deviceId
    })
    if (blackholeId) sysSel.value = blackholeId
    // When macOS's input is BlackHole, the Microphone list starts on "Default - BlackHole
    // 2ch": the call would be recorded twice and the user's voice not at all. Start on a
    // real microphone instead.
    if (sysSel.value && inputs.length) micSel.value = FnInputDevices.distinctMicId(inputs, sysSel.value, micSel.value)
  }
}

// The microphone and the call-audio source must be different inputs. The same input on
// both tracks records the same samples twice (a byte-identical "call" track), so the
// meeting is transcribed twice and the user's own voice is missing.
function sameInputMessage(name) {
  return `The microphone and the call-audio source are both “${name}”, so it is recorded once, as your microphone. ` +
    'Pick the microphone you speak into above and BlackHole 2ch for call audio.'
}

// ---------------------------------------------------------------- capture
function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

// The longest stretch one stop-on-silence reading can cover (0.68 s at 48 kHz).
const ROOM_SAMPLES = 32768

// Live RMS meters so you can SEE whether each track is actually receiving audio. Also the
// room's level for stop on silence (read: every captured track, from the audio that arrived
// since the previous reading) and the chime that goes with the "Still there?" question.
function setupMeters(micStream, systemStream) {
  let ctx
  try {
    ctx = new AudioContext()
  } catch {
    return { stop() {}, read() { return null }, chime() {}, audioMs() { return undefined }, replace() {} }
  }
  const make = (stream, fillId, track) => {
    if (!stream) return null
    const src = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    src.connect(analyser)
    const room = ctx.createAnalyser()
    room.fftSize = ROOM_SAMPLES
    src.connect(room)
    return { src, analyser, data: new Uint8Array(analyser.fftSize), fillId, track, room, samples: new Float32Array(room.fftSize) }
  }
  const meters = [make(micStream, 'meter-mic', 'mic'), make(systemStream, 'meter-system', 'system')].filter(Boolean)
  let readAt = ctx.currentTime
  let raf = 0
  const tick = () => {
    for (const m of meters) {
      m.analyser.getByteTimeDomainData(m.data)
      let sum = 0
      for (const v of m.data) {
        const x = (v - 128) / 128
        sum += x * x
      }
      const level = Math.min(100, Math.round(Math.sqrt(sum / m.data.length) * 280))
      const el = document.getElementById(m.fillId)
      if (el) el.style.width = `${level}%`
    }
    raf = requestAnimationFrame(tick)
  }
  tick()
  return {
    stop() {
      if (raf) cancelAnimationFrame(raf)
      ctx.close().catch(() => {})
      for (const id of ['meter-mic', 'meter-system']) {
        const el = document.getElementById(id)
        if (el) el.style.width = '0%'
      }
    },
    // The audio clock in ms: it advances only while audio flows (not while the computer
    // sleeps), which tells a sleep from timers that were only late.
    audioMs() {
      return ctx.state === 'running' ? ctx.currentTime * 1000 : undefined
    },
    // Levels per track ({ mic, system }) of the audio that arrived since the last call, or
    // null. If the audio clock is not moving there is no reading, and so no silence either.
    read() {
      if (ctx.state !== 'running' || !meters.length) return null
      const fresh = Math.min(ROOM_SAMPLES, Math.round((ctx.currentTime - readAt) * ctx.sampleRate))
      if (fresh < ctx.sampleRate * 0.05) return null
      readAt = ctx.currentTime
      const levels = {}
      for (const m of meters) {
        m.room.getFloatTimeDomainData(m.samples)
        levels[m.track] = FnSilence.measureLevels(m.samples.subarray(m.samples.length - fresh), ctx.sampleRate)
      }
      return levels
    },
    // A track's stream was reopened, or call audio arrived after Start (adoptStream):
    // measure the new stream in the old one's place. The context, and with it the audio
    // clock the sleep check reads, stays the same.
    replace(track, stream) {
      const at = meters.findIndex((m) => m.track === track)
      if (at >= 0) {
        try { meters[at].src.disconnect() } catch { /* already torn down */ }
        meters.splice(at, 1)
      }
      try {
        const fresh = make(stream, track === 'mic' ? 'meter-mic' : 'meter-system', track)
        if (fresh) meters.push(fresh)
      } catch { /* a stream with no audio left: that bar stays flat */ }
    },
    // Two short tones through the default output (the web recorder's chime).
    chime() {
      try {
        const at = ctx.currentTime
        for (const [i, frequency] of [[0, 660], [1, 880]]) {
          const oscillator = ctx.createOscillator()
          const gain = ctx.createGain()
          const from = at + i * 0.22
          oscillator.frequency.value = frequency
          gain.gain.setValueAtTime(0.0001, from)
          gain.gain.exponentialRampToValueAtTime(0.25, from + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, from + 0.2)
          oscillator.connect(gain)
          gain.connect(ctx.destination)
          oscillator.start(from)
          oscillator.stop(from + 0.22)
        }
      } catch { /* no sound is not a reason to do anything else */ }
    },
  }
}

// ---------------------------------------------------------------- recording announcement
// Plays a pre-rendered voice clip of "This meeting is being recorded." once, through the
// computer's default audio output, right after capture has started — so the notice itself
// lands in the recording. The clips ship with the app in renderer/announce/ and are listed
// in voices.json there (ids, labels and the default voice): changing the set of voices is
// an edit to that file plus the matching .mp3, with no code change. Nothing to install: no
// audio driver, no virtual microphone. People on a call only hear it when the speakers
// (not headphones) are on. It is never awaited and every failure is swallowed — the
// announcement must never delay or break a recording.
function announceEnabled() {
  const box = $('announce-recording')
  return box ? box.checked : true
}

function showAnnounceNote(visible) {
  const el = $('announce-note')
  if (el) el.classList.toggle('hidden', !visible)
}

// voices.json → { voices: [{ id, label }], defaultId }. An id is also the clip's file
// name, so anything that is not a plain token is dropped. A missing or unlisted default
// falls back to the first voice.
function normalizeAnnounceVoices(raw) {
  const seen = new Set()
  const voices = []
  for (const v of raw && Array.isArray(raw.voices) ? raw.voices : []) {
    const id = v && typeof v.id === 'string' ? v.id : ''
    if (!/^[A-Za-z0-9_-]+$/.test(id) || seen.has(id)) continue
    seen.add(id)
    voices.push({ id, label: typeof v.label === 'string' && v.label.trim() ? v.label.trim() : id })
  }
  const defaultId = raw && seen.has(raw.default) ? raw.default : voices[0] ? voices[0].id : ''
  return { voices, defaultId }
}

// A stored or selected id that is unknown, or no longer shipped, falls back to the default.
function resolveAnnounceVoice(id) {
  return announceVoices.voices.some((v) => v.id === id) ? id : announceVoices.defaultId
}

function selectedAnnounceVoice() {
  const sel = $('announce-voice')
  return resolveAnnounceVoice(sel ? sel.value : '')
}

// The voice picker only shows while the announcement is switched on.
function renderAnnounceVoiceRow() {
  const row = $('announce-voice-row')
  if (row) row.classList.toggle('hidden', !announceEnabled() || !announceVoices.voices.length)
}

function setAnnouncePreviewDisabled(disabled) {
  const btn = $('announce-preview')
  if (btn) btn.disabled = disabled
}

// The voice list is read by the main process (the page's CSP only lets the renderer
// connect to https:, so it cannot fetch a local file itself). Never rejects.
async function loadAnnounceVoices() {
  try {
    announceVoices = normalizeAnnounceVoices(await window.desktop.announceVoices())
    const sel = $('announce-voice')
    sel.replaceChildren()
    for (const v of announceVoices.voices) {
      const opt = document.createElement('option')
      opt.value = v.id
      opt.textContent = v.label
      sel.appendChild(opt)
    }
    let stored = ''
    try { stored = localStorage.getItem(ANNOUNCE_VOICE_KEY) || '' } catch { /* storage unavailable: use the default */ }
    sel.value = resolveAnnounceVoice(stored)
  } catch (e) {
    console.warn('[forgenotes] could not load the announcement voices:', (e && e.message) || e)
  }
  renderAnnounceVoiceRow()
}

function stopAnnounceClip() {
  if (!announceClip) return
  const clip = announceClip
  announceClip = null
  clip.cancel()
}

// Plays one clip at full volume, replacing any clip already playing. onFail(why) is called
// at most once: the file fails to load or decode, play() is refused, or playback has not
// begun within ANNOUNCE_START_TIMEOUT_MS. A clip that is stopped on purpose is not a failure.
function playAnnounceClip(id, onFail) {
  stopAnnounceClip()
  let watchdog = 0
  let reported = false
  const fail = (why) => {
    clearTimeout(watchdog)
    if (reported) return
    reported = true
    onFail(why)
  }
  try {
    const audio = new Audio(`announce/${id}.mp3`)
    const clip = {
      cancel() {
        reported = true
        clearTimeout(watchdog)
        try { audio.pause() } catch { /* already stopped */ }
      },
    }
    audio.volume = 1
    audio.onplaying = () => clearTimeout(watchdog)
    audio.onended = () => {
      clearTimeout(watchdog)
      if (announceClip === clip) announceClip = null
    }
    audio.onerror = () => fail((audio.error && audio.error.message) || 'the clip could not be loaded')
    announceClip = clip // also keeps the element alive until it has finished
    watchdog = setTimeout(() => fail('playback did not start'), ANNOUNCE_START_TIMEOUT_MS)
    const started = audio.play()
    if (started && typeof started.catch === 'function') {
      started.catch((e) => fail((e && e.message) || 'playback was refused'))
    }
  } catch (e) {
    fail((e && e.message) || e)
  }
}

async function announceRecording(current) {
  const failed = (why) => {
    console.warn('[forgenotes] recording announcement did not play:', why)
    if (rec === current) showAnnounceNote(true)
  }
  try {
    // The voice list loads at boot, long before anyone can press Start; the short race
    // only covers a list that never arrives, so that case still ends in the note.
    await Promise.race([announceVoicesLoaded, new Promise((resolve) => setTimeout(resolve, ANNOUNCE_VOICES_WAIT_MS))])
    if (rec !== current || current.stopping) return // stopped before it could be played
    const id = selectedAnnounceVoice()
    if (!id) {
      failed('no announcement voice is available')
      return
    }
    playAnnounceClip(id, failed)
  } catch (e) {
    failed((e && e.message) || e)
  }
}

// The "Preview" button next to the voice picker. Not available while recording, so a
// preview can never be mistaken for (or captured as) the real announcement.
function previewAnnounceVoice() {
  if (rec) return
  const failed = (why) => {
    console.warn('[forgenotes] voice preview did not play:', why)
    setStatus("Couldn't play the voice preview.", 'warn')
  }
  try {
    const id = selectedAnnounceVoice()
    if (id) playAnnounceClip(id, failed)
    else failed('no announcement voice is available')
  } catch (e) {
    failed((e && e.message) || e)
  }
}

// ---------------------------------------------------------------- segmented recording
// One MediaRecorder per track per segment. On stop (rotation, sleep or final), its onstop
// pushes the completed, independently-decodable webm blob to the recording's segments.
// Offsets and durations are on the recording's clock: paused and asleep time is not audio.
function bankSegment(current, track, blob, startOffsetMs, durationMs) {
  if (!blob.size || !current) return Promise.resolve()
  const seq = current.nextSeq[track] || 0
  current.nextSeq[track] = seq + 1
  const entry = { track, seq, startOffsetMs, durationMs }
  current.segments.push(entry)
  const writing = current.writes.then(async () => {
    await window.desktop.checkpoint(current.localId, { ...current.meta, createdAt: new Date(current.startedAt).toISOString() }, { ...entry, data: await blob.arrayBuffer() })
  })
  current.writes = writing
  writing.catch((e) => {
    if (current.saveError) return
    current.saveError = e
    setStatus('Local saving failed. Capture is stopping; completed checkpoints remain on disk. ' + e.message, 'error')
    if (rec === current && !current.stopping) void stopRecording('save_failed').catch(() => {})
  })
  return writing
}

// Where the recording is now, on its own clock.
function offsetNow(current) {
  return current.clock.elapsed(Date.now())
}

// A stream whose track has ended (device unplugged, capture refused) cannot be recorded:
// that track simply has no segment until the stream is reopened (see reacquireTrack).
function startTrackSegment(current, track, stream) {
  if (!streamLive(stream)) return null
  const chunks = []
  const startOffsetMs = offsetNow(current)
  let recorder
  try {
    recorder = new MediaRecorder(stream, current.mime ? { mimeType: current.mime } : undefined)
  } catch (e) {
    void diag(`capture: could not start a ${track} segment (${(e && e.message) || e})`)
    return null
  }
  const seg = { recorder, chunks, startOffsetMs, endOffsetMs: null, done: null }
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  seg.done = new Promise((resolve) => {
    // Also runs when the track ends by itself: what was captured up to then is kept.
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: current.mime || 'audio/webm' })
      // The end is fixed when the segment is ended (endTrackSegment), not when the encoder
      // gets round to stopping: after a suspend that can be after the Mac woke up.
      const end = seg.endOffsetMs ?? offsetNow(current)
      if (blob.size) bankSegment(current, track, blob, startOffsetMs, Math.max(0, end - startOffsetMs))
      resolve()
    }
  })
  try {
    recorder.start(1000)
  } catch (e) {
    void diag(`capture: could not start a ${track} segment (${(e && e.message) || e})`)
    return null
  }
  // Stop waits for every segment still being closed (one ended at a suspend may only
  // finish after the Mac wakes), so nothing is banked after the recording is finished.
  current.closing.add(seg.done)
  seg.done.then(() => current.closing.delete(seg.done))
  return seg
}

// Stop one track's segment at `endOffsetMs` and resolve once its blob is banked.
function endTrackSegment(seg, endOffsetMs) {
  if (!seg || !seg.recorder) return Promise.resolve()
  if (seg.endOffsetMs === null) seg.endOffsetMs = endOffsetMs
  if (seg.recorder.state === 'inactive') return seg.done
  seg.recorder.stop()
  return seg.done
}

function startSegments(current) {
  current.mic = startTrackSegment(current, 'mic', current.micStream)
  current.system = startTrackSegment(current, 'system', current.systemStream)
  current.live = true
  current.segmentStartedAt = Date.now()
}

// End the current segment on every track, all at the same point of the recording.
function endSegments(current) {
  const ending = [current.mic, current.system].filter(Boolean)
  current.mic = null
  current.system = null
  current.live = false
  const at = offsetNow(current)
  return Promise.all(ending.map((seg) => endTrackSegment(seg, at)))
}

// Rotate every ROTATE_MS: stop the current segment recorders (their onstop banks the
// segment) and immediately start fresh ones. The ~ms gap is negligible for transcription.
function rotate() {
  const current = rec
  if (!current || current.paused || current.stopping || !current.live) return
  void endSegments(current)
  startSegments(current)
}

// ---------------------------------------------------------------- sleep and wake
// Nothing is captured while the Mac sleeps. At suspend the segment ends (its length is what
// was captured up to then) and the clock stops; at resume a new segment starts. main.js
// forwards powerMonitor's suspend and resume with the times they fired; the heartbeat below
// catches a sleep whose events were missed.
function streamLive(stream) {
  return Boolean(stream) && stream.getAudioTracks().some((t) => t.readyState === 'live')
}

function onPower(event) {
  const current = rec
  if (!current || current.stopping || !event) return
  const at = Number.isFinite(event.at) ? event.at : Date.now()
  if (event.state === 'suspend') {
    // False for news of a sleep the heartbeat already found (delivered after waking).
    if (!current.clock.suspend(at)) return
    void diag(`${current.localId}: Mac going to sleep at ${Math.round(offsetNow(current) / 1000)} s of audio; segment ended`)
    if (current.live) void endSegments(current)
  } else if (event.state === 'resume') {
    current.clock.wake(at)
    void diag(`${current.localId}: Mac woke up; recording continues`)
    resumeAfterSleep(current)
  }
}

// After a sleep (or a gap): start new segments, if the inputs survived it.
function resumeAfterSleep(current) {
  if (rec !== current || current.stopping || current.clock.asleep() || current.paused) return
  if (current.silence) current.silence.resume()
  if (current.live) return
  if (!streamLive(current.micStream)) {
    void diag(`${current.localId}: microphone not available after waking; stopping`)
    void stopRecording('device_lost')
    return
  }
  // Call audio that did not survive the sleep has no segment now (startTrackSegment skips
  // an ended stream). The capture watch reopens it and continues it in a new segment, and
  // says so on screen if it cannot; waking up is worth fresh attempts.
  current.gaveUp = {}
  try {
    startSegments(current)
  } catch (e) {
    void diag(`${current.localId}: could not restart capture after waking: ${e.message}`)
    void endSegments(current)
    void stopRecording('device_lost')
    return
  }
  checkCaptureHealth()
}

// Runs every HEARTBEAT_MS while recording: the timer display, and the clock's check for
// time in which this process was frozen (a sleep whose suspend was not seen).
function heartbeat() {
  const current = rec
  if (!current || current.stopping) return
  const found = current.clock.beat(Date.now(), current.meters ? current.meters.audioMs() : undefined)
  if (found.gapMs) {
    void diag(`${current.localId}: ${Math.round(found.gapMs / 1000)} s with no timers (Mac asleep?) left out of the recording's length`)
    if (current.silence && !current.paused) current.silence.resume()
    // The segment that spans the gap ends here and a new one starts (not one that a resume
    // already started after the gap).
    if (current.segmentStartedAt < Date.now() - found.gapMs) rotate()
  }
  if (found.woke) resumeAfterSleep(current)
  updateTimer()
}

// ---------------------------------------------------------------- opening the streams
function openMicStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, ...RAW_AUDIO },
  })
}

// One of the two paths, never both: a native capture is a display-media stream, a BlackHole
// capture is an ordinary audio input.
// Resolves to null when macOS has not handed native call audio over within
// NATIVE_WAIT.startMs; onLate then receives the stream if it arrives later.
function openSystemStream(path, deviceId, onLate) {
  if (path === 'native') return openNativeWithin(NATIVE_WAIT.startMs, onLate)
  return navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId }, ...RAW_AUDIO } })
}

async function startRecording() {
  if (rec || starting) return
  starting = true
  try {
    await beginRecording()
  } finally {
    starting = false
  }
}

async function beginRecording() {
  setStatus('', null)
  showAnnounceNote(false)
  showStopNote('')
  setCaptureNote(null)
  stopAnnounceClip() // a voice preview must not run into the recording
  hide('open-link')
  stopLocalPlayback()
  stopPreflightMeter() // release the preflight mic before opening the recording streams
  const micId = $('mic').value
  const profile = captureProfile()
  const systemPath = profile === 'remote_dual_track' ? systemAudioChoice().path : 'none'
  const systemId = systemPath === 'blackhole' && $('system-source') ? $('system-source').value : ''

  // Native call audio that macOS has not been asked about yet: ask now, while no stream is
  // open. The macOS window blocks Chromium's audio service until it is answered, so it must
  // never be raised underneath a running microphone capture.
  let nativeState = null
  if (systemPath === 'native') {
    const waiting = 'macOS is asking for permission to record call audio. Choose Allow in the macOS window: recording starts as soon as you answer.'
    if (nativeCheck) {
      if (!nativeAsked()) setStatus(waiting, 'busy')
      nativeState = await nativeCheck
    }
    if (!nativeAsked() && !nativeOpening) {
      setStatus(waiting, 'busy')
      nativeState = await checkNativeAudio({ interactive: true })
    }
    setStatus('', null)
  }

  let micStream
  try {
    micStream = await openMicStream(micId)
  } catch (e) {
    setStatus(`Could not open the microphone: ${e.message}`, 'error')
    return
  }

  // BlackHole is an ordinary input and opens at once, so it is opened here. Native call
  // audio is attached after the microphone is already being recorded (attachNativeSystemAudio):
  // macOS may hold that request behind its permission window, and the microphone must never
  // wait for it.
  let systemStream = null
  let warning = null
  // The inputs as they are now, to tell whether two ids open the same device. Without the
  // list, only equal ids count as the same input.
  let inputs = []
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  } catch {
    inputs = []
  }
  if (systemId && FnInputDevices.sameInput(micId, systemId, inputs)) {
    warning = sameInputMessage(FnInputDevices.inputName(systemId, inputs))
    console.warn('[forgenotes] the call-audio source is the microphone input; recording it once')
  } else if (systemId) {
    try {
      systemStream = await openSystemStream('blackhole', systemId)
      const track = systemStream.getAudioTracks()[0]
      console.log('[forgenotes] system-audio (BlackHole) track:', track && track.label, track && track.getSettings())
      // Different ids can still open one device (an input that changed in between).
      if (FnInputDevices.sameOpenedInput(micStream.getAudioTracks()[0], track, inputs)) {
        systemStream.getTracks().forEach((t) => t.stop())
        systemStream = null
        warning = sameInputMessage(FnInputDevices.baseLabel(track && track.label) || FnInputDevices.inputName(systemId, inputs))
        console.warn('[forgenotes] the opened call-audio track is the microphone input; recording it once')
      }
    } catch (e) {
      systemStream = null
      warning = `Could not open the system-audio device (${e.name}: ${e.message}) — recording mic only. Is BlackHole installed and selected?`
      console.error('[forgenotes] system getUserMedia failed:', e)
    }
  } else if (systemPath === 'blackhole') {
    warning = 'No system-audio source selected — recording mic only. Pick BlackHole 2ch to capture the meeting.'
  }

  const mime = pickMime()
  const startedAt = Date.now()
  rec = {
    localId: `rec_${startedAt}`,
    micStream,
    systemStream,
    micId,
    systemPath, // 'native' | 'blackhole' | 'none' (room microphone)
    systemId,
    streams: [micStream, systemStream].filter(Boolean),
    mime: mime || 'audio/webm',
    startedAt,
    // Counts captured time only: stops while paused and while the Mac is asleep.
    clock: FnCaptureClock.createCaptureClock(startedAt),
    paused: false,
    meta: {
      title: $('title').value.trim(),
      source_type: $('source').value,
      capture_profile: profile,
      visibility: $('visibility').value,
      template_key: $('template').value,
      tags: $('tags').value,
      system_audio_path: systemPath, // kept in the local meta.json for support; not uploaded
      // When recording began, kept with the local copy and sent as started_at, however
      // late (or after however many restarts) the upload happens.
      startedAt: new Date(startedAt).toISOString(),
    },
    mic: null,
    system: null,
    live: false,
    segmentStartedAt: 0,
    closing: new Set(),
    segments: [],
    nextSeq: {},
    writes: Promise.resolve(),
    saveError: null,
    rotateTimer: null,
    timer: null,
    meters: null,
    plan: FnSilence.silencePlan(0),
    silence: null,
    previousTitle: null,
    stopping: false,
    // capture watch (see startCaptureWatch)
    watchTimer: null,
    levelCtx: null,
    levelNodes: {},
    levels: {},
    heard: { mic: false, system: false },
    openedAt: { mic: Date.now(), system: Date.now() },
    health: { mic: 'starting', system: systemStream ? 'starting' : 'absent' },
    hadSystemStream: Boolean(systemStream),
    levelWatched: false,
    startWarning: warning, // why call audio was missing from the first second, if it was
    systemOpening: systemPath === 'native', // native call audio has been asked for, not yet judged
    reacquiring: {},
    gaveUp: {},
    outputLabel: null,
    outputNote: null,
  }
  startSegments(rec)
  void analytics?.capture('recording_started')
  rec.rotateTimer = setInterval(rotate, ROTATE_MS)

  // Capture is live — say the notice now so it is part of the recording. Only here, on a
  // fresh start: resuming from pause and segment rotation never repeat it. This runs well
  // after stopLocalPlayback() above, which only touches the saved-recording player.
  // Fire-and-forget: it must never delay or endanger the recording.
  if (announceEnabled()) void announceRecording(rec)

  // Persistent capture status + live meters — the "Call audio" bar moving means the
  // meeting is actually being captured; flat means mic-only.
  rec.meters = setupMeters(micStream, systemStream)
  show('meters')
  renderCaptureHealth(rec)
  startCaptureWatch(rec)
  startSilenceWatch(rec)
  // Fire-and-forget: captions must never delay or endanger the recording. On the native
  // path they start once call audio has been attached, so that they hear both sides.
  if (systemPath === 'native') void attachNativeSystemAudio(rec, nativeState)
  else if (window.fnLive) window.fnLive.start({ micStream, systemStream })

  $('start-btn').classList.add('hidden')
  $('pause-btn').classList.remove('hidden')
  $('stop-btn').classList.remove('hidden')
  $('signout-btn').disabled = true
  $('system-audio-pref').disabled = true // the path of a running recording cannot change
  setAnnouncePreviewDisabled(true)
  show('rec-indicator')
  rec.timer = setInterval(heartbeat, HEARTBEAT_MS)
  updateTimer()
}

// Native call audio for a recording that is already running on the microphone. Whatever
// macOS does (hands the audio over, refuses, or leaves its window open), the recording goes
// on, and the reason for missing call audio is shown.
async function attachNativeSystemAudio(current, nativeState) {
  const micOnly = 'Only your microphone is being recorded so far.'
  let warning = null
  try {
    if (!nativeAsked() && !nativeOpening) {
      // macOS has not said yes, and no request is waiting on it (it was refused before
      // reaching macOS, or abandoned). Asking again now would raise the macOS window under
      // the running microphone, so this recording stays microphone only.
      warning = `${micOnly} ${SA.nativePermissionCopy(nativeState === 'denied' ? 'denied' : 'unanswered').text}`
    } else {
      const stream = await openSystemStream('native', '', (lateStream) => adoptLateSystemStream(current, lateStream))
      const live = rec === current && !current.stopping
      if (!stream) {
        // macOS is showing its window (permission was reset, or never answered).
        warning = `${micOnly} ${SA.nativePermissionCopy('unanswered').text} Call audio joins this recording as soon as macOS allows it.`
      } else if (!live) {
        stream.getTracks().forEach((t) => t.stop())
      } else {
        const track = stream.getAudioTracks()[0]
        const settled = await settleNativeTrack(track, 1500)
        console.log('[forgenotes] system-audio (native) track:', track && track.label, settled, track && track.getSettings())
        if (settled === 'ended' || rec !== current || current.stopping) {
          stream.getTracks().forEach((t) => t.stop())
          if (settled === 'ended') {
            setNativeAsked(true)
            warning = SA.healthMessage({ kind: 'system', health: 'ended', path: 'native' }).text
          }
        } else {
          adoptStream(current, 'system', stream)
        }
      }
    }
  } catch (e) {
    warning = SA.healthMessage({ kind: 'system', health: 'absent', path: 'native' }).text
    console.error('[forgenotes] native system audio failed:', e)
  } finally {
    current.systemOpening = false
    current.startWarning = warning
    if (rec === current && !current.stopping) {
      checkCaptureHealth()
      if (window.fnLive) window.fnLive.start({ micStream: current.micStream, systemStream: current.systemStream })
    }
  }
}

// ---------------------------------------------------------------- capture watch
// While a recording runs, both tracks are watched so that a dead or silent one is reported
// during the meeting, when it can still be fixed, and a track that ends (output device
// changed, headset disconnected, audio service restarted) is reopened and recording goes on
// in a new segment. Levels come from level-worklet.js on the audio thread, so this keeps
// working while the window is in the background.
function setCaptureNote(message) {
  const el = $('capture-note')
  if (!message) {
    el.classList.add('hidden')
    el.textContent = ''
    return
  }
  el.textContent = message.text
  el.className = `msg ${message.level === 'error' ? 'error' : 'warn'}`
}

function watchedKinds(current) {
  return current.systemPath === 'none' ? ['mic'] : ['mic', 'system']
}

function attachLevelTap(current, kind) {
  for (const node of current.levelNodes[kind] || []) { try { node.disconnect() } catch { /* torn down */ } }
  current.levelNodes[kind] = []
  current.levels[kind] = null
  const stream = current[`${kind}Stream`]
  if (!current.levelCtx || !streamLive(stream)) return
  const monitor = SA.createLevelMonitor()
  const source = current.levelCtx.createMediaStreamSource(stream)
  const tap = new AudioWorkletNode(current.levelCtx, 'fn-level-tap', { numberOfOutputs: 0 })
  tap.port.onmessage = (event) => {
    monitor.push(event.data)
    if (event.data.peak >= SA.SILENCE_PEAK) current.heard[kind] = true
  }
  source.connect(tap)
  current.levelNodes[kind] = [source, tap]
  current.levels[kind] = monitor
}

function watchTrackEnd(current, kind) {
  const stream = current[`${kind}Stream`]
  const track = stream && stream.getAudioTracks()[0]
  if (!track) return
  track.addEventListener('ended', () => {
    if (rec === current && !current.stopping) checkCaptureHealth()
  })
}

async function defaultOutputLabel() {
  try {
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput')
    const chosen = outputs.find((d) => d.deviceId === 'default') || outputs[0]
    return chosen ? String(chosen.label || '').replace(/^Default\s*-\s*/i, '') : ''
  } catch {
    return ''
  }
}

function startCaptureWatch(current) {
  for (const kind of watchedKinds(current)) watchTrackEnd(current, kind)
  current.watchTimer = setInterval(checkCaptureHealth, 1000)
  void defaultOutputLabel().then((label) => { current.outputLabel = label })
  void (async () => {
    try {
      const ctx = new AudioContext()
      await ctx.audioWorklet.addModule('level-worklet.js')
      if (rec !== current || current.stopping) {
        ctx.close().catch(() => {})
        return
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      current.levelCtx = ctx
      current.levelWatched = true
      for (const kind of watchedKinds(current)) attachLevelTap(current, kind)
    } catch (e) {
      // Without levels the recording still runs and ended tracks are still noticed; only
      // the "silent" warnings are lost.
      await diag(`capture: level watch unavailable (${(e && e.message) || e})`)
    }
  })()
}

function stopCaptureWatch(current) {
  clearInterval(current.watchTimer)
  current.watchTimer = null
  if (current.levelCtx) current.levelCtx.close().catch(() => {})
  current.levelCtx = null
  current.levelNodes = {}
}

function checkCaptureHealth() {
  const current = rec
  if (!current || current.stopping) return
  for (const kind of watchedKinds(current)) {
    if (kind === 'system' && current.systemOpening) continue // not judged before it has been opened
    const stream = current[`${kind}Stream`]
    const track = stream ? stream.getAudioTracks()[0] : null
    const level = current.levels[kind] ? current.levels[kind].snapshot() : null
    const health = SA.trackHealth({
      kind,
      hasTrack: Boolean(track),
      readyState: track ? track.readyState : 'ended',
      deliveredFrames: track ? deliveredFrames(track) : null,
      level,
      elapsedMs: Date.now() - current.openedAt[kind],
    })
    if (health !== current.health[kind]) {
      current.health[kind] = health
      const peak = level && Number.isFinite(level.maxPeakDb) ? `, peak ${level.maxPeakDb.toFixed(1)} dBFS` : ''
      void diag(`capture: ${kind} track is ${health} (${kind === 'system' ? current.systemPath : 'microphone'}${peak})`)
    }
    if (health === 'ended' && !current.reacquiring[kind] && !current.gaveUp[kind]) void reacquireTrack(current, kind)
  }
  renderCaptureHealth(current)
}

function renderCaptureHealth(current) {
  const sysEl = $('cap-system')
  let systemMessage = null
  if (current.systemPath === 'none') {
    sysEl.textContent = 'Room microphone only'
    sysEl.className = 'cap ok'
  } else if (current.systemOpening) {
    sysEl.textContent = 'Call audio: starting…'
    sysEl.className = 'cap'
  } else {
    const health = current.health.system
    const lost = health === 'absent' || health === 'ended' || health === 'no_frames'
    sysEl.textContent = lost ? 'Call audio: NOT captured — mic only' : health === 'silent' ? 'Call audio: nothing heard yet' : 'Call audio: capturing'
    sysEl.className = lost || health === 'silent' ? 'cap bad' : 'cap ok'
    systemMessage = current.reacquiring.system
      ? { level: 'warn', text: 'Call audio stopped. ForgeNotes is reconnecting it; your microphone is still being recorded.' }
      : health === 'absent' && current.startWarning
        ? { level: 'error', text: current.startWarning }
        : SA.healthMessage({ kind: 'system', health, path: current.systemPath })
  }
  // One note at a time, the most serious first: a dead microphone, then lost call audio,
  // then a changed sound output.
  setCaptureNote(SA.healthMessage({ kind: 'mic', health: current.health.mic }) || systemMessage || current.outputNote)
}

// Puts a newly opened stream in the place of one that ended and continues recording that
// track in a new segment. The time between the two segments is kept as a gap (segments
// carry their own start offsets), never closed up.
function adoptStream(current, kind, stream) {
  const old = current[`${kind}Stream`]
  if (old) old.getTracks().forEach((t) => t.stop())
  current[`${kind}Stream`] = stream
  current.streams.push(stream) // closed with the others at Stop
  current.openedAt[kind] = Date.now()
  if (kind === 'system') current.hadSystemStream = true
  watchTrackEnd(current, kind)
  // While the Mac is asleep no segment is running: the next one starts from this stream
  // when it wakes (resumeAfterSleep).
  if (current.live) {
    void endTrackSegment(current[kind], offsetNow(current))
    current[kind] = startTrackSegment(current, kind, stream)
    if (current.paused && current[kind]) current[kind].recorder.pause()
  }
  attachLevelTap(current, kind)
  if (current.meters) current.meters.replace(kind, stream)
}

// Native call audio that arrives after macOS was slow to answer. During a recording that
// still has no call audio it becomes the call-audio track from here on; otherwise it only
// tells the app what macOS answered.
function adoptLateSystemStream(current, stream) {
  const track = stream.getAudioTracks()[0]
  const usable = Boolean(track) && track.readyState === 'live'
  if (usable && rec === current && !current.stopping && current.systemPath === 'native' && !streamLive(current.systemStream)) {
    setNativeAsked(true)
    current.startWarning = null
    adoptStream(current, 'system', stream)
    void diag('capture: macOS handed call audio over late; it is recorded from here on')
    checkCaptureHealth()
    return
  }
  void judgeNativeStream(stream, performance.now(), NATIVE_WAIT.settleMs).then(applyNativeOutcome)
}

async function reacquireTrack(current, kind) {
  if (current.reacquiring[kind]) return
  current.reacquiring[kind] = true
  let reopened = false
  try {
    for (let attempt = 0; attempt < REACQUIRE_DELAYS_MS.length; attempt++) {
      await sleep(REACQUIRE_DELAYS_MS[attempt])
      if (rec !== current || current.stopping) return
      let stream = null
      try {
        // The last microphone attempt lets macOS pick: the chosen device may be gone.
        if (kind === 'mic') stream = await openMicStream(attempt < REACQUIRE_DELAYS_MS.length - 1 ? current.micId : '')
        else if (current.systemPath === 'native' || current.systemId) stream = await openSystemStream(current.systemPath, current.systemId, (lateStream) => adoptLateSystemStream(current, lateStream))
        if (stream && kind === 'system' && current.systemPath === 'native') {
          if ((await settleNativeTrack(stream.getAudioTracks()[0], 1500)) === 'ended') {
            stream.getTracks().forEach((t) => t.stop())
            stream = null
          }
        }
      } catch (e) {
        await diag(`capture: reopening ${kind} failed on attempt ${attempt + 1} (${(e && e.name) || ''} ${(e && e.message) || e})`)
        stream = null
      }
      if (!stream) continue
      if (rec !== current || current.stopping) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      adoptStream(current, kind, stream)
      reopened = true
      await diag(`capture: ${kind} reopened on attempt ${attempt + 1}; recording continues in a new segment`)
      return
    }
  } finally {
    current.reacquiring[kind] = false
    if (!reopened && rec === current && !current.stopping) {
      current.gaveUp[kind] = true // a later device change tries again
      void diag(`capture: ${kind} could not be reopened`)
    }
    if (rec === current && !current.stopping) checkCaptureHealth()
  }
}

// Headset connected or removed, sound output switched. Native capture: Chromium moves its
// tap to the new output by itself, and the watch above reopens the track if that fails.
// BlackHole: the call only reaches BlackHole through the Multi-Output Device, so say so
// when the output moves away from it.
async function onAudioDevicesChanged() {
  const current = rec
  if (!current || current.stopping) return
  const label = await defaultOutputLabel()
  if (rec !== current || current.stopping) return
  if (label !== current.outputLabel) {
    await diag(`capture: sound output changed from "${current.outputLabel || ''}" to "${label}" (${current.systemPath})`)
    current.outputLabel = label
    current.outputNote = current.systemPath === 'blackhole' && label && !SA.outputFeedsBlackhole(label)
      ? { level: 'warn', text: `Your Mac’s sound output changed to “${label}”. Call audio is only recorded while the output is the Multi-Output Device that includes BlackHole 2ch. Watch the Call audio bar, and switch the output back if it stops moving.` }
      : null
  }
  current.gaveUp = {} // a device came or went: an ended track is worth another try
  setTimeout(checkCaptureHealth, 1500) // let macOS finish switching before judging
}

// ---------------------------------------------------------------- stop on silence: the question
// Uses the setting as last seen on this Mac (Start never waits for the network). Off means
// never ask, never stop. Every captured track is read: silence is all of them quiet.
function startSilenceWatch(current) {
  current.plan = FnSilence.silencePlan(FnSilence.readCachedSilenceMinutes(prefs()))
  if (!current.plan.enabled) return
  current.silence = FnSilence.createSilenceWatch({
    plan: current.plan,
    clock: () => offsetNow(current),
    wall: () => Date.now(),
    read: () => (current.meters ? current.meters.read() : null),
    chime: () => { if (current.meters) current.meters.chime() },
    ask: (s) => showSilenceQuestion(current, s),
    update: (s) => { if (rec === current) $('silence-question-text').textContent = FnSilence.questionSentence(s.silentMs, s.secondsLeft) },
    clear: () => hideSilenceQuestion(current),
    stop: () => {
      void diag(`${current.localId}: stopped by itself after ${FnSilence.describeDuration(current.plan.stopAfterMs)} of silence with no answer`)
      void stopRecording('silence')
    },
  })
  current.silence.start()
}

// Noticed by someone who is not looking at the app: the chime (silence.js), the window
// title, and a notification plus a bouncing Dock icon from main.
function showSilenceQuestion(current, s) {
  if (rec !== current) return
  $('silence-question-text').textContent = FnSilence.questionSentence(s.silentMs, s.secondsLeft)
  show('silence-question')
  if (document.title !== FnSilence.WARNING_TITLE) current.previousTitle = document.title
  document.title = FnSilence.WARNING_TITLE
  window.desktop.silenceAsk(FnSilence.notificationBody(current.plan)).catch(() => {})
}

function hideSilenceQuestion(current) {
  hide('silence-question')
  if (document.title === FnSilence.WARNING_TITLE) document.title = (current && current.previousTitle) || 'ForgeNotes Recorder'
  window.desktop.silenceClear().catch(() => {})
}

// "Keep recording", from the button or the notification. It counts as sound.
function keepRecording() {
  if (rec && rec.silence && !rec.stopping) rec.silence.keep()
}

// Why a recording stopped by itself, left on screen until the next Start.
function showStopNote(text) {
  const el = $('stop-note')
  el.textContent = text || ''
  el.classList.toggle('hidden', !text)
}

function togglePause() {
  const current = rec
  if (!current || current.stopping) return
  const segments = [current.mic, current.system].filter(Boolean)
  const now = Date.now()
  if (!current.paused) {
    segments.forEach((s) => { if (s.recorder.state === 'recording') s.recorder.pause() })
    current.paused = true
    current.clock.pause(now)
    if (current.silence) current.silence.pause()
    if (window.fnLive) window.fnLive.setPaused(true)
    $('pause-btn').textContent = 'Resume'
    $('rec-indicator').classList.add('hidden')
  } else {
    current.clock.resume(now)
    current.paused = false
    if (current.live) segments.forEach((s) => { if (s.recorder.state === 'paused') s.recorder.resume() })
    if (current.silence) current.silence.resume()
    if (window.fnLive) window.fnLive.setPaused(false)
    $('pause-btn').textContent = 'Pause'
    show('rec-indicator')
    // The Mac slept while paused, which ended the segment: start a new one.
    if (!current.live) resumeAfterSleep(current)
  }
}

function elapsedMs() {
  return rec ? offsetNow(rec) : 0
}

function elapsedSec() {
  return Math.round(elapsedMs() / 1000)
}

function updateTimer() {
  const s = elapsedSec()
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  $('rec-timer').textContent = `${mm}:${ss}`
}

// reason: 'manual' (Stop), 'silence' (nobody answered "Still there?"), 'save_failed'
// (the disk refused a segment) or 'device_lost' (the microphone did not survive a sleep).
async function stopRecording(reason = 'manual') {
  if (!rec || rec.stopping) return
  const current = rec
  current.stopping = true
  const endedAt = new Date().toISOString()
  if (current.silence) current.silence.dispose()
  hideSilenceQuestion(current)
  if (window.fnLive) window.fnLive.stop()
  clearInterval(current.rotateTimer)
  clearInterval(current.timer)
  // Read before the watch is torn down: did the call-audio track ever carry sound?
  // No call audio in the finished recording: there never was a track, the track was lost
  // or never fed, or it ran for a while and stayed silent.
  const systemLost = ['absent', 'ended', 'no_frames'].includes(current.health.system)
  const noCallAudio = current.systemPath !== 'none' && !current.heard.system &&
    (!current.hadSystemStream || systemLost || (current.levelWatched && offsetNow(current) >= SA.FINAL_SILENCE_MIN_MS))
  const systemPathUsed = current.systemPath
  stopCaptureWatch(current)
  if (current.meters) current.meters.stop()
  hide('meters')
  hide('rec-indicator')
  $('pause-btn').classList.add('hidden')
  $('stop-btn').classList.add('hidden')
  $('pause-btn').textContent = 'Pause'

  // End the in-progress segment on each track (if a sleep has not already), wait for every
  // segment still closing, then collect everything. A recorder that never reports back
  // cannot hold Stop forever.
  await endSegments(current)
  await Promise.race([Promise.all([...current.closing]), new Promise((resolve) => setTimeout(resolve, 15000))])

  current.streams.forEach((stream) => stream.getTracks().forEach((t) => t.stop()))

  const segments = current.segments
  const localId = current.localId
  rec = null
  resetControls()

  if (!segments.length) {
    setStatus('Nothing was recorded.', 'error')
    return
  }

  const uploading = $('auto-upload').checked && Boolean(auth)
  if (reason === 'silence') showStopNote(FnSilence.stoppedSentence(current.plan, { uploading, place: 'this Mac' }))
  else if (reason === 'device_lost') showStopNote('The recording stopped because the microphone was not available after the Mac woke up. Everything recorded before that is kept on this Mac.')

  try {
    await current.writes
    await window.desktop.finishRecording(localId, { endedAt, stopReason: reason })
    void analytics?.capture('recording_stopped')
    await refreshPending()
  } catch (e) {
    await refreshPending().catch(() => {})
    setStatus(`Could not finish saving. Completed checkpoints remain on disk: ${e.message}`, 'error')
    return
  }
  setStatus('Saved on this device. Play it below, open its folder, or choose Upload & transcribe.', 'ok')
  // Said once more at the end, where it stays on screen: a recording with no call audio.
  if (noCallAudio) {
    setCaptureNote({ level: 'warn', text: SA.noCallAudioSummary(systemPathUsed) })
    await diag(`capture: recording ${localId} ended with no call audio (${systemPathUsed})`)
  } else {
    setCaptureNote(null)
  }
  void loadSilenceSetting() // the next Start uses the account's current choice
  if (uploading) await retryPending(localId, $('stop-btn'))

}

function resetControls() {
  $('start-btn').classList.remove('hidden')
  $('signout-btn').disabled = false
  $('system-audio-pref').disabled = false
  setAnnouncePreviewDisabled(false)
}

// ---------------------------------------------------------------- upload
// Recordings whose upload run is currently in flight. Guards the pending list's Retry
// button from starting a second parallel run of the same recording — the source of
// duplicate double-uploaded (and double-transcribed) meetings.
const activeUploads = new Set()

const CHUNK_ATTEMPTS = 3
const CHUNK_RETRY_DELAYS_MS = [1000, 4000, 10000]

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Local diagnostics trail (userData/upload-log.txt) so a failed upload leaves the REAL
// error on disk, not just a transient status line. Must never break the upload itself.
async function diag(line) {
  try { await window.desktop.appendLog(line) } catch { /* diagnostics only */ }
}

// Chromium-efficient blob→base64 for the WAF-dodge fallback below.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error || new Error('could not read audio for upload'))
    reader.readAsDataURL(blob)
  })
}

// One segment with retry: network drops and 5xx are transient — back off and retry;
// a 4xx is a real rejection — fail fast, with ONE exception: a 403 means an upstream
// WAF content signature matched the raw multipart audio bytes (the request never
// reaches ForgeNotes — this is what stranded "TCF Team Call 8/4" at chunk 20). The
// same chunk re-sent as base64 JSON is plain text those signatures don't match, so
// flip to that encoding and keep going.
async function uploadSegmentWithRetry(sessionId, s, sha) {
  let lastErr = null
  let useB64 = false
  for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
    try {
      if (useB64) {
        return await callFn('forgenotes-upload-file', {
          body: {
            session_id: sessionId,
            track: s.track,
            seq: String(s.seq),
            start_offset_ms: s.startOffsetMs != null ? String(s.startOffsetMs) : undefined,
            duration_ms: s.durationMs != null ? String(s.durationMs) : undefined,
            sha256: sha,
            mime_type: 'audio/webm',
            file_name: `${s.track}-${s.seq}.webm`,
            file_b64: await blobToBase64(s.blob),
          },
        })
      }
      const fd = new FormData()
      fd.append('session_id', sessionId)
      fd.append('track', s.track)
      fd.append('seq', String(s.seq))
      if (s.startOffsetMs != null) fd.append('start_offset_ms', String(s.startOffsetMs))
      if (s.durationMs != null) fd.append('duration_ms', String(s.durationMs))
      fd.append('sha256', sha)
      fd.append('file', s.blob, `${s.track}-${s.seq}.webm`)
      return await callFn('forgenotes-upload-file', { formData: fd })
    } catch (e) {
      lastErr = e
      const status = e.httpStatus || 0
      await diag(`upload ${s.track}-${s.seq}${useB64 ? ' (b64)' : ''} attempt ${attempt}/${CHUNK_ATTEMPTS} failed: ${e.message}${status ? ` (HTTP ${status})` : ' (network)'}`)
      if (status === 403 && !useB64) {
        useB64 = true
        setStatus(`${s.track}-${s.seq} blocked in transit — retrying with safe encoding…`, 'warn')
        continue
      }
      const retryable = !status || status >= 500
      if (!retryable || attempt === CHUNK_ATTEMPTS) throw e
      setStatus(`${s.track}-${s.seq} failed (${e.message}) — retrying…`, 'warn')
      await new Promise((resolve) => setTimeout(resolve, CHUNK_RETRY_DELAYS_MS[attempt - 1]))
    }
  }
  throw lastErr
}

function showUploaded(sessionId, message) {
  // Land on the Notes tab — the forged-notes document — matching the iPhone app.
  const url = `${CFG.forgenotesHost}/notes/m/${sessionId}?tab=notes`
  setStatus(message, 'ok')
  const link = $('open-link')
  link.classList.remove('hidden')
  link.onclick = (e) => {
    e.preventDefault()
    window.desktop.openExternal(url)
  }
}

function parseTags(raw) {
  const seen = new Set()
  const tags = []
  for (const piece of String(raw || '').split(',')) {
    const tag = piece.trim().replace(/\s+/g, ' ').slice(0, 48)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    tags.push(tag)
    if (tags.length >= 20) break
  }
  return tags
}

async function uploadSegments(localId, meta, seqd) {
  if (activeUploads.has(localId)) {
    setStatus('This recording is already uploading — hang tight.', 'warn')
    return
  }
  activeUploads.add(localId)
  try {
    setStatus(`Uploading ${seqd.length} segment${seqd.length === 1 ? '' : 's'} to ForgeNotes…`, 'busy')
    const times = FnCaptureClock.createSessionTimes(meta, localId)
    const body = {
      title: meta.title || 'Untitled meeting',
      source_type: meta.source_type || 'other',
      capture_profile: meta.capture_profile || (meta.source_type === 'in_person' ? 'room_single_mic' : 'remote_dual_track'),
      visibility: meta.visibility || 'private',
      // Comma-separated in the field, deduplicated case-insensitively, capped like every
      // other client. Hardcoded [] was the desktop's last dead capture option.
      tags: parseTags(meta.tags),
      // Stable per-recording ref: a retry reattaches to the SAME server session and
      // skips chunks the server already has, instead of re-uploading everything into
      // a fresh duplicate session.
      client_ref: localId,
      // started_at: when recording began (kept in meta.json), not when this upload runs.
      ...times,
    }
    // Which install recorded it, for ForgeNotes' one-live-recording-at-a-time rule. Only with
    // the real start: the rule compares meeting times, and without one the server would date
    // this upload by now. The server applies the same condition. Never blocks the upload.
    if (times.started_at) {
      const deviceId = await Promise.resolve().then(() => window.desktop.deviceId()).catch(() => null)
      if (deviceId) body.device_id = deviceId
    }
    // Empty pick = "Use my account default": OMIT template_key entirely so the server
    // (forgenotes-create-session) applies forgenotes_user_settings.default_template_key.
    // An explicit pick — including General — is always sent and always wins.
    if (meta.template_key) body.template_key = meta.template_key
    const created = await callFn('forgenotes-create-session', { body })
    const sessionId = created.session && created.session.id
    if (!sessionId) throw new Error('No session id returned')

    // A previous run may have fully uploaded + finalized this recording (e.g. a retry
    // that raced the automatic post-stop upload). Nothing to upload — clear the local
    // copy and link to the meeting.
    const sessionStatus = String((created.session && created.session.status) || '')
    if (created.existing && sessionStatus && sessionStatus !== 'created' && sessionStatus !== 'uploading') {
      await window.desktop.markUploaded(localId, sessionId)
      void analytics?.capture('upload_completed')
      await refreshPending()
      await diag(`upload skipped for ${localId}: session ${sessionId} already ${sessionStatus}`)
      showUploaded(sessionId, 'Already uploaded — ForgeNotes has this meeting.')
      return
    }

    const have = new Map()
    for (const c of created.chunks || []) have.set(`${c.track}:${c.seq}`, c)

    let done = 0
    let resumed = 0
    for (const saved of seqd) {
      const s = { ...saved, blob: saved.blob || new Blob([await window.desktop.readSegment(localId, saved)], { type: 'audio/webm' }) }
      const sha = await sha256Hex(await s.blob.arrayBuffer())
      const prev = have.get(`${s.track}:${s.seq}`)
      const alreadyUploaded = prev && (prev.sha256 ? prev.sha256 === sha : Number(prev.bytes) === s.blob.size)
      if (alreadyUploaded) {
        resumed += 1
      } else {
        await uploadSegmentWithRetry(sessionId, s, sha)
      }
      done += 1
      setStatus(`Uploading… ${done}/${seqd.length}${resumed ? ` (${resumed} already done)` : ''}`, 'busy')
    }

    // duration_seconds is captured audio (the recording clock leaves out pauses and sleep);
    // ended_at is when recording stopped, not when this upload finished.
    await callFn('forgenotes-finalize-session', {
      body: { session_id: sessionId, duration_seconds: meta.durationSec || 0, ...FnCaptureClock.finalizeTimes(meta, localId, seqd) },
    })

    await window.desktop.markUploaded(localId, sessionId)
      void analytics?.capture('upload_completed')
    await refreshPending()
    await diag(`upload complete ${localId} -> session ${sessionId} (${seqd.length} segments, ${resumed} resumed)`)

    showUploaded(sessionId, 'Uploaded. ForgeNotes is transcribing it now.')
    $('title').value = ''
  } catch (e) {
    if (e && e.httpStatus === 402) {
      // Quota, not breakage. The audio is safe locally and uploads cleanly next period.
      setStatus("You've used this month's recording hours. This recording is saved on this " +
        'device — retry after your quota resets, or upgrade in the iPhone app.', 'warn')
      await refreshPending()
      return
    }
    setStatus(`Upload failed — saved on this device, retry below. (${e.message})`, 'error')
    await diag(`upload run failed for ${localId}: ${e.message}${e.httpStatus ? ` (HTTP ${e.httpStatus})` : ''}`)
  } finally {
    activeUploads.delete(localId)
    await refreshPending()
  }
}

let stopLocalPlayback = () => {}
async function playLocalRecording(localId) {
  stopLocalPlayback()
  const { meta, files } = await window.desktop.playback(localId)
  if (!files.length) throw new Error('No playable audio is saved.')
  const panel = $('local-player'); panel.replaceChildren(); panel.classList.remove('hidden')
  const label = document.createElement('p'); label.textContent = meta.title || 'Local recording'
  const toggle = document.createElement('button'); toggle.className = 'btn primary'; toggle.textContent = 'Pause'
  const close = document.createElement('button'); close.className = 'btn ghost'; close.textContent = 'Close player'
  const select = document.createElement('select')
  const trackNames = [...new Set(files.map((f) => f.track))]
  for (const name of ['everyone', ...trackNames]) {
    const option = document.createElement('option'); option.value = name; option.textContent = name === 'everyone' ? 'Everyone' : name; select.appendChild(option)
  }
  const seek = document.createElement('input'); seek.type = 'range'; seek.min = '0'; seek.step = '0.1'
  seek.max = String(Math.max(...files.map((f) => (f.startOffsetMs + f.durationMs) / 1000)))
  seek.setAttribute('aria-label', 'Local playback position')
  const clock = document.createElement('span')
  let players = []; let position = 0; let playing = true
  function pause() { players.forEach((p) => p.pause()) }
  function dispose() { players.forEach(p => { p.onended = null; p.ontimeupdate = null; p.onerror = null; p.onloadedmetadata = null; p.removeAttribute('src'); p.load() }) }
  function playAt(seconds) {
    pause(); dispose(); players = []; position = seconds
    const selected = select.value === 'everyone' ? trackNames : [select.value]
    const chosen = selected.map((track) => {
      const trackFiles = files.filter((f) => f.track === track).sort((a, b) => a.seq - b.seq)
      return [...trackFiles].reverse().find((f) => f.startOffsetMs / 1000 <= seconds && (f.startOffsetMs + f.durationMs) / 1000 > seconds)
    }).filter(Boolean)
    if (!chosen.length) { playing = false; toggle.textContent = 'Play'; return }
    const masterFile = chosen.reduce((a, b) => a.durationMs >= b.durationMs ? a : b)
    for (const file of chosen) {
      const audio = new Audio(file.url); players.push(audio)
      audio.onloadedmetadata = () => { audio.currentTime = Math.max(0, seconds - file.startOffsetMs / 1000); if (playing) audio.play().catch(() => { playing = false; toggle.textContent = 'Play' }) }
      audio.onerror = () => { pause(); setStatus('A saved segment could not be played. Open folder to inspect it.', 'error') }
      if (file === masterFile) {
        audio.ontimeupdate = () => { position = file.startOffsetMs / 1000 + audio.currentTime; seek.value = String(position); clock.textContent = `${Math.floor(position / 60)}:${String(Math.floor(position % 60)).padStart(2, '0')}` }
        audio.onended = () => { const nextFile = files.filter(f => selected.includes(f.track) && f.startOffsetMs > file.startOffsetMs).sort((a,b) => a.startOffsetMs-b.startOffsetMs)[0]; if (nextFile) playAt(nextFile.startOffsetMs / 1000); else { playing = false; toggle.textContent = 'Play'; pause() } }
      }
    }
  }
  toggle.onclick = () => { playing = !playing; toggle.textContent = playing ? 'Pause' : 'Play'; if (playing) playAt(position >= Number(seek.max) ? 0 : position); else pause() }
  seek.oninput = () => playAt(Number(seek.value))
  select.onchange = () => playAt(position)
  stopLocalPlayback = () => { pause(); dispose(); panel.replaceChildren(); panel.classList.add('hidden') }
  close.onclick = stopLocalPlayback
  panel.append(label, toggle, select, seek, clock, close)
  playAt(0)
}

// ---------------------------------------------------------------- offline queue
async function refreshPending() {
  const list = $('pending-list')
  const items = await window.desktop.listPending()
  if (!items.length) {
    hide('pending-view')
    list.innerHTML = ''
    return
  }
  show('pending-view')
  list.innerHTML = ''
  for (const item of items) {
    const li = document.createElement('li')
    li.className = 'pending-item'

    const meta = document.createElement('div')
    meta.className = 'meta'
    const title = document.createElement('span')
    title.className = 't'
    title.textContent = item.meta.title || 'Untitled meeting'
    const sub = document.createElement('span')
    sub.className = 's'
    const when = formatWhen(item.meta.createdAt)
    const tracks = (item.meta.tracks || []).join(' + ')
    const setup = item.meta.capture_profile === 'room_single_mic' ? 'in person' : 'online call'
    sub.textContent = `${when} · ${setup} · ${tracks} · ${item.meta.durationSec || 0}s${item.meta.state === 'recording' ? ' · recovered checkpoints (recording interrupted)' : ''}`
    meta.appendChild(title)
    meta.appendChild(sub)

    const actions = document.createElement('div')
    actions.className = 'actions'
    const retry = document.createElement('button')
    retry.className = 'btn primary'
    // While this recording's upload run is in flight, Retry must not start a second
    // parallel run (that's how duplicate meetings were created).
    if (activeUploads.has(item.localId)) {
      retry.textContent = 'Uploading…'
      retry.disabled = true
    } else {
      retry.textContent = item.meta.state === 'uploaded' ? 'Uploaded' : 'Upload & transcribe'
      retry.disabled = ['uploaded', 'damaged'].includes(item.meta.state) || Boolean(rec && `rec_${rec.startedAt}` === item.localId)
    }
    retry.onclick = () => retryPending(item.localId, retry)
    const discard = document.createElement('button')
    discard.className = 'btn ghost'
    discard.textContent = 'Discard'
    discard.onclick = () => discardPending(item.localId)
    const play = document.createElement('button')
    play.className = 'btn ghost'; play.textContent = 'Play recording'; play.disabled = item.meta.state === 'damaged'
    play.onclick = () => playLocalRecording(item.localId).catch((e) => setStatus(e.message, 'error'))
    const folder = document.createElement('button')
    folder.className = 'btn ghost'; folder.textContent = 'Open folder'
    folder.onclick = () => window.desktop.openRecordingFolder(item.localId).catch((e) => setStatus(e.message, 'error'))
    discard.disabled = activeUploads.has(item.localId) || Boolean(rec && `rec_${rec.startedAt}` === item.localId)
    actions.appendChild(play)
    actions.appendChild(folder)
    actions.appendChild(retry)
    actions.appendChild(discard)

    li.appendChild(meta)
    li.appendChild(actions)
    list.appendChild(li)
  }
}

async function retryPending(localId, btn) {
  if (!auth) {
    setStatus('Sign in first, then retry.', 'warn')
    return
  }
  if (activeUploads.has(localId)) {
    setStatus('This recording is already uploading — hang tight.', 'warn')
    return
  }
  btn.disabled = true
  btn.textContent = 'Uploading…'
  try {
    const { meta, files } = await window.desktop.playback(localId)
    const seqd = files.map(({ url, ...segment }) => segment)
    if (!seqd.length) throw new Error('No audio on disk')
    await uploadSegments(localId, meta, seqd)
  } catch (e) {
    setStatus(`Retry failed: ${e.message}`, 'error')
    btn.disabled = false
    btn.textContent = 'Retry'
  }
}

async function discardPending(localId) {
  if (!window.confirm('Delete this local recording permanently?')) return
  await window.desktop.deleteRecording(localId)
  await refreshPending()
}

// ---------------------------------------------------------------- helpers
function setStatus(text, kind) {
  const el = $('status')
  if (!text) {
    el.classList.add('hidden')
    el.textContent = ''
    return
  }
  el.textContent = text
  el.className = `msg ${kind || 'busy'}`
  el.classList.remove('hidden')
}

function formatWhen(iso) {
  if (!iso) return 'Unknown time'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Unknown time'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ---------------------------------------------------------------- events
function wireEvents() {
  $('login-btn').onclick = async () => {
    const email = $('login-email').value.trim()
    const password = $('login-password').value
    hide('login-error')
    if (!email || !password) {
      $('login-error').textContent = 'Enter your email and password.'
      show('login-error')
      return
    }
    $('login-btn').disabled = true
    $('login-btn').textContent = 'Signing in…'
    try {
      await signIn(email, password)
      await enterRecorder()
    } catch (e) {
      $('login-error').textContent = e.message
      show('login-error')
    } finally {
      $('login-btn').disabled = false
      $('login-btn').textContent = 'Sign in'
    }
  }
  $('login-password').onkeydown = (e) => {
    if (e.key === 'Enter') $('login-btn').click()
  }
  $('sso-btn').onclick = startSso
  $('sso-cancel').onclick = async () => {
    try { await window.desktop.ssoCancel() } catch { /* nothing was waiting */ }
    setSsoWaiting(false)
  }
  window.desktop.onSsoResult(onSsoResult)

  $('auto-upload').checked = localStorage.getItem('fn_auto_upload') === 'true'
  $('auto-upload').onchange = (e) => localStorage.setItem('fn_auto_upload', String(e.target.checked))
  // "Announce recording aloud" — on unless the user switched it off. Set before
  // setCaptureProfile() below so the consent line renders with the right wording.
  let announceOn = true
  try { announceOn = localStorage.getItem(ANNOUNCE_KEY) !== 'false' } catch { /* storage unavailable: stay on */ }
  $('announce-recording').checked = announceOn
  $('announce-recording').onchange = (e) => {
    try { localStorage.setItem(ANNOUNCE_KEY, String(e.target.checked)) } catch { /* applies to this session only */ }
    renderAnnounceVoiceRow()
    renderConsentCopy()
  }
  $('announce-voice').onchange = (e) => {
    try { localStorage.setItem(ANNOUNCE_VOICE_KEY, e.target.value) } catch { /* applies to this session only */ }
  }
  $('announce-preview').onclick = previewAnnounceVoice
  // Read the voice list now so the picker is filled long before recording starts.
  announceVoicesLoaded = loadAnnounceVoices()
  $('local-record-btn').onclick = enterRecorder
  $('signout-btn').onclick = signOut
  $('start-btn').onclick = startRecording
  $('pause-btn').onclick = togglePause
  $('stop-btn').onclick = () => stopRecording('manual')
  // Stop on silence: the setting, and the answer to "Still there?" (button or notification).
  renderSilenceSetting(FnSilence.readCachedSilenceMinutes(prefs()))
  $('silence-minutes').onchange = (e) => saveSilenceSetting(Number(e.target.value))
  $('silence-retry').onclick = () => loadSilenceSetting()
  $('silence-keep').onclick = keepRecording
  window.desktop.onSilenceKeep(keepRecording)
  // The Mac going to sleep and waking up (main.js forwards powerMonitor).
  window.desktop.onPower(onPower)
  $('preflight-btn').onclick = runPreflight
  $('mic').onchange = () => { if (!rec) runPreflight() }
  if ($('system-source')) $('system-source').onchange = () => { if (!rec) runPreflight() }
  // Call audio: the one setting, the permission step, and the way to the macOS pane.
  $('system-audio-pref').onchange = (e) => {
    try { localStorage.setItem(SYSTEM_AUDIO_PREF_KEY, SA.normalizePreference(e.target.value)) } catch { /* applies to this session only */ }
    renderSystemAudioFields()
    setCaptureProfile(captureProfile(), { syncSource: false })
  }
  $('native-audio-allow').onclick = () => { if (!rec && !starting) void checkNativeAudio({ interactive: true }) }
  $('native-audio-settings').onclick = () => { void window.desktop.openSystemAudioSettings() }
  navigator.mediaDevices.addEventListener('devicechange', () => { void onAudioDevicesChanged() })
  renderSystemAudioFields()
  $('mode-online').onclick = () => setCaptureProfile('remote_dual_track')
  $('mode-room').onclick = () => setCaptureProfile('room_single_mic')
  $('source').onchange = () => setCaptureProfile($('source').value === 'in_person' ? 'room_single_mic' : 'remote_dual_track', { syncSource: false })
  setCaptureProfile(localStorage.getItem('forgenotes_capture_profile') === 'room_single_mic' ? 'room_single_mic' : 'remote_dual_track', { check: false })

  // Guard against losing an in-progress recording on accidental close.
  window.addEventListener('beforeunload', (e) => {
    if (rec) {
      e.preventDefault()
      e.returnValue = ''
    }
  })
}

boot()


// ── Live captions panel ──────────────────────────────────────────────────────
// The engine lives in transcriber.js (a module); this owns only pixels. Follow-the-tail
// scrolling yields to the user's wheel and resumes from the Latest pill — reading what was
// said two minutes ago is exactly what the panel is for.
let liveFollowing = true

function liveSetState(text) { $('live-state').textContent = text }

window.addEventListener('fn-live', (event) => {
  const d = event.detail || {}
  const panel = $('live-panel')
  if (d.type === 'ready') {
    $('live-toggle').textContent = window.fnLive.enabled() ? 'Turn off' : 'Turn on'
    return
  }
  if (d.type === 'enabled') {
    $('live-toggle').textContent = d.enabled ? 'Turn off' : 'Turn on'
    if (!d.enabled) panel.classList.add('hidden')
    return
  }
  if (d.type === 'progress') {
    panel.classList.remove('hidden')
    liveSetState(`downloading model… ${d.progress}%`)
    return
  }
  if (d.type === 'state') {
    if (d.state === 'idle') { panel.classList.add('hidden'); return }
    panel.classList.remove('hidden')
    if (d.state === 'loading') liveSetState('loading model…')
    else if (d.state === 'listening') liveSetState('listening')
    else if (d.state === 'paused') liveSetState('paused')
    else if (d.state === 'unsupported') { liveSetState('unavailable on this machine'); $('live-text').textContent = 'Live captions need WebGPU, which this machine does not offer. Recording is unaffected.' }
    else if (d.state === 'failed') { liveSetState('stopped'); if (d.message) $('live-text').textContent = d.message }
    return
  }
  if (d.type === 'text') {
    panel.classList.remove('hidden')
    $('live-text').textContent = d.text
    if (liveFollowing) {
      const scroller = $('live-scroll')
      scroller.scrollTop = scroller.scrollHeight
    }
  }
})

$('live-scroll').addEventListener('scroll', () => {
  const el = $('live-scroll')
  const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
  liveFollowing = nearBottom
  $('live-latest').classList.toggle('hidden', nearBottom)
})

$('live-latest').addEventListener('click', () => {
  liveFollowing = true
  const el = $('live-scroll')
  el.scrollTop = el.scrollHeight
  $('live-latest').classList.add('hidden')
})

$('live-toggle').addEventListener('click', () => {
  window.fnLive.setEnabled(!window.fnLive.enabled())
})

// ── First-run hint ───────────────────────────────────────────────────────────
try {
  if (!localStorage.getItem('fn_seen_intro')) $('first-run').classList.remove('hidden')
} catch { /* private mode */ }
$('first-run-dismiss').addEventListener('click', () => {
  try { localStorage.setItem('fn_seen_intro', '1') } catch { /* private mode */ }
  $('first-run').classList.add('hidden')
})
