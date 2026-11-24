// What the main window is showing, and what the other surfaces are told. Shared by the
// macOS and Windows apps: keep the two copies identical.
//
// app.js owns recording, uploads and every control's behaviour, and addresses controls by
// id. This file never changes a recording. It only:
//   - decides which pane is showing (a new recording, a saved one, Settings) and, in a
//     narrow window, whether the list or the pane has the room;
//   - gives the Record pane its two faces, before and during a recording, with the level
//     history drawn as a waveform;
//   - folds Details and the device check to one line each;
//   - reports the recorder's state to main (for the menu bar / tray popover and the
//     floating bar) and presses the page's own buttons when one of them asks.
// It reads what app.js has already put on the page.
'use strict'

;(() => {
  const el = (id) => document.getElementById(id)
  const body = document.body
  const root = document.documentElement
  const watch = (node, options, fn) => { if (node) new MutationObserver(fn).observe(node, options) }
  const CLASS = { attributes: true, attributeFilter: ['class'] }
  const TEXT = { childList: true, characterData: true, subtree: true }
  const shown = (node) => Boolean(node) && !node.classList.contains('hidden')

  root.classList.add(/Mac/i.test(navigator.platform) ? 'mac' : 'win')
  // main asked the system for its glass behind this window (shell.js): leave it unpainted.
  if (new URLSearchParams(location.search).get('glass') === '1') root.classList.add('glass')

  // ---------------------------------------------------------------- views
  // record | recordings (the list, narrow windows only) | detail | settings
  let returnTo = 'record'
  function setView(view, title) {
    if (view !== 'settings') returnTo = view
    body.dataset.view = view
    el('new-rec').classList.toggle('sel', view === 'record' || view === 'recordings')
    el('settings-open').classList.toggle('sel', view === 'settings')
    if (view !== 'detail') for (const row of el('pending-list').querySelectorAll('.row')) row.classList.remove('sel')
    publish()
  }
  el('tab-record').onclick = () => setView('record')
  el('tab-recordings').onclick = () => setView('recordings')
  el('new-rec').onclick = () => setView('record')
  el('settings-open').onclick = () => setView(body.dataset.view === 'settings' ? returnTo : 'settings')
  el('pane-back').onclick = () => setView(body.dataset.view === 'detail' ? 'recordings' : returnTo)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && body.dataset.view === 'settings' && !e.defaultPrevented) setView(returnTo)
  })

  // ---------------------------------------------------------------- signed in, recording
  const recorder = el('recorder-view')
  const startBtn = el('start-btn')
  const pauseBtn = el('pause-btn')
  const modeText = () => (el('mode-room').classList.contains('active') ? 'In person' : 'Online call')
  const micText = () => { const m = el('mic'); return m && m.selectedOptions[0] ? m.selectedOptions[0].textContent.trim() : '' }
  function syncState() {
    const signed = shown(recorder)
    const recording = signed && !shown(startBtn)
    const paused = recording && pauseBtn.textContent.trim() === 'Resume'
    const began = recording && !body.classList.contains('is-recording')
    body.classList.toggle('is-signed', signed)
    body.classList.toggle('is-recording', recording)
    body.classList.toggle('is-paused', paused)
    if (began) {
      // What is being recorded, in place of the fields that can no longer change it.
      el('now-title').textContent = el('title').value.trim() || 'Untitled meeting'
      el('now-sub').textContent = micText() ? `${modeText()} · ${micText()}` : modeText()
      resetWave()
      setView('record')
    }
    // The row at the top of the list is the recording while one runs.
    el('new-rec-title').textContent = recording ? el('now-title').textContent : 'New Recording'
    el('new-rec-sub').textContent = recording ? (paused ? `Paused at ${el('rec-timer').textContent}` : el('rec-timer').textContent) : ''
    el('new-rec-sub').classList.toggle('hidden', !recording)
    el('foot-timer').textContent = el('rec-timer').textContent
    publish()
  }
  watch(recorder, CLASS, syncState)
  watch(startBtn, CLASS, syncState)
  watch(pauseBtn, TEXT, syncState)
  watch(el('rec-timer'), TEXT, syncState)
  for (const id of ['mode-online', 'mode-room']) watch(el(id), CLASS, syncState)
  // Signing out (or choosing to sign in from a local session) leads to the sign-in form.
  watch(el('login-view'), CLASS, () => { if (shown(el('login-view')) && body.dataset.view === 'settings') setView('record') })

  // ---------------------------------------------------------------- level history
  // The last minute or so of the louder of the two meters, one bar every 150 ms.
  const wave = el('wave')
  const BARS = 72
  let history = []
  function resetWave() {
    history = []
    wave.replaceChildren(...Array.from({ length: BARS }, () => document.createElement('i')))
  }
  const level = (id) => { const m = el(id); return m ? Math.max(0, Math.min(100, parseFloat(m.style.width) || 0)) : 0 }
  resetWave()
  setInterval(() => {
    if (!body.classList.contains('is-recording') || body.classList.contains('is-paused')) return
    history.push(Math.max(level('meter-mic'), level('meter-system')))
    if (history.length > BARS) history.shift()
    const bars = wave.children
    const offset = BARS - history.length
    for (let i = 0; i < history.length; i++) bars[offset + i].style.height = `${Math.max(3, Math.min(100, history[i] * 1.6))}%`
    publish()
  }, 150)

  // ---------------------------------------------------------------- devices
  // The app follows the computer. Plug in a headset, pick other speakers or change the
  // system's input, and the microphone list, the level and the device check catch up by
  // themselves; a microphone the person picked here stays picked while it is still there.
  // Never while recording: app.js looks after the devices of a running recording.
  const micSelect = el('mic')
  function nameDefaults() {
    // Chromium calls the system's own choice "Default - <name>". Say what it means.
    for (const option of micSelect.options) {
      const match = /^default\s+-\s+(.*)$/i.exec(option.textContent)
      if (match) option.textContent = `System default (${match[1]})`
    }
    const output = el('output-name')
    if (output && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then((devices) => {
        const out = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default') || devices.find((d) => d.kind === 'audiooutput')
        const name = out && out.label ? out.label.replace(/^default\s+-\s+/i, '') : ''
        output.textContent = name ? `Records what plays through ${name}.` : 'Records what plays through your speakers or headphones.'
      }).catch(() => {})
    }
  }
  watch(micSelect, { childList: true }, nameDefaults)
  let devicesTimer = null
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      clearTimeout(devicesTimer)
      devicesTimer = setTimeout(async () => {
        nameDefaults()
        if (body.classList.contains('is-recording') || !body.classList.contains('is-signed')) return
        if (typeof window.populateMics !== 'function') return
        const chosen = micSelect.value
        try {
          await window.populateMics()
          if (chosen && chosen !== 'default' && [...micSelect.options].some((o) => o.value === chosen)) micSelect.value = chosen
          if (typeof window.runPreflight === 'function') window.runPreflight()
        } catch {
          // the next change, or opening the window, tries again
        }
        publish()
      }, 500)
    })
  }

  // ---------------------------------------------------------------- details
  const details = el('details')
  const detailsToggle = el('details-toggle')
  const chosen = (id) => { const s = el(id); return s && s.selectedOptions[0] ? s.selectedOptions[0].textContent.trim() : '' }
  function renderDetailsSummary() {
    const open = details.classList.contains('open')
    const tags = el('tags') && el('tags').value.trim() ? 'Tagged' : ''
    el('details-summary').textContent = open ? '' : [chosen('template'), chosen('source'), chosen('visibility'), tags].filter(Boolean).join(' · ')
  }
  detailsToggle.onclick = () => {
    const open = details.classList.toggle('open')
    detailsToggle.setAttribute('aria-expanded', String(open))
    renderDetailsSummary()
  }
  for (const id of ['template', 'source', 'visibility', 'tags']) {
    if (el(id)) el(id).addEventListener('change', renderDetailsSummary)
  }
  // app.js moves Source itself when the setup changes (Online call / In person).
  for (const id of ['mode-online', 'mode-room']) el(id).addEventListener('click', () => setTimeout(renderDetailsSummary, 0))

  // ---------------------------------------------------------------- device check
  const preflight = el('preflight')
  const results = el('preflight-results')
  const pfToggle = el('pf-toggle')
  let pfPinnedOpen = false // the person opened the list themself
  let deviceState = 'checking'
  function renderPreflight() {
    const rows = [...results.querySelectorAll('.pf-row')]
    const has = (state) => rows.find((r) => r.classList.contains(state))
    const label = (row) => row.querySelector('.pf-label').textContent
    const problem = has('fail') || has('warn')
    let state = 'checking'; let key = 'Checking'; let text = ''
    if (problem) {
      state = problem.classList.contains('fail') ? 'fail' : 'warn'
      key = state === 'fail' ? 'Needs attention' : 'Check this'
      text = label(problem)
    } else if (rows.length && !has('checking')) {
      state = 'ok'
      key = 'Ready'
      const system = el('pf-system') || el('pf-output') // macOS, Windows
      const callAudio = system && system.classList.contains('ok') && !el('mode-room').classList.contains('active')
      text = callAudio ? 'Microphone and call audio are working' : 'Microphone is working'
    }
    deviceState = state
    const icon = el('pf-sum-ic')
    icon.className = `pf-ic ${state}`
    icon.textContent = { checking: '…', ok: '✓', warn: '!', fail: '✕' }[state]
    el('pf-sum-key').textContent = key
    el('pf-sum-text').textContent = text
    // A problem is always spelled out; a clean check stays on one line unless asked for.
    const open = Boolean(problem) || pfPinnedOpen
    preflight.classList.toggle('open', open)
    preflight.classList.toggle('pinned', pfPinnedOpen)
    pfToggle.setAttribute('aria-expanded', String(open))
    publish()
  }
  pfToggle.onclick = () => { pfPinnedOpen = !preflight.classList.contains('open'); renderPreflight() }
  watch(results, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'], characterData: true }, renderPreflight)

  // ---------------------------------------------------------------- updates
  // A downloaded update is said where it will be seen, and Settings can ask for a check.
  const version = el('app-version')
  function renderUpdateFlag() {
    if (version.classList.contains('brand-ver-update')) el('update-status').textContent = 'An update is ready. It installs when you quit.'
  }
  watch(version, CLASS, renderUpdateFlag)
  const updateCheck = el('update-check')
  if (updateCheck) {
    updateCheck.onclick = async () => {
      updateCheck.disabled = true
      el('update-status').textContent = 'Checking…'
      try {
        const answer = await window.desktop.checkForUpdates({ quiet: true })
        el('update-status').textContent = (answer && answer.message) || 'Updates install when you quit.'
      } catch {
        el('update-status').textContent = 'Could not check for updates. Try again later.'
      } finally {
        updateCheck.disabled = false
      }
    }
  }

  // ---------------------------------------------------------------- the other surfaces
  // One snapshot of the recorder, sent to main whenever it changes (at most every 120 ms).
  // The popover and the floating bar draw it; neither can touch a recording directly.
  let lastSent = ''
  let publishTimer = null
  function snapshot() {
    const recording = body.classList.contains('is-recording')
    const question = el('silence-question')
    const status = el('status')
    const captions = el('live-panel')
    const cap = el('cap-system')
    return {
      signedIn: body.classList.contains('is-signed'),
      recording,
      paused: body.classList.contains('is-paused'),
      timer: el('rec-timer').textContent,
      title: recording ? el('now-title').textContent : el('title').value.trim(),
      mode: el('mode-room').classList.contains('active') ? 'room' : 'online',
      mic: micText(),
      device: deviceState,
      levels: { mic: Math.round(level('meter-mic')), system: shown(el('meter-system-row')) ? Math.round(level('meter-system')) : null },
      callAudio: recording && cap ? { text: cap.textContent, bad: cap.classList.contains('bad') } : null,
      captions: captions ? { on: shown(captions), text: (el('live-text').textContent || '').slice(-280) } : null,
      question: shown(question) ? el('silence-question-text').textContent : '',
      status: shown(status) ? { text: status.textContent.slice(0, 200), kind: (status.className.match(/\b(error|warn|ok|busy)\b/) || ['busy'])[0] } : null,
      recent: [...el('pending-list').querySelectorAll('li[data-local-id]')].slice(0, 3).map((li) => ({
        id: li.dataset.localId,
        title: li.querySelector('.t').textContent,
        facts: li.querySelector('.m').textContent,
      })),
    }
  }
  function publish() {
    if (publishTimer || !window.desktop || !window.desktop.publishShellState) return
    publishTimer = setTimeout(() => {
      publishTimer = null
      const state = snapshot()
      const text = JSON.stringify(state)
      if (text === lastSent) return
      lastSent = text
      window.desktop.publishShellState(state)
    }, 120)
  }
  for (const id of ['status', 'silence-question', 'live-panel', 'cap-system']) watch(el(id), { ...CLASS, ...TEXT }, publish)
  watch(el('live-text'), TEXT, publish)
  el('title').addEventListener('input', publish)
  el('mic').addEventListener('change', publish)

  // A surface asked for something: press the page's own control, exactly as a person would.
  const press = (id) => { const b = el(id); if (b && shown(b) && !b.disabled) b.click() }
  if (window.desktop && window.desktop.onShellCommand) {
    window.desktop.onShellCommand((command) => {
      const type = command && command.type
      if (type === 'start') { if (!body.classList.contains('is-recording')) press('start-btn') }
      else if (type === 'stop') press('stop-btn')
      else if (type === 'pause') press('pause-btn')
      else if (type === 'mode') press(command.mode === 'room' ? 'mode-room' : 'mode-online')
      else if (type === 'keep') press('silence-keep')
      else if (type === 'captions') press('live-toggle')
      else if (type === 'title' && !body.classList.contains('is-recording')) { el('title').value = String(command.title || '').slice(0, 200); publish() }
      else if (type === 'settings') setView('settings')
      else if (type === 'recordings') setView(window.innerWidth < 620 ? 'recordings' : body.dataset.view === 'settings' ? 'record' : body.dataset.view)
      else if (type === 'open' && typeof command.id === 'string') { const li = [...el('pending-list').querySelectorAll('li[data-local-id]')].find((x) => x.dataset.localId === command.id); if (li) li.firstElementChild.click() }
      else if (type === 'sync') { lastSent = ''; publish() }
    })
  }

  // ---------------------------------------------------------------- for app.js
  window.fnLayout = {
    showDetail: (title) => setView('detail', title),
    closeDetail: () => { if (body.dataset.view === 'detail') setView(window.innerWidth < 620 ? 'recordings' : 'record') },
    changed: publish,
  }

  syncState()
  renderDetailsSummary()
  renderPreflight()
  renderUpdateFlag()
  nameDefaults()
  setView('record')
})()
