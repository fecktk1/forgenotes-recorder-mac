// Preload — exposes a narrow, safe bridge to the sandboxed renderer. The renderer
// never gets Node/fs/ipc directly; only these typed calls.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
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

  // Local recording fallback / offline queue. Blobs cross IPC as ArrayBuffers.
  saveRecording: (localId, meta, segments) => ipcRenderer.invoke('rec:save', { localId, meta, segments }),
  checkpoint: (localId, meta, segment) => ipcRenderer.invoke('rec:checkpoint', { localId, meta, segment }),
  finishRecording: (localId) => ipcRenderer.invoke('rec:finish', localId),
  markUploaded: (localId, sessionId) => ipcRenderer.invoke('rec:uploaded', { localId, sessionId }),
  readSegment: (localId, segment) => ipcRenderer.invoke('rec:segment', { localId, segment }),
  playback: (localId) => ipcRenderer.invoke('rec:playback', localId),
  openRecordingFolder: (localId) => ipcRenderer.invoke('rec:folder', localId),
  listPending: () => ipcRenderer.invoke('rec:list'),
  readRecording: (localId) => ipcRenderer.invoke('rec:read', localId),
  deleteRecording: (localId) => ipcRenderer.invoke('rec:delete', localId),
})
