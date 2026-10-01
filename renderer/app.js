// ForgeNotes Recorder (macOS). Captures microphone and BlackHole system input
// as separate one-minute segments, checkpointed locally before optional upload.
// A crash can lose the current segment; completed checkpoints remain recoverable.
'use strict'

const $ = (id) => document.getElementById(id)
const show = (id) => $(id).classList.remove('hidden')
const hide = (id) => $(id).classList.add('hidden')

const ROTATE_MS = 60 * 1000 // segment length — keeps each uploaded file small

// Spoken once through the default audio output when a recording starts.
const ANNOUNCE_TEXT = 'This meeting is being recorded.'
const ANNOUNCE_KEY = 'fn_announce_recording' // localStorage: 'false' = off, anything else = on
const ANNOUNCE_VOICE_WAIT_MS = 1000 // voices can still be loading on a cold start
const ANNOUNCE_START_TIMEOUT_MS = 5000 // speech never started — tell the user

let CFG = null
let auth = null // { access_token, refresh_token, expires_at(ms), email }
let rec = null // active recording state
let preflightMeter = null // live mic meter used by the pre-record device check
let announceUtterance = null // held so the utterance isn't garbage-collected mid-speech

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

// ---------------------------------------------------------------- recorder view
async function enterRecorder() {
  hide('login-view')
  show('recorder-view')
  $('account-email').textContent = auth?.email || 'Recording locally'
  $('signout-btn').textContent = auth ? 'Sign out' : 'Sign in'
  await populateMics()
  runPreflight()
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

// Live RMS meters so you can SEE whether each track is actually receiving audio.
function setupMeters(micStream, systemStream) {
  let ctx
  try {
    ctx = new AudioContext()
  } catch {
    return { stop() {} }
  }
  const make = (stream, fillId) => {
    if (!stream) return null
    const src = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    src.connect(analyser)
    return { analyser, data: new Uint8Array(analyser.fftSize), fillId }
  }
  const meters = [make(micStream, 'meter-mic'), make(systemStream, 'meter-system')].filter(Boolean)
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
  }
}

// ---------------------------------------------------------------- recording announcement
// Says "This meeting is being recorded." aloud, once, through the computer's default audio
// output right after capture has started, so the notice itself lands in the recording.
// It uses the built-in Web Speech API: nothing to install, no audio driver, no virtual
// microphone. People on a call only hear it when the speakers (not headphones) are on.
// It is never awaited and every failure is swallowed — the announcement must never delay
// or break a recording.
function announceEnabled() {
  const box = $('announce-recording')
  return box ? box.checked : true
}

function showAnnounceNote(visible) {
  const el = $('announce-note')
  if (el) el.classList.toggle('hidden', !visible)
}

// Prefer an installed en-US voice, then any en-US voice, then any English voice. With no
// match the utterance keeps lang=en-US and the platform picks its own default.
function announcementVoice(synth) {
  let voices = []
  try { voices = synth.getVoices() || [] } catch { /* treat as no voices */ }
  const lang = (v) => String(v.lang || '').replace('_', '-').toLowerCase()
  return (
    voices.find((v) => lang(v) === 'en-us' && v.localService) ||
    voices.find((v) => lang(v) === 'en-us') ||
    voices.find((v) => lang(v).startsWith('en')) ||
    null
  )
}

// Chromium fills the voice list asynchronously. Resolve as soon as it is populated
// (voiceschanged) or after a short wait, whichever comes first. Recording is already
// running by the time this is called, so the wait delays only the announcement.
function announcementVoicesReady(synth) {
  return new Promise((resolve) => {
    let loaded = false
    try { loaded = synth.getVoices().length > 0 } catch { /* fall through to the wait */ }
    if (loaded) return resolve()
    let timer = 0
    const done = () => {
      clearTimeout(timer)
      try { synth.removeEventListener('voiceschanged', done) } catch { /* ignore */ }
      resolve()
    }
    timer = setTimeout(done, ANNOUNCE_VOICE_WAIT_MS)
    try { synth.addEventListener('voiceschanged', done) } catch { /* the timeout still resolves */ }
  })
}

