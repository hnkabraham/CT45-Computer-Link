// The only bridge between the window and the main process. Sandboxed preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['scan', 'devices', 'pairing', 'typing', 'sessions', 'bluetooth'];

contextBridge.exposeInMainWorld('ct45', {
  getState: () => ipcRenderer.invoke('get-state'),
  setBluetooth: (enabled) => ipcRenderer.invoke('set-bluetooth', enabled),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  copy: (text) => ipcRenderer.invoke('copy', text),
  exportScans: (options) => ipcRenderer.invoke('export-scans', options),
  createSession: (name) => ipcRenderer.invoke('create-session', name),
  activateSession: (id) => ipcRenderer.invoke('activate-session', id),
  clearScans: (id) => ipcRenderer.invoke('clear-scans', id),
  newPairingCode: () => ipcRenderer.invoke('new-pairing-code'),
  openAccessibilitySettings: () => ipcRenderer.invoke('open-accessibility-settings'),
  on(event, callback) {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event ${event}`);
    ipcRenderer.on(event, (_e, payload) => callback(payload));
  },
});
