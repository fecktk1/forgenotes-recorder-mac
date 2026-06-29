// ForgeNotes Recorder (macOS) — renderer. Captures mic + the BlackHole system input
// as separate tracks, then drives the SAME create-session -> upload-file ->
// finalize-session flow the web app uses. To support long meetings, each track is
// recorded as a series of ~5-minute SEGMENTS (seq 0,1,2,…) — the transcription worker
// concatenates them — so no single uploaded file ever hits the storage/edge size
// ceiling. Recordings are always saved locally first, so a failed upload is retryable.
'use strict'

const $ = (id) => document.getElementById(id)
const show = (id) => $(id).classList.remove('hidden')
const hide = (id) => $(id).classList.add('hidden')

const ROTATE_MS = 5 * 60 * 1000 // segment length — keeps each uploaded file small

let CFG = null
let auth = null // { access_token, refresh_token, expires_at(ms), email }
let rec = null // active recording state

// ---------------------------------------------------------------- boot
async function boot() {
  CFG = await window.desktop.getConfig()
  const verEl = $('app-version')
  if (verEl && CFG.version) verEl.textContent = `v${CFG.version}`
  if (CFG._parseError || !CFG.supabaseUrl || !CFG.supabaseAnonKey) {
    if (CFG._parseError) {
      const detail = document.querySelector('#config-error p')
      if (detail) {
        detail.textContent = `${CFG._parseError}. Open config.json and make sure every value — especially the anon key — is wrapped in double quotes, then restart.`
      }
    }
    show('config-error')
    return
  }
  wireEvents()
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
  if (!res.ok) throw new Error(data.error || data.message || `${name} failed (${res.status})`)
  return data
}

// ---------------------------------------------------------------- recorder view
async function enterRecorder() {
  hide('login-view')
  show('recorder-view')
  $('account-email').textContent = auth.email || 'Signed in'
  await populateMics()
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

// ---------------------------------------------------------------- segmented recording
// One MediaRecorder per track per segment. On stop (rotation or final), its onstop
// pushes the completed, independently-decodable webm blob to rec.segments.
function startTrackSegment(track, stream) {
  if (!stream) return null
  const chunks = []
  const recorder = new MediaRecorder(stream, rec.mime ? { mimeType: rec.mime } : undefined)
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: rec ? rec.mime : 'audio/webm' })
    if (blob.size && rec) rec.segments.push({ track, blob })
  }
  recorder.start(1000)
  return { recorder, chunks }
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
      if (blob.size && rec) rec.segments.push({ track, blob })
      resolve()
    }
    if (seg.recorder.state !== 'inactive') seg.recorder.stop()
    else resolve()
  })
}

async function startRecording() {
  setStatus('', null)
  hide('open-link')
  const micId = $('mic').value
  const systemId = $('system-source') ? $('system-source').value : ''

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
  } else {
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
      visibility: $('visibility').value,
    },
    mic: null,
    system: null,
    segments: [],
    rotateTimer: null,
    timer: null,
    meters: null,
    stopping: false,
  }
  rec.mic = startTrackSegment('mic', micStream)
  rec.system = startTrackSegment('system', systemStream)
  rec.rotateTimer = setInterval(rotate, ROTATE_MS)

  if (warning) setStatus(warning, 'warn')

  // Persistent capture status + live meters — the "Call audio" bar moving means the
  // meeting is actually being captured; flat means mic-only.
  const sysEl = $('cap-system')
  sysEl.textContent = systemStream ? 'Call audio: capturing' : 'Call audio: NOT captured — mic only'
  sysEl.className = systemStream ? 'cap ok' : 'cap bad'
  rec.meters = setupMeters(micStream, systemStream)
  show('meters')

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
    $('pause-btn').textContent = 'Resume'
    $('rec-indicator').classList.add('hidden')
  } else {
    recorders.forEach((r) => { if (r.state === 'paused') r.resume() })
    rec.pausedMs += Date.now() - rec.pauseStart
    rec.paused = false
    $('pause-btn').textContent = 'Pause'
    show('rec-indicator')
  }
}

