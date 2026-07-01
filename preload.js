// Preload — exposes a narrow, safe bridge to the sandboxed renderer. The renderer
// never gets Node/fs/ipc directly; only these typed calls.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  getConfig: () => ipcRenderer.invoke('config:get'),

  // Auth token persistence (encrypted at rest via OS safeStorage in main).
  secureGet: () => ipcRenderer.invoke('secure:get'),
  secureSet: (token) => ipcRenderer.invoke('secure:set', token),
  secureClear: () => ipcRenderer.invoke('secure:clear'),

  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  // Free disk space on the recordings volume (preflight); null if unavailable.
  diskFree: () => ipcRenderer.invoke('disk:free'),

  // Local recording fallback / offline queue. Blobs cross IPC as ArrayBuffers.
  saveRecording: (localId, meta, segments) => ipcRenderer.invoke('rec:save', { localId, meta, segments }),
  listPending: () => ipcRenderer.invoke('rec:list'),
  readRecording: (localId) => ipcRenderer.invoke('rec:read', localId),
  deleteRecording: (localId) => ipcRenderer.invoke('rec:delete', localId),
})
