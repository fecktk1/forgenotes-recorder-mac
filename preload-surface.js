// Preload for the popover and the floating bar (renderer/surfaces/). Shared by the macOS
// and Windows apps: keep the two copies identical.
//
// These pages are shown the recorder's state and may ask for a few named actions
// (shell.js lists them). They get nothing else: no recordings, no token, no files.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('surface', {
  platform: process.platform,
  // The latest state now, then every change.
  ready: () => ipcRenderer.invoke('surface:ready'),
  onState: (cb) => { ipcRenderer.on('surface:state', (_e, state) => cb(state)) },
  // { type: 'start' | 'stop' | 'pause' | 'mode' | 'keep' | 'captions' | 'title' | 'recordings' | 'settings' | 'open' | 'updates' | 'hide' | 'quit', ... }
  command: (command) => ipcRenderer.send('surface:command', command),
  // The page's own height, so the window can fit it.
  size: (height) => ipcRenderer.send('surface:size', { height }),
})
