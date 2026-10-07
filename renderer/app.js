// ForgeNotes Recorder (macOS). Captures microphone and BlackHole system input
// as separate one-minute segments, checkpointed locally before optional upload.
// A crash can lose the current segment; completed checkpoints remain recoverable.
//
// Time: the recording's clock (capture-clock.js) stops while paused and while the Mac
// sleeps, so segment offsets and durations count captured audio only; a suspend ends the
// segment and a resume starts a new one. The true start and end are kept with the local
// recording and sent as started_at / ended_at, however late the upload is.
// Stop on silence (silence.js): off unless the person turned it on.
'use strict'

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
let auth = null // { access_token, refresh_token, expires_at(ms), email }
let rec = null // active recording state
let preflightMeter = null // live mic meter used by the pre-record device check
let announceVoices = { voices: [], defaultId: '' } // from renderer/announce/voices.json
let announceVoicesLoaded = Promise.resolve() // settles once the voice list has been read
let announceClip = null // the announcement or preview clip that is playing, if any

// ---------------------------------------------------------------- boot
async function boot() {
  CFG = await window.desktop.getConfig()
  const verEl = $('app-version')
  if (verEl && CFG.version) verEl.textContent = `v${CFG.version}`
  wireUpdateBadge(verEl)
  wireEvents()
  if (CFG._parseError || !CFG.supabaseUrl || !CFG.supabaseAnonKey) {
    if (CFG._parseError) {
      const detail = document.querySelector('#config-error p')
      if (detail) {
        detail.textContent = `${CFG._parseError}. Open config.json and make sure every value — especially the anon key — is wrapped in double quotes, then restart.`
      }
    }
    show('config-error')
    show('login-view')
    $('login-btn').disabled = true
    await refreshPending()
    return
  }
  const refresh = await window.desktop.secureGet()
  if (refresh) {
    try {
      await refreshSession(refresh)
      await enterRecorder()
    } catch {
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
  const res = await fetch(`${CFG.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: CFG.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error_description || data.msg || data.error || 'Sign-in failed')
  setAuth(data)
}

async function refreshSession(refreshToken) {
  const res = await fetch(`${CFG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: CFG.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) throw new Error('session_expired')
  setAuth(data)
}

function setAuth(data) {
  auth = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3600) * 1000,
    email: (data.user && data.user.email) || (auth && auth.email) || '',
  }
  window.desktop.secureSet(data.refresh_token)
}

async function getToken() {
  if (!auth) throw new Error('Not signed in')
  if (Date.now() > auth.expires_at - 60000) await refreshSession(auth.refresh_token)
  return auth.access_token
}

async function signOut() {
  auth = null
  stopPreflightMeter()
  await window.desktop.secureClear()
  hide('recorder-view')
  show('login-view')
}

// ---------------------------------------------------------------- edge fn call
async function callFn(name, { body, formData } = {}) {
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
async function callRpc(name, args) {
  const token = await getToken()
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
    : 'Captures your microphone and BlackHole call audio as separate tracks.'
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

// A pre-record device check: is the mic live (with a level meter to prove it), is the
// call-audio source (BlackHole) present + selected, and is there enough disk for a long
// meeting? Purely informational — Start still works; capture errors also surface on Start.
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
    setPreflightRow('mic', 'ok', 'Microphone', 'Ready — speak and watch the level move.')
  } catch (e) {
    setPreflightRow('mic', 'fail', 'Microphone', `Not available (${e.name || e.message}). Allow microphone access in System Settings → Privacy & Security → Microphone, then re-check.`)
  }

  if (captureProfile() === 'room_single_mic') {
    setPreflightRow('system', 'ok', 'Recording setup', 'Room microphone only — BlackHole is not needed.')
  } else {
    // Call-audio source: the BlackHole (or chosen) input that carries the meeting audio.
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
      const hasBlackhole = inputs.some((d) => /blackhole/i.test(d.label || ''))
      const sysSel = $('system-source')
      const selected = sysSel && sysSel.value
      const selectedLabel = selected ? (inputs.find((d) => d.deviceId === selected)?.label || 'selected input') : ''
      if (selected) setPreflightRow('system', 'ok', 'Call audio source', `Capturing “${selectedLabel}” — route the meeting into it via a Multi-Output Device.`)
      else if (hasBlackhole) setPreflightRow('system', 'warn', 'Call audio source', 'BlackHole is available but not selected — pick it above to capture call audio.')
      else setPreflightRow('system', 'warn', 'Call audio source', 'No system-audio source — install BlackHole 2ch (see README) to capture call audio.')
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
      if (/blackhole/i.test(d.label || '')) blackholeId = d.deviceId
    })
    if (blackholeId) sysSel.value = blackholeId
  }
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
    return { stop() {}, read() { return null }, chime() {}, audioMs() { return undefined } }
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
    return { analyser, data: new Uint8Array(analyser.fftSize), fillId, track, room, samples: new Float32Array(room.fftSize) }
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

