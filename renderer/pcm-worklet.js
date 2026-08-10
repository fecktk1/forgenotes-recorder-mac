// AudioWorklet processor: hands mono PCM frames to the live-caption transcriber.
//
// Runs on the audio rendering thread, so it does the minimum imaginable — copy the first
// channel and post it. Downmixing and pacing live on the main thread; the 16 kHz sample rate
// comes from the AudioContext itself (constructed at 16000), so no resampling happens here.
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) {
      // Copy: the engine recycles this buffer the moment process() returns.
      this.port.postMessage(new Float32Array(channel))
    }
    return true
  }
}

registerProcessor('fn-pcm-tap', PcmTap)