function elapsedSec() {
  if (!rec) return 0
  const paused = rec.paused ? Date.now() - rec.pauseStart : 0
  return Math.max(0, Math.round((Date.now() - rec.startedAt - rec.pausedMs - paused) / 1000))
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

  const segments = rec.segments
  const durationSec = Math.max(1, Math.round((Date.now() - rec.startedAt - rec.pausedMs) / 1000))
  const baseMeta = { ...rec.meta, durationSec, createdAt: new Date().toISOString() }
  const localId = `rec_${rec.startedAt}`
  rec = null
  resetControls()

  if (!segments.length) {
    setStatus('Nothing was recorded.', 'error')
    return
  }

  // Assign each track its own seq 0,1,2,… in chronological order.
  const seqByTrack = {}
  const seqd = segments.map((s) => {
    seqByTrack[s.track] = seqByTrack[s.track] === undefined ? 0 : seqByTrack[s.track] + 1
    return { track: s.track, seq: seqByTrack[s.track], blob: s.blob }
  })
  const meta = {
    ...baseMeta,
    segments: seqd.map((s) => ({ track: s.track, seq: s.seq })),
    tracks: Array.from(new Set(seqd.map((s) => s.track))),
  }

  // Always persist locally BEFORE attempting upload (offline-safe).
  try {
    const ipcSegs = await Promise.all(
      seqd.map(async (s) => ({ track: s.track, seq: s.seq, data: await s.blob.arrayBuffer() })),
    )
    await window.desktop.saveRecording(localId, meta, ipcSegs)
    await refreshPending()
  } catch (e) {
    setStatus(`Could not save the recording locally: ${e.message}`, 'error')
    return
  }

  await uploadSegments(localId, meta, seqd)
}

function resetControls() {
  $('start-btn').classList.remove('hidden')
  $('signout-btn').disabled = false
}

// ---------------------------------------------------------------- upload
async function uploadSegments(localId, meta, seqd) {
  setStatus(`Uploading ${seqd.length} segment${seqd.length === 1 ? '' : 's'} to ForgeNotes…`, 'busy')
  try {
    const created = await callFn('forgenotes-create-session', {
      body: {
        title: meta.title || 'Untitled meeting',
        source_type: meta.source_type || 'other',
        visibility: meta.visibility || 'private',
        tags: [],
      },
    })
    const sessionId = created.session && created.session.id
    if (!sessionId) throw new Error('No session id returned')

    let done = 0
    for (const s of seqd) {
      const fd = new FormData()
      fd.append('session_id', sessionId)
      fd.append('track', s.track)
      fd.append('seq', String(s.seq))
      fd.append('file', s.blob, `${s.track}-${s.seq}.webm`)
      await callFn('forgenotes-upload-file', { formData: fd })
      done += 1
      setStatus(`Uploading… ${done}/${seqd.length}`, 'busy')
    }

    await callFn('forgenotes-finalize-session', {
      body: { session_id: sessionId, duration_seconds: meta.durationSec || 0 },
    })

    await window.desktop.deleteRecording(localId)
    await refreshPending()

    const url = `${CFG.forgenotesHost}/notes/m/${sessionId}`
    setStatus('Uploaded. ForgeNotes is transcribing it now.', 'ok')
    const link = $('open-link')
    link.classList.remove('hidden')
    link.onclick = (e) => {
      e.preventDefault()
      window.desktop.openExternal(url)
    }
    $('title').value = ''
  } catch (e) {
    setStatus(`Upload failed — saved on this device, retry below. (${e.message})`, 'error')
    await refreshPending()
  }
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
    const segCount = (item.meta.segments || []).length
    sub.textContent = `${when} · ${tracks} · ${item.meta.durationSec || 0}s${segCount ? ` · ${segCount} parts` : ''}`
    meta.appendChild(title)
    meta.appendChild(sub)

    const actions = document.createElement('div')
    actions.className = 'actions'
    const retry = document.createElement('button')
    retry.className = 'btn primary'
    retry.textContent = 'Retry'
    retry.onclick = () => retryPending(item.localId, retry)
    const discard = document.createElement('button')
    discard.className = 'btn ghost'
    discard.textContent = 'Discard'
    discard.onclick = () => discardPending(item.localId)
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
  btn.disabled = true
  btn.textContent = 'Uploading…'
  try {
    const { meta, segments } = await window.desktop.readRecording(localId)
    const seqd = (segments || []).map((s) => ({
      track: s.track,
      seq: s.seq,
      blob: new Blob([s.data], { type: 'audio/webm' }),
    }))
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

  $('signout-btn').onclick = signOut
  $('start-btn').onclick = startRecording
  $('pause-btn').onclick = togglePause
  $('stop-btn').onclick = stopRecording

  // Guard against losing an in-progress recording on accidental close.
  window.addEventListener('beforeunload', (e) => {
    if (rec) {
      e.preventDefault()
      e.returnValue = ''
    }
  })
}

boot()