async function announceRecording(current) {
  let watchdog = 0
  const failed = (why) => {
    clearTimeout(watchdog)
    console.warn('[forgenotes] recording announcement did not play:', why)
    if (rec === current) showAnnounceNote(true)
  }
  try {
    const synth = window.speechSynthesis
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
      failed('speech synthesis is unavailable')
      return
    }
    await announcementVoicesReady(synth)
    if (rec !== current || current.stopping) return // stopped before it could be said
    const utterance = new SpeechSynthesisUtterance(ANNOUNCE_TEXT)
    utterance.lang = 'en-US'
    utterance.rate = 0.95
    utterance.volume = 1
    const voice = announcementVoice(synth)
    if (voice) utterance.voice = voice
    utterance.onstart = () => clearTimeout(watchdog)
    utterance.onend = () => {
      clearTimeout(watchdog)
      if (announceUtterance === utterance) announceUtterance = null
    }
    utterance.onerror = (e) => {
      if (announceUtterance === utterance) announceUtterance = null
      failed((e && e.error) || 'speech error')
    }
    announceUtterance = utterance
    if (synth.speaking || synth.pending) synth.cancel() // clear anything stuck in the queue
    watchdog = setTimeout(() => failed('speech did not start'), ANNOUNCE_START_TIMEOUT_MS)
    synth.speak(utterance)
  } catch (e) {
    failed((e && e.message) || e)
  }
}

// ---------------------------------------------------------------- segmented recording
// One MediaRecorder per track per segment. On stop (rotation or final), its onstop
// pushes the completed, independently-decodable webm blob to rec.segments.
function bankSegment(track, blob, startOffsetMs, durationMs) {
  if (!blob.size || !rec) return Promise.resolve()
  const current = rec
  const seq = current.nextSeq[track] || 0
  current.nextSeq[track] = seq + 1
  const entry = { track, seq, startOffsetMs, durationMs }
  current.segments.push(entry)
  const writing = current.writes.then(async () => {
    await window.desktop.checkpoint(`rec_${current.startedAt}`, { ...current.meta, createdAt: new Date(current.startedAt).toISOString() }, { ...entry, data: await blob.arrayBuffer() })
  })
  current.writes = writing
  writing.catch((e) => {
    if (current.saveError) return
    current.saveError = e
    setStatus('Local saving failed. Capture is stopping; completed checkpoints remain on disk. ' + e.message, 'error')
    if (rec === current && !current.stopping) void stopRecording().catch(() => {})
  })
  return writing
}

function startTrackSegment(track, stream) {
  if (!stream) return null
  const chunks = []
  const startOffsetMs = elapsedMs()
  const recorder = new MediaRecorder(stream, rec.mime ? { mimeType: rec.mime } : undefined)
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: rec ? rec.mime : 'audio/webm' })
    if (blob.size && rec) bankSegment(track, blob, startOffsetMs, Math.max(0, elapsedMs() - startOffsetMs))
  }
  recorder.start(1000)
  return { recorder, chunks, startOffsetMs }
}

// Rotate every ROTATE_MS: stop the current segment recorders (their onstop banks the
// segment) and immediately start fresh ones. The ~ms gap is negligible for transcription.
function rotate() {
  if (!rec || rec.paused || rec.stopping) return
  const cycle = (key, track, stream) => {
    const seg = rec[key]
    if (seg && seg.recorder && seg.recorder.state !== 'inactive') seg.recorder.stop()
    rec[key] = startTrackSegment(track, stream)
  }
  cycle('mic', 'mic', rec.micStream)
  cycle('system', 'system', rec.systemStream)
}

// Stop one track's current segment and wait for its blob to be banked.
function flushSegment(key, track) {
  return new Promise((resolve) => {
    const seg = rec && rec[key]
    if (!seg || !seg.recorder) return resolve()
    seg.recorder.onstop = () => {
      const blob = new Blob(seg.chunks, { type: rec ? rec.mime || 'audio/webm' : 'audio/webm' })
      if (blob.size && rec) bankSegment(track, blob, seg.startOffsetMs, Math.max(0, elapsedMs() - seg.startOffsetMs))
      resolve()
    }
    if (seg.recorder.state !== 'inactive') seg.recorder.stop()
    else resolve()
  })
}

