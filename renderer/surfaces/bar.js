// The floating bar. Shared by the macOS and Windows apps: keep the two copies identical.
// Draws the recorder's state (shell.js sends it) and asks for actions; nothing else.
'use strict'

;(() => {
  const el = (id) => document.getElementById(id)
  const api = window.surface
  document.documentElement.classList.add(api.platform === 'darwin' ? 'mac' : 'win')
  if (new URLSearchParams(location.search).get('glass') === '1') document.documentElement.classList.add('glass')
  const bars = [...el('glyph').children]
  const history = [0, 0, 0, 0, 0]
  let showCaptions = false

  function render(state) {
    if (!state) return
    el('bar').classList.toggle('paused', Boolean(state.paused))
    el('timer').textContent = state.timer
    el('name').textContent = state.paused ? 'Paused' : state.title || ''
    el('pause').textContent = state.paused ? 'Resume' : 'Pause'
    const loud = state.paused ? 0 : Math.max((state.levels && state.levels.mic) || 0, (state.levels && state.levels.system) || 0)
    history.push(loud); history.shift()
    bars.forEach((bar, i) => { bar.style.height = `${Math.max(3, Math.min(16, history[i] / 4))}px` })

    const captions = state.captions
    const hasCaptions = Boolean(captions && captions.on)
    el('captions').classList.toggle('hidden', !hasCaptions)
    el('captions').classList.toggle('on', showCaptions)

    // One thing under the bar at a time: a question first, then a warning, then captions.
    const drawer = el('drawer')
    drawer.replaceChildren()
    if (state.question) {
      drawer.append(state.question)
      const keep = document.createElement('button')
      keep.type = 'button'; keep.className = 'b gold'; keep.textContent = 'Keep recording'
      keep.onclick = () => api.command({ type: 'keep' })
      drawer.append(document.createElement('br'), keep)
    } else if (state.callAudio && state.callAudio.bad) {
      drawer.append(state.callAudio.text)
    } else if (hasCaptions && showCaptions) {
      const label = document.createElement('span'); label.className = 'cap'; label.textContent = 'Live captions, on this computer'
      drawer.append(label, captions.text || 'Listening…')
    }
    drawer.classList.toggle('hidden', !drawer.childNodes.length)
  }

  let last = null
  const fit = () => api.size(Math.ceil(document.body.getBoundingClientRect().height))
  const draw = (state) => { if (state) { last = state; render(state); fit() } }
  el('captions').onclick = () => { showCaptions = !showCaptions; draw(last) }
  el('pause').onclick = () => api.command({ type: 'pause' })
  el('stop').onclick = () => api.command({ type: 'stop' })
  el('bar').addEventListener('dblclick', () => api.command({ type: 'recordings' }))

  new ResizeObserver(fit).observe(document.body)
  api.onState(draw)
  api.ready().then(draw)
})()
