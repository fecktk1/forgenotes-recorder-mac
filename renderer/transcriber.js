// Live captions for the desktop recorder — Whisper running entirely on this machine.
//
// The same posture as the iPhone's live preview, arrived at differently: iOS has an OS
// recognizer, so here Whisper (base.en, ONNX) runs in-process on WebGPU via transformers.js.
// The properties that matter are identical:
//
//   * ON-DEVICE. Audio never leaves the machine for captioning. The one network touch is
//     downloading the model itself (~80 MB from huggingface.co, once, cached after) — bytes
//     in, never audio out. The privacy page's claims survive unchanged.
//   * PREVIEW-ONLY. Nothing here is stored or uploaded; the server transcript, produced
//     after upload, stays authoritative.
//   * UNABLE TO HURT THE RECORDING. This module taps a merged copy of the streams through
//     its own AudioContext. Every failure — no WebGPU, download refused, inference dying —
//     degrades to "no captions", never to "no audio".
//
// Chunked rather than truly streaming: buffered PCM is transcribed every few seconds, each
// chunk independently. Word boundaries at chunk edges can clip; for glanceable reassurance
// that the meeting is being heard, that is the right trade. On machines without WebGPU the
// feature reports itself unsupported and stays out of the way — WASM-only inference cannot
// keep up with real time, and captions that lag a minute behind are worse than none.
//
// Talks to the classic-script app via window.fnLive (control) and 'fn-live' CustomEvents
// (state/text/progress out). app.js stays free of module machinery.

import { pipeline, env } from '../node_modules/@huggingface/transformers/dist/transformers.min.js'

// Models come from the HF hub and cache in the profile's Cache Storage; nothing is bundled.
env.allowLocalModels = false

const MODEL_ID = 'onnx-community/whisper-base.en'
/// Transcribe whatever has buffered every this-many ms. If inference is still running when
/// the tick fires, the buffer simply keeps growing and the next run takes a bigger bite —
/// self-pacing on slower GPUs.
const STRIDE_MS = 5_000
/// Whisper's window is 30 s. Older buffered audio beyond this is dropped with a marker —
/// falling progressively further behind live is the one thing captions must never do.
const MAX_CHUNK_SECONDS = 28
const SAMPLE_RATE = 16_000
/// Keep roughly what the iOS preview keeps.
const MAX_TEXT_CHARS = 12_000

const state = {
  asr: null,
  loading: null,
  ctx: null,
  sources: [],
  workletNode: null,
  buffered: [],
  bufferedSamples: 0,
  timer: null,
  paused: false,
  running: false,
  transcribing: false,
  text: '',
  failures: 0,
}

function emit(detail) {
  window.dispatchEvent(new CustomEvent('fn-live', { detail }))
}

function enabled() {
  try { return localStorage.getItem('fn_live_captions') !== 'off' } catch { return true }
}

function setEnabled(on) {
  try { localStorage.setItem('fn_live_captions', on ? 'on' : 'off') } catch { /* private mode */ }
  if (!on) stop()
  emit({ type: 'enabled', enabled: on })
}

function supported() {
  return typeof navigator !== 'undefined' && !!navigator.gpu
}

async function ensureModel() {
  if (state.asr) return state.asr
  if (!state.loading) {
    emit({ type: 'state', state: 'loading' })
    state.loading = pipeline('automatic-speech-recognition', MODEL_ID, {
      device: 'webgpu',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          emit({ type: 'progress', file: p.file, progress: Math.round((p.loaded / p.total) * 100) })
        }
      },
    }).then((asr) => {
      state.asr = asr
      return asr
    }).catch((error) => {
      state.loading = null
      throw error
    })
  }
  return state.loading
}

