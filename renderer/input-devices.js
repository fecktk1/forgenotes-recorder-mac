// Which physical input a microphone or call-audio selection opens.
//
// Chromium lists a "default" entry first ("Default - <name>", the input macOS is set to)
// next to the real devices, so two different ids can open the same input. When the
// microphone and the call-audio source are the same input, both tracks record the same
// samples: the server gets two byte-identical copies of the meeting, transcribes it twice
// (once as "You", once as the other side) and your own voice is not recorded at all. That
// is what happens when macOS's input is set to BlackHole 2ch: the Microphone list starts on
// "Default - BlackHole 2ch" and the call-audio list auto-selects "BlackHole 2ch".
//
// This file only answers "is it the same input?" and "which microphone should be
// preselected instead?". app.js decides what to do about it. A plain script: index.html
// loads it before app.js (window.FnInputDevices) and the node tests require it.
'use strict'
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.FnInputDevices = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Chromium's pseudo-devices. An empty id means "no deviceId constraint", which opens
  // the default input too.
  const PSEUDO_IDS = new Set(['default', 'communications'])
  const PSEUDO_LABEL = /^(default|communications)\s+-\s+/i
  // Inputs that carry what the computer plays, never somebody's voice on a microphone.
  const LOOPBACK_LABEL = /blackhole|soundflower|loopback|virtual|zoomaudiodevice/i

  function normalizeId(id) {
    return String(id || '') || 'default'
  }

  function isPseudo(id) {
    return PSEUDO_IDS.has(normalizeId(id))
  }

  // "Default - BlackHole 2ch" -> "BlackHole 2ch".
  function baseLabel(label) {
    return String(label || '').replace(PSEUDO_LABEL, '').trim()
  }

  function audioInputs(inputs) {
    return (Array.isArray(inputs) ? inputs : []).filter((d) => d && (d.kind || 'audioinput') === 'audioinput')
  }

  function only(list) {
    return list.length === 1 ? list[0] : null
  }

  // The real (non-pseudo) input an id opens, or null when the list cannot tell. A pseudo
  // entry is matched to the real device with the same group and the same name; failing
  // that, to the only real device with that name, or the only one in that group. Never a
  // guess between two candidates: an unknown answer must not read as "the same input".
  function resolveInput(id, inputs) {
    const list = audioInputs(inputs)
    const want = normalizeId(id)
    const real = list.filter((d) => !isPseudo(d.deviceId))
    if (!isPseudo(want)) return real.find((d) => d.deviceId === want) || null
    const entry = list.find((d) => d.deviceId === want)
    if (!entry) return null
    const name = baseLabel(entry.label)
    const sameGroup = entry.groupId ? real.filter((d) => d.groupId === entry.groupId) : []
    const named = name ? real.filter((d) => baseLabel(d.label) === name) : []
    return only(sameGroup.filter((d) => named.includes(d))) || only(named) || only(sameGroup)
  }

  // True when a microphone id and a call-audio id open the same input. Equal ids always
  // do; otherwise both have to resolve, to the same device. No call-audio id = no source.
  function sameInput(micId, systemId, inputs) {
    if (!systemId) return false
    const a = normalizeId(micId)
    const b = normalizeId(systemId)
    if (a === b) return true
    const ra = resolveInput(a, inputs)
    const rb = resolveInput(b, inputs)
    return Boolean(ra && rb && ra.deviceId === rb.deviceId)
  }

  function trackInfo(track) {
    let settings = {}
    try {
      settings = (track && typeof track.getSettings === 'function' && track.getSettings()) || {}
    } catch {
      settings = {}
    }
    return { deviceId: settings.deviceId || '', groupId: settings.groupId || '', label: (track && track.label) || '' }
  }

  // The same question for two tracks that are already open, from what Chromium reports
  // about them. A device missing from the list (plugged in after it was read) still counts
  // as the same input when both tracks report its group and its name.
  function sameOpenedInput(micTrack, systemTrack, inputs) {
    if (!micTrack || !systemTrack) return false
    const a = trackInfo(micTrack)
    const b = trackInfo(systemTrack)
    if (a.deviceId && b.deviceId && sameInput(a.deviceId, b.deviceId, inputs)) return true
    const name = baseLabel(a.label)
    return Boolean(a.groupId && a.groupId === b.groupId && name && name === baseLabel(b.label))
  }

  // The name to show for an input in a message.
  function inputName(id, inputs) {
    const real = resolveInput(id, inputs)
    if (real) return baseLabel(real.label) || 'the selected input'
    const entry = audioInputs(inputs).find((d) => d.deviceId === normalizeId(id))
    return (entry && baseLabel(entry.label)) || 'the selected input'
  }

  // The microphone to preselect. Unchanged unless it would open the call-audio input; then
  // the first input that is neither that input nor a loopback driver. With no such input
  // it stays as it is, and the device check and Start say what is wrong.
  function distinctMicId(inputs, systemId, currentId) {
    if (!sameInput(currentId, systemId, inputs)) return currentId
    const pick = audioInputs(inputs).find((d) =>
      !isPseudo(d.deviceId) && !LOOPBACK_LABEL.test(d.label || '') && !sameInput(d.deviceId, systemId, inputs))
    return pick ? pick.deviceId : currentId
  }

  return { isPseudo, baseLabel, resolveInput, sameInput, sameOpenedInput, inputName, distinctMicId }
})
