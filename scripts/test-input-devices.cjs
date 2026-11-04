// The microphone and the call-audio source must never be the same input. These are the
// device lists Chromium gives the renderer on a Mac: a "default" entry first, named after
// the input macOS is set to and sharing that device's group, then the devices themselves.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const devices = require('../renderer/input-devices')

const mic = { kind: 'audioinput', deviceId: 'mbp-mic', groupId: 'g-mbp', label: 'MacBook Pro Microphone (Built-in)' }
const blackhole = { kind: 'audioinput', deviceId: 'bh-2ch', groupId: 'g-bh', label: 'BlackHole 2ch (Virtual)' }
const blackhole16 = { kind: 'audioinput', deviceId: 'bh-16ch', groupId: 'g-bh16', label: 'BlackHole 16ch (Virtual)' }
const defaultFor = (device) => ({ kind: 'audioinput', deviceId: 'default', groupId: device.groupId, label: `Default - ${device.label}` })

// macOS's input set to BlackHole: the setup behind the meetings whose call track was a
// byte-for-byte copy of the microphone track.
const inputIsBlackhole = [defaultFor(blackhole), blackhole16, mic, blackhole]
const inputIsMic = [defaultFor(mic), mic, blackhole]

test('the default entry is the device macOS is set to', () => {
  assert.equal(devices.resolveInput('default', inputIsBlackhole), blackhole)
  assert.equal(devices.resolveInput('', inputIsBlackhole), blackhole, 'no deviceId constraint opens the default input')
  assert.equal(devices.resolveInput('default', inputIsMic), mic)
  assert.equal(devices.resolveInput('mbp-mic', inputIsMic), mic)
  assert.equal(devices.resolveInput('gone', inputIsMic), null)
})

test('the microphone left on "Default - BlackHole 2ch" is the call-audio input', () => {
  assert.equal(devices.sameInput('default', 'bh-2ch', inputIsBlackhole), true)
  assert.equal(devices.sameInput('', 'bh-2ch', inputIsBlackhole), true)
  assert.equal(devices.sameInput('bh-2ch', 'bh-2ch', inputIsBlackhole), true)
  assert.equal(devices.sameInput('mbp-mic', 'bh-2ch', inputIsBlackhole), false)
  assert.equal(devices.sameInput('default', 'bh-16ch', inputIsBlackhole), false, 'another BlackHole is another device')
})

test('a microphone and BlackHole are different inputs', () => {
  assert.equal(devices.sameInput('default', 'bh-2ch', inputIsMic), false)
  assert.equal(devices.sameInput('mbp-mic', 'bh-2ch', inputIsMic), false)
  // A microphone picked as the call-audio source is the microphone twice.
  assert.equal(devices.sameInput('default', 'mbp-mic', inputIsMic), true)
})

test('no call-audio source, or a list that cannot tell, is never "the same input"', () => {
  assert.equal(devices.sameInput('default', '', inputIsBlackhole), false)
  assert.equal(devices.sameInput('default', null, inputIsBlackhole), false)
  assert.equal(devices.sameInput('a', 'b', []), false)
  assert.equal(devices.sameInput('same', 'same', []), true, 'one id opens one input')
  // Two identical USB microphones and no groups: the default entry matches both, so it
  // resolves to neither rather than to a guess.
  const twins = [
    { kind: 'audioinput', deviceId: 'default', groupId: '', label: 'Default - USB Mic' },
    { kind: 'audioinput', deviceId: 'usb-1', groupId: '', label: 'USB Mic' },
    { kind: 'audioinput', deviceId: 'usb-2', groupId: '', label: 'USB Mic' },
  ]
  assert.equal(devices.resolveInput('default', twins), null)
  assert.equal(devices.sameInput('default', 'usb-1', twins), false)
  // With their groups the default entry is no longer ambiguous.
  const grouped = twins.map((d, i) => ({ ...d, groupId: i === 2 ? 'g2' : 'g1' }))
  assert.equal(devices.sameInput('default', 'usb-1', grouped), true)
  assert.equal(devices.sameInput('default', 'usb-2', grouped), false)
  // Outputs in the list are ignored.
  assert.equal(devices.resolveInput('default', [{ kind: 'audiooutput', deviceId: 'out', groupId: 'g-bh', label: 'BlackHole 2ch (Virtual)' }, defaultFor(blackhole)]), null)
})

test('opened tracks: the ids and groups Chromium reports', () => {
  const track = (settings, label) => ({ label, getSettings: () => settings })
  const micTrack = track({ deviceId: 'default', groupId: 'g-bh' }, 'Default - BlackHole 2ch (Virtual)')
  const callTrack = track({ deviceId: 'bh-2ch', groupId: 'g-bh' }, 'BlackHole 2ch (Virtual)')
  const realMicTrack = track({ deviceId: 'mbp-mic', groupId: 'g-mbp' }, 'MacBook Pro Microphone (Built-in)')
  assert.equal(devices.sameOpenedInput(micTrack, callTrack, inputIsBlackhole), true)
  assert.equal(devices.sameOpenedInput(micTrack, callTrack, []), true, 'not in the list: the same group and name')
  assert.equal(devices.sameOpenedInput(realMicTrack, callTrack, inputIsBlackhole), false)
  assert.equal(devices.sameOpenedInput(realMicTrack, callTrack, []), false)
  assert.equal(devices.sameOpenedInput(null, callTrack, inputIsBlackhole), false)
  const broken = { label: 'x', getSettings: () => { throw new Error('ended') } }
  assert.equal(devices.sameOpenedInput(broken, callTrack, inputIsBlackhole), false)
})

test('the preselected microphone moves off the call-audio input to a real microphone', () => {
  // BlackHole 16ch comes before the MacBook microphone and is skipped: it is a loopback driver.
  assert.equal(devices.distinctMicId(inputIsBlackhole, 'bh-2ch', 'default'), 'mbp-mic')
  assert.equal(devices.distinctMicId(inputIsMic, 'bh-2ch', 'default'), 'default', 'unchanged when it is not the call input')
  assert.equal(devices.distinctMicId(inputIsBlackhole, '', 'default'), 'default', 'no call-audio source, nothing to avoid')
  // Nothing better to offer: left as it is, for the device check and Start to report.
  assert.equal(devices.distinctMicId([defaultFor(blackhole), blackhole, blackhole16], 'bh-2ch', 'default'), 'default')
})

test('names for messages drop the "Default - " prefix', () => {
  assert.equal(devices.inputName('default', inputIsBlackhole), 'BlackHole 2ch (Virtual)')
  assert.equal(devices.inputName('bh-2ch', inputIsBlackhole), 'BlackHole 2ch (Virtual)')
  assert.equal(devices.inputName('gone', inputIsBlackhole), 'the selected input')
  assert.equal(devices.baseLabel('Default - MacBook Pro Microphone (Built-in)'), 'MacBook Pro Microphone (Built-in)')
  assert.equal(devices.isPseudo(''), true)
  assert.equal(devices.isPseudo('communications'), true)
  assert.equal(devices.isPseudo('bh-2ch'), false)
})