/// Begin captioning a recording. `streams` carries the live MediaStreams; mic and system are
/// merged, because on a call the meeting is both sides of it.
async function start({ micStream, systemStream }) {
  if (!enabled() || state.running) return
  if (!supported()) {
    emit({ type: 'state', state: 'unsupported' })
    return
  }

  state.running = true
  state.paused = false
  state.text = ''
  state.failures = 0
  state.buffered = []
  state.bufferedSamples = 0

  try {
    await ensureModel()
  } catch (error) {
    state.running = false
    emit({ type: 'state', state: 'failed', message: `Couldn't load the caption model: ${error.message}` })
    return
  }
  if (!state.running) return // stopped while the model downloaded

  try {
    // Constructed AT 16 kHz: Chromium resamples the sources into the graph, so the worklet
    // sees exactly what Whisper wants and no resampler is written by hand.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    await ctx.audioWorklet.addModule('pcm-worklet.js')
    const node = new AudioWorkletNode(ctx, 'fn-pcm-tap', { numberOfOutputs: 0 })
    node.port.onmessage = (event) => {
      if (state.paused || !state.running) return
      state.buffered.push(event.data)
      state.bufferedSamples += event.data.length
    }

    for (const stream of [micStream, systemStream]) {
      if (!stream) continue
      const source = ctx.createMediaStreamSource(stream)
      const gain = ctx.createGain()
      gain.gain.value = 0.5 // two live sources sum; halving keeps the mix out of clipping
      source.connect(gain)
      gain.connect(node)
      state.sources.push(source, gain)
    }

    state.ctx = ctx
    state.workletNode = node
    state.timer = setInterval(tick, STRIDE_MS)
    emit({ type: 'state', state: 'listening' })
  } catch (error) {
    state.running = false
    emit({ type: 'state', state: 'failed', message: `Captions couldn't start: ${error.message}` })
  }
}

async function tick() {
  if (!state.running || state.paused || state.transcribing) return
  if (state.bufferedSamples < SAMPLE_RATE) return // under a second of audio: nothing to say

  // Take everything buffered; keep only the newest window if we've fallen behind.
  let chunks = state.buffered
  let total = state.bufferedSamples
  state.buffered = []
  state.bufferedSamples = 0

  const cap = MAX_CHUNK_SECONDS * SAMPLE_RATE
  let dropped = false
  while (total > cap && chunks.length > 1) {
    total -= chunks.shift().length
    dropped = true
  }

  const audio = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length }

  state.transcribing = true
  try {
    const result = await state.asr(audio)
    const addition = String(result?.text || '').trim()
    if (addition) {
      state.text = state.text
        ? `${state.text}${dropped ? ' …' : ''} ${addition}`
        : addition
      if (state.text.length > MAX_TEXT_CHARS) {
        const tail = state.text.slice(-MAX_TEXT_CHARS + 1_000)
        state.text = tail.slice(tail.indexOf(' ') + 1)
      }
      emit({ type: 'text', text: state.text })
    }
    state.failures = 0
  } catch (error) {
    // A bad chunk is survivable; three in a row means the GPU path is genuinely unwell on
    // this machine, and captions bow out while the recording carries on untouched.
    state.failures += 1
    if (state.failures >= 3) {
      const message = `Captions stopped (${error.message}) — the recording is unaffected.`
      stop()
      emit({ type: 'state', state: 'failed', message })
    }
  } finally {
    state.transcribing = false
  }
}

function setPaused(paused) {
  state.paused = paused
  if (state.running) emit({ type: 'state', state: paused ? 'paused' : 'listening' })
}

function stop() {
  if (state.timer) { clearInterval(state.timer); state.timer = null }
  state.running = false
  state.paused = false
  state.buffered = []
  state.bufferedSamples = 0
  for (const nodeRef of state.sources) { try { nodeRef.disconnect() } catch { /* torn down */ } }
  state.sources = []
  if (state.workletNode) { try { state.workletNode.disconnect() } catch { /* torn down */ } state.workletNode = null }
  if (state.ctx) { state.ctx.close().catch(() => {}); state.ctx = null }
  emit({ type: 'state', state: 'idle' })
}

window.fnLive = { start, stop, setPaused, setEnabled, enabled, supported }
emit({ type: 'ready' })
