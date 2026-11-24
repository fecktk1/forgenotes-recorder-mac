// Preload — exposes a narrow, safe bridge to the sandboxed renderer. The renderer
// never gets Node/fs/ipc directly; only these typed calls.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  // The app around this window (shell.js). The recorder reports its state for the menu bar
  // or tray popover and the floating bar, and hears what they ask for.
  publishShellState: (state) => ipcRenderer.send('shell:state', state),
  onShellCommand: (cb) => {
    const handler = (_e, command) => cb(command)
    ipcRenderer.on('shell:command', handler)
    return () => ipcRenderer.removeListener('shell:command', handler)
  },
  // Ask for an update check now: { quiet } keeps main from showing its own message.
  checkForUpdates: (request) => ipcRenderer.invoke('update:check', request),
  // A menu drawn by the system at the pointer: [{ id, label, enabled } | { type: 'separator' }].
  // Resolves to the chosen id, or null.
  popupMenu: (items) => ipcRenderer.invoke('menu:popup', items),

  getConfig: () => ipcRenderer.invoke('config:get'),

  // Call audio: whether this Mac can record it natively (macOS 14.2+), and a button target
  // for the System Settings pane that lists the apps allowed to record system audio.
  systemAudioInfo: () => ipcRenderer.invoke('system-audio:info'),
  openSystemAudioSettings: () => ipcRenderer.invoke('system-audio:open-settings'),

  // The shipped recording-announcement voices (renderer/announce/voices.json); null if unreadable.
  announceVoices: () => ipcRenderer.invoke('announce:voices'),

  // Auth token persistence (encrypted at rest via OS safeStorage in main).
  secureGet: () => ipcRenderer.invoke('secure:get'),
  secureSet: (token) => ipcRenderer.invoke('secure:set', token),
  secureClear: () => ipcRenderer.invoke('secure:clear'),

  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  // This install's opaque id for ForgeNotes (device-id.js in main); null when it cannot be kept.
  deviceId: () => ipcRenderer.invoke('device:id'),

  // Free disk space on the recordings volume (preflight); null if unavailable.
  diskFree: () => ipcRenderer.invoke('disk:free'),

  // Append a line to the upload diagnostics log (userData/upload-log.txt).
  appendLog: (line) => ipcRenderer.invoke('log:append', line),

  // Auto-update status. Poll once on load, then listen — an update that finished
  // downloading before the renderer was ready would otherwise be missed.
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  onUpdateState: (cb) => {
    const handler = (_e, state) => cb(state)
    ipcRenderer.on('update:state', handler)
    return () => ipcRenderer.removeListener('update:state', handler)
  },

  // The Mac going to sleep and waking: { state: 'suspend' | 'resume', at: ms }.
  onPower: (cb) => {
    const handler = (_e, event) => cb(event)
    ipcRenderer.on('power:state', handler)
    return () => ipcRenderer.removeListener('power:state', handler)
  },

  // Stop on silence: raise and clear the "Still there?" notification; onSilenceKeep fires
  // when the person answers it.
  silenceAsk: (body) => ipcRenderer.invoke('silence:ask', { body }),
  silenceClear: () => ipcRenderer.invoke('silence:clear'),
  onSilenceKeep: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('silence:keep', handler)
    return () => ipcRenderer.removeListener('silence:keep', handler)
  },

  // Quit during a recording: main asks, and on Stop and Quit tells the page to save the
  // recording (onStopForQuit), which then calls quitNow.
  onStopForQuit: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('app:stop-for-quit', handler)
    return () => ipcRenderer.removeListener('app:stop-for-quit', handler)
  },
  quitNow: () => ipcRenderer.invoke('app:quit'),

  // Local recording fallback / offline queue. Blobs cross IPC as ArrayBuffers.
  saveRecording: (localId, meta, segments) => ipcRenderer.invoke('rec:save', { localId, meta, segments }),
  checkpoint: (localId, meta, segment) => ipcRenderer.invoke('rec:checkpoint', { localId, meta, segment }),
  // details: { endedAt (ISO), stopReason }.
  finishRecording: (localId, details) => ipcRenderer.invoke('rec:finish', { localId, details }),
  markUploaded: (localId, sessionId) => ipcRenderer.invoke('rec:uploaded', { localId, sessionId }),
  readSegment: (localId, segment) => ipcRenderer.invoke('rec:segment', { localId, segment }),
  playback: (localId) => ipcRenderer.invoke('rec:playback', localId),
  openRecordingFolder: (localId) => ipcRenderer.invoke('rec:folder', localId),
  listPending: () => ipcRenderer.invoke('rec:list'),
  readRecording: (localId) => ipcRenderer.invoke('rec:read', localId),
  deleteRecording: (localId) => ipcRenderer.invoke('rec:delete', localId),
})
