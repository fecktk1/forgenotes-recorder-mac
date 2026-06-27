// ForgeNotes Recorder — renderer. Captures mic + system audio as separate tracks,
// then drives the SAME create-session -> upload-file -> finalize-session flow the
// web app uses. Recordings are always saved locally first, so a failed upload is
// retryable and never lost.
'use strict'

const $ = (id) => document.getElementById(id)
const show = (id) => $(id).classList.remove('hidden')
const hide = (id) => $(id).classList.add('hidden')

let CFG = null
let auth = null // { access_token, refresh_token, expires_at(ms), email }
let rec = null // active recording state

// ---------------------------------------------------------------- boot
async function boot() {
  CFG = await window.desktop.getConfig()
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
  const mkRecorder = (stream, bucket) => {
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    r.ondataavailable = (e) => {
      if (e.data && e.data.size) bucket.push(e.data)
    }
    r.start(1000)
    return r
  }

  const micChunks = []
  const systemChunks = []
  const micRecorder = mkRecorder(micStream, micChunks)
  const systemRecorder = systemStream ? mkRecorder(systemStream, systemChunks) : null

  rec = {
    micRecorder,
    systemRecorder,
    micStream,
    systemStream,
    micChunks,
    systemChunks,
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
    timer: null,
  }

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
  if (!rec.paused) {
    rec.micRecorder.pause()
    if (rec.systemRecorder) rec.systemRecorder.pause()
    rec.paused = true
    rec.pauseStart = Date.now()
    $('pause-btn').textContent = 'Resume'
    $('rec-indicator').classList.add('hidden')
  } else {
    rec.micRecorder.resume()
    if (rec.systemRecorder) rec.systemRecorder.resume()
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

function stopRecorder(recorder, chunks, mime) {
  return new Promise((resolve) => {
    if (!recorder) {
      resolve(null)
      return
    }
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }))
    if (recorder.state !== 'inactive') recorder.stop()
    else resolve(new Blob(chunks, { type: mime }))
  })
}

async function stopRecording() {
  if (!rec) return
  const current = rec
  rec = null
  clearInterval(current.timer)
  if (current.meters) current.meters.stop()
  hide('meters')
  hide('rec-indicator')
  $('pause-btn').classList.add('hidden')
  $('stop-btn').classList.add('hidden')
  $('pause-btn').textContent = 'Pause'

  const durationSec = Math.max(1, Math.round((Date.now() - current.startedAt - current.pausedMs) / 1000))
  const micBlob = await stopRecorder(current.micRecorder, current.micChunks, current.mime)
  const systemBlob = await stopRecorder(current.systemRecorder, current.systemChunks, current.mime)
  current.micStream.getTracks().forEach((t) => t.stop())
  if (current.systemStream) current.systemStream.getTracks().forEach((t) => t.stop())

  const trackBlobs = []
  if (micBlob && micBlob.size) trackBlobs.push({ track: 'mic', blob: micBlob })
  if (systemBlob && systemBlob.size) trackBlobs.push({ track: 'system', blob: systemBlob })

  if (!trackBlobs.length) {
    setStatus('Nothing was recorded.', 'error')
    resetControls()
    return
  }

  const localId = `rec_${current.startedAt}`
  const meta = {
    ...current.meta,
    durationSec,
    createdAt: new Date().toISOString(),
    tracks: trackBlobs.map((t) => t.track),
    uploaded: false,
  }

  // Always persist locally BEFORE attempting upload (offline-safe).
  try {
    const ipcTracks = await Promise.all(
      trackBlobs.map(async (t) => ({ track: t.track, data: await t.blob.arrayBuffer() })),
    )
    await window.desktop.saveRecording(localId, meta, ipcTracks)
    await refreshPending()
  } catch (e) {
    setStatus(`Could not save the recording locally: ${e.message}`, 'error')
    resetControls()
    return
  }

  resetControls()
  await uploadFromBlobs(localId, meta, trackBlobs)
}

function resetControls() {
  $('start-btn').classList.remove('hidden')
  $('signout-btn').disabled = false
}

// ---------------------------------------------------------------- upload
async function uploadFromBlobs(localId, meta, trackBlobs) {
  setStatus('Uploading to ForgeNotes…', 'busy')
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

    for (const t of trackBlobs) {
      const fd = new FormData()
      fd.append('session_id', sessionId)
      fd.append('track', t.track)
      fd.append('seq', '0')
      fd.append('file', t.blob, `${t.track}.webm`)
      await callFn('forgenotes-upload-file', { formData: fd })
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
    sub.textContent = `${when} · ${tracks} · ${item.meta.durationSec || 0}s`
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
    const { meta, tracks } = await window.desktop.readRecording(localId)
    const trackBlobs = tracks.map((t) => ({
      track: t.track,
      blob: new Blob([t.data], { type: 'audio/webm' }),
    }))
    if (!trackBlobs.length) throw new Error('No audio on disk')
    await uploadFromBlobs(localId, meta, trackBlobs)
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
