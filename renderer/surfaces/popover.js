// The popover. Shared by the macOS and Windows apps: keep the two copies identical.
// Draws the recorder's state (shell.js sends it) and asks for actions; nothing else.
'use strict'

;(() => {
  const el = (id) => document.getElementById(id)
  const api = window.surface
  document.documentElement.classList.add(api.platform === 'darwin' ? 'mac' : 'win')
  if (new URLSearchParams(location.search).get('glass') === '1') document.documentElement.classList.add('glass')
  const show = (id, on) => el(id).classList.toggle('hidden', !on)
  let state = null

  function render(next) {
    if (!next) return
    state = next
    const recording = Boolean(state.recording)
    show('ready', !recording)
    show('live', recording)
    if (recording) {
      el('title').textContent = state.title || 'Untitled meeting'
      el('timer').textContent = state.timer
      el('mode-text').textContent = state.mode === 'room' ? 'In person' : 'Online call'
      el('state-text').textContent = state.paused ? 'Paused' : 'Saved every minute'
      el('lv-mic').style.width = `${Math.min(100, (state.levels && state.levels.mic) || 0)}%`
      const system = state.levels && state.levels.system
      show('sys-block', system !== null && system !== undefined)
      el('lv-sys').style.width = `${Math.min(100, system || 0)}%`
      const call = state.callAudio
      el('lv-sys-label').textContent = call && call.bad ? call.text : 'Call audio'
      el('lv-sys-label').classList.toggle('bad', Boolean(call && call.bad))
      show('question', Boolean(state.question))
      el('question-text').textContent = state.question || ''
      el('pause').textContent = state.paused ? 'Resume' : 'Pause'
    } else {
      const name = el('name')
      if (document.activeElement !== name) name.value = state.title || ''
      el('go-label').textContent = state.signedIn ? 'Record' : 'Open ForgeNotes to begin'
      el('go-sub').textContent = state.signedIn
        ? (state.device === 'fail' || state.device === 'warn' ? 'Check your devices in ForgeNotes' : state.mic || '')
        : 'Sign in, or record without an account'
      el('go').disabled = false
      el('mode-online').classList.toggle('on', state.mode !== 'room')
      el('mode-room').classList.toggle('on', state.mode === 'room')
      const recent = el('recent')
      recent.replaceChildren()
      for (const item of state.recent || []) {
        const row = document.createElement('button')
        row.type = 'button'
        const name = document.createElement('span'); name.className = 'n one'; name.textContent = item.title
        const facts = document.createElement('span'); facts.className = 'm'; facts.textContent = String(item.facts || '').split(' · ').slice(0, 2).join(' · ')
        row.append(name, facts)
        row.onclick = () => api.command({ type: 'open', id: item.id })
        recent.appendChild(row)
      }
      show('recent-block', (state.recent || []).length > 0)
    }
  }

  el('go').onclick = () => {
    if (!state || !state.signedIn) { api.command({ type: 'recordings' }); return }
    api.command({ type: 'title', title: el('name').value })
    api.command({ type: 'start' })
  }
  el('name').addEventListener('input', () => api.command({ type: 'title', title: el('name').value }))
  el('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('go').click() })
  el('mode-online').onclick = () => api.command({ type: 'mode', mode: 'online' })
  el('mode-room').onclick = () => api.command({ type: 'mode', mode: 'room' })
  el('all').onclick = () => api.command({ type: 'recordings' })
  el('settings').onclick = () => api.command({ type: 'settings' })
  el('pause').onclick = () => api.command({ type: 'pause' })
  el('stop').onclick = () => api.command({ type: 'stop' })
  el('keep').onclick = () => api.command({ type: 'keep' })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.command({ type: 'hide' }) })

  // The window is as tall as the page: told whenever the page changes, and again after each
  // state is drawn (a hidden window is not always told that its page resized).
  const fit = () => api.size(Math.ceil(document.body.getBoundingClientRect().height))
  new ResizeObserver(fit).observe(document.body)
  const draw = (state) => { render(state); fit() }
  api.onState(draw)
  api.ready().then(draw)
  window.addEventListener('focus', fit)
})()