function startTrackSegment(current, track, stream) {
  if (!stream) return null
  const chunks = []
  const startOffsetMs = offsetNow(current)
  const recorder = new MediaRecorder(stream, current.mime ? { mimeType: current.mime } : undefined)
  const seg = { recorder, chunks, startOffsetMs, endOffsetMs: null, done: null }
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  seg.done = new Promise((resolve) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: current.mime || 'audio/webm' })
      // The end is fixed when the segment is ended (endTrackSegment), not when the encoder
      // gets round to stopping: after a suspend that can be after the Mac woke up.
      const end = seg.endOffsetMs ?? offsetNow(current)
      if (blob.size) bankSegment(current, track, blob, startOffsetMs, Math.max(0, end - startOffsetMs))
      resolve()
    }
  })
  // Stop waits for every segment still being closed (one ended at a suspend may only
  // finish after the Mac wakes), so nothing is banked after the recording is finished.
  current.closing.add(seg.done)
  seg.done.then(() => current.closing.delete(seg.done))
  recorder.start(1000)
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
  if (current.systemStream && !streamLive(current.systemStream)) {
    current.systemStream = null
    const sysEl = $('cap-system')
    sysEl.textContent = 'Call audio: NOT captured — mic only'
    sysEl.className = 'cap bad'
    setStatus('Call audio was not available after the Mac woke up — recording the microphone only.', 'warn')
  }
  try {
    startSegments(current)
  } catch (e) {
    void diag(`${current.localId}: could not restart capture after waking: ${e.message}`)
    void endSegments(current)
    void stopRecording('device_lost')
  }
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

async function startRecording() {
  setStatus('', null)
  showAnnounceNote(false)
  showStopNote('')
  stopAnnounceClip() // a voice preview must not run into the recording
  hide('open-link')
  stopLocalPlayback()
  stopPreflightMeter() // release the preflight mic before opening the recording streams
  const micId = $('mic').value
  const profile = captureProfile()
  const systemId = profile === 'remote_dual_track' && $('system-source') ? $('system-source').value : ''

  let micStream
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micId ? { exact: micId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
  } catch (e) {
    setStatus(`Could not open the microphone: ${e.message}`, 'error')
    return
  }

  let systemStream = null
  let warning = null
  if (systemId) {
    try {
      systemStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: systemId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      const track = systemStream.getAudioTracks()[0]
      console.log('[forgenotes] system-audio (BlackHole) track:', track && track.label, track && track.getSettings())
    } catch (e) {
      systemStream = null
      warning = `Could not open the system-audio device (${e.name}: ${e.message}) — recording mic only. Is BlackHole installed and selected?`
      console.error('[forgenotes] system getUserMedia failed:', e)
    }
  } else if (profile === 'remote_dual_track') {
    warning = 'No system-audio source selected — recording mic only. Pick BlackHole 2ch to capture the meeting.'
  }

  const mime = pickMime()
  const startedAt = Date.now()
  rec = {
    localId: `rec_${startedAt}`,
    micStream,
    systemStream,
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
  }
  startSegments(rec)
  rec.rotateTimer = setInterval(rotate, ROTATE_MS)

  // Capture is live — say the notice now so it is part of the recording. Only here, on a
  // fresh start: resuming from pause and segment rotation never repeat it. This runs well
  // after stopLocalPlayback() above, which only touches the saved-recording player.
  // Fire-and-forget: it must never delay or endanger the recording.
  if (announceEnabled()) void announceRecording(rec)

  if (warning) setStatus(warning, 'warn')

  // Persistent capture status + live meters — the "Call audio" bar moving means the
  // meeting is actually being captured; flat means mic-only.
  const sysEl = $('cap-system')
  if (profile === 'room_single_mic') {
    sysEl.textContent = 'Room microphone only'
    sysEl.className = 'cap ok'
  } else {
    sysEl.textContent = systemStream ? 'Call audio: capturing' : 'Call audio: NOT captured — mic only'
    sysEl.className = systemStream ? 'cap ok' : 'cap bad'
  }
  rec.meters = setupMeters(micStream, systemStream)
  show('meters')
  startSilenceWatch(rec)
  // Fire-and-forget: captions must never delay or endanger the recording.
  if (window.fnLive) window.fnLive.start({ micStream, systemStream })

  $('start-btn').classList.add('hidden')
  $('pause-btn').classList.remove('hidden')
  $('stop-btn').classList.remove('hidden')
  $('signout-btn').disabled = true
  setAnnouncePreviewDisabled(true)
  show('rec-indicator')
  rec.timer = setInterval(heartbeat, HEARTBEAT_MS)
  updateTimer()
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
    await refreshPending()
  } catch (e) {
    await refreshPending().catch(() => {})
    setStatus(`Could not finish saving. Completed checkpoints remain on disk: ${e.message}`, 'error')
    return
  }
  setStatus('Saved on this device. Play it below, open its folder, or choose Upload & transcribe.', 'ok')
  void loadSilenceSetting() // the next Start uses the account's current choice
  if (uploading) await retryPending(localId, $('stop-btn'))

}

function resetControls() {
  $('start-btn').classList.remove('hidden')
  $('signout-btn').disabled = false
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
