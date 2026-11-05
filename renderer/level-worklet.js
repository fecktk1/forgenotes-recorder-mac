// AudioWorklet processor: reports how loud a live track is, a few times a second.
//
// It runs on the audio rendering thread, so it sees every sample and keeps working while
// the window is in the background (the on-screen meters are drawn with requestAnimationFrame
// and stop there). The recorder uses these reports to notice a silent or dead track while
// the meeting is still going on, not after it has ended.
class LevelTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.peak = 0
    this.frames = 0
    this.reportEvery = Math.round(sampleRate / 4)
  }

  process(inputs) {
    const input = inputs[0]
    let blockFrames = 128
    if (input && input.length) {
      blockFrames = input[0].length
      for (let c = 0; c < input.length; c++) {
        const channel = input[c]
        for (let i = 0; i < channel.length; i++) {
          const v = channel[i]
          const a = v < 0 ? -v : v
          if (a > this.peak) this.peak = a
        }
      }
    }
    this.frames += blockFrames
    if (this.frames >= this.reportEvery) {
      this.port.postMessage({ peak: this.peak, frames: this.frames, sampleRate })
      this.peak = 0
      this.frames = 0
    }
    return true
  }
}

registerProcessor('fn-level-tap', LevelTap)
