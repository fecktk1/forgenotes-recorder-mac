// Which part of the window is showing. Shared by the macOS and Windows apps: keep the two
// copies identical. app.js owns recording, uploads and every control's behaviour, and
// addresses controls by id; this file only decides where they are shown:
//   - the three views (Record, Recordings, Settings) and the tabs between them;
//   - the Record view's two faces, before and during a recording;
//   - the Details opener and its one-line summary;
//   - the device check folded to one line while everything is fine.
// It reads what app.js has already put on the page and never changes a recording.
'use strict'

;(() => {
  const el = (id) => document.getElementById(id)
  const body = document.body
  const watch = (node, options, fn) => { if (node) new MutationObserver(fn).observe(node, options) }
  const CLASS = { attributes: true, attributeFilter: ['class'] }

  // ---------------------------------------------------------------- views
  let lastTab = 'record'
  function setView(view) {
    if (view !== 'settings') lastTab = view
    body.dataset.view = view
  }
  el('tab-record').onclick = () => setView('record')
  el('tab-recordings').onclick = () => setView('recordings')
  el('settings-open').onclick = () => setView('settings')
  el('settings-close').onclick = () => setView(lastTab)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && body.dataset.view === 'settings' && !e.defaultPrevented) setView(lastTab)
  })

  // ---------------------------------------------------------------- signed in, recording
  const recorder = el('recorder-view')
  const startBtn = el('start-btn')
  function syncState() {
    const signed = !recorder.classList.contains('hidden')
    const recording = signed && startBtn.classList.contains('hidden')
    const began = recording && !body.classList.contains('is-recording')
    body.classList.toggle('is-signed', signed)
    body.classList.toggle('is-recording', recording)
    if (began) {
      // What is being recorded, in place of the fields that can no longer change it.
      const mic = el('mic')
      const micName = mic && mic.selectedOptions[0] ? mic.selectedOptions[0].textContent : ''
      const mode = el('mode-room').classList.contains('active') ? 'In person' : 'Online call'
      el('now-title').textContent = el('title').value.trim() || 'Untitled meeting'
      el('now-sub').textContent = micName ? `${mode} · ${micName}` : mode
      setView('record')
    }
  }
  watch(recorder, CLASS, syncState)
  watch(startBtn, CLASS, syncState)
  // Signing out (or choosing to sign in from a local session) leads to the sign-in form.
  watch(el('login-view'), CLASS, () => {
    if (!el('login-view').classList.contains('hidden') && body.dataset.view === 'settings') setView('record')
  })

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
    const icon = el('pf-sum-ic')
    icon.className = `pf-ic ${state}`
    icon.textContent = { checking: '…', ok: '✓', warn: '!', fail: '✕' }[state]
    el('pf-sum-key').textContent = key
    el('pf-sum-text').textContent = text
    // A problem is always spelled out; a clean check stays on one line unless asked for.
    const open = Boolean(problem) || pfPinnedOpen
    preflight.classList.toggle('open', open)
    pfToggle.setAttribute('aria-expanded', String(open))
  }
  pfToggle.onclick = () => { pfPinnedOpen = !preflight.classList.contains('open'); renderPreflight() }
  watch(results, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'], characterData: true }, renderPreflight)

  // ---------------------------------------------------------------- update ready
  // The version sits in Settings; a downloaded update is also said where it will be seen.
  const version = el('app-version')
  function renderUpdateFlag() {
    const ready = version.classList.contains('brand-ver-update')
    el('update-flag').classList.toggle('hidden', !ready)
    el('update-flag').title = version.title || ''
  }
  watch(version, CLASS, renderUpdateFlag)

  syncState()
  renderDetailsSummary()
  renderPreflight()
  renderUpdateFlag()
})()