async function startRecording() {
  setStatus('', null)
  showAnnounceNote(false)
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
  rec = {
    micStream,
    systemStream,
    mime: mime || 'audio/webm',
    startedAt: Date.now(),
    pausedMs: 0,
    pauseStart: 0,
    paused: false,
    meta: {
      title: $('title').value.trim(),
      source_type: $('source').value,
      capture_profile: profile,
      visibility: $('visibility').value,
      template_key: $('template').value,
      tags: $('tags').value,
    },
    mic: null,
    system: null,
    segments: [],
    nextSeq: {},
    writes: Promise.resolve(),
    saveError: null,
    rotateTimer: null,
    timer: null,
    meters: null,
    stopping: false,
  }
  rec.mic = startTrackSegment('mic', micStream)
  rec.system = startTrackSegment('system', systemStream)
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
  // Fire-and-forget: captions must never delay or endanger the recording.
  if (window.fnLive) window.fnLive.start({ micStream, systemStream })

  $('start-btn').classList.add('hidden')
  $('pause-btn').classList.remove('hidden')
  $('stop-btn').classList.remove('hidden')
  $('signout-btn').disabled = true
  show('rec-indicator')
  rec.timer = setInterval(updateTimer, 500)
  updateTimer()
}

function togglePause() {
  if (!rec) return
  const recorders = [rec.mic, rec.system].filter(Boolean).map((s) => s.recorder)
  if (!rec.paused) {
    recorders.forEach((r) => { if (r.state === 'recording') r.pause() })
    rec.paused = true
    rec.pauseStart = Date.now()
    if (window.fnLive) window.fnLive.setPaused(true)
    $('pause-btn').textContent = 'Resume'
    $('rec-indicator').classList.add('hidden')
  } else {
    recorders.forEach((r) => { if (r.state === 'paused') r.resume() })
    rec.pausedMs += Date.now() - rec.pauseStart
    rec.paused = false
    if (window.fnLive) window.fnLive.setPaused(false)
    $('pause-btn').textContent = 'Pause'
    show('rec-indicator')
  }
}

function elapsedMs() {
  if (!rec) return 0
  const paused = rec.paused ? Date.now() - rec.pauseStart : 0
  return Math.max(0, Date.now() - rec.startedAt - rec.pausedMs - paused)
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

async function stopRecording() {
  if (!rec || rec.stopping) return
  rec.stopping = true
  if (window.fnLive) window.fnLive.stop()
  clearInterval(rec.rotateTimer)
  clearInterval(rec.timer)
  if (rec.meters) rec.meters.stop()
  hide('meters')
  hide('rec-indicator')
  $('pause-btn').classList.add('hidden')
  $('stop-btn').classList.add('hidden')
  $('pause-btn').textContent = 'Pause'

  // Flush the in-progress segment on each track, then collect everything.
  await flushSegment('mic', 'mic')
  await flushSegment('system', 'system')

  rec.micStream.getTracks().forEach((t) => t.stop())
  if (rec.systemStream) rec.systemStream.getTracks().forEach((t) => t.stop())

  const current = rec
  const segments = rec.segments
  const localId = `rec_${rec.startedAt}`
  rec = null
  resetControls()

  if (!segments.length) {
    setStatus('Nothing was recorded.', 'error')
    return
  }

  try {
    await current.writes
    await window.desktop.finishRecording(localId)
    await refreshPending()
  } catch (e) {
    await refreshPending().catch(() => {})
    setStatus(`Could not finish saving. Completed checkpoints remain on disk: ${e.message}`, 'error')
    return
  }
  setStatus('Saved on this device. Play it below, open its folder, or choose Upload & transcribe.', 'ok')
  if ($('auto-upload').checked && auth) await retryPending(localId, $('stop-btn'))

}

function resetControls() {
  $('start-btn').classList.remove('hidden')
  $('signout-btn').disabled = false
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

    await callFn('forgenotes-finalize-session', {
      body: { session_id: sessionId, duration_seconds: meta.durationSec || 0 },
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
    renderConsentCopy()
  }
  // Ask for the voice list now so it has loaded by the time recording starts.
  try { if (window.speechSynthesis) window.speechSynthesis.getVoices() } catch { /* announcement is optional */ }
  $('local-record-btn').onclick = enterRecorder
  $('signout-btn').onclick = signOut
  $('start-btn').onclick = startRecording
  $('pause-btn').onclick = togglePause
  $('stop-btn').onclick = stopRecording
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
