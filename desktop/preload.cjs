// The only bridge between the window and the main process. Sandboxed preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['scan', 'devices', 'pairing', 'typing'];

contextBridge.exposeInMainWorld('ct45', {
  getState: () => ipcRenderer.invoke('get-state'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  copy: (text) => ipcRenderer.invoke('copy', text),
  exportCsv: () => ipcRenderer.invoke('export-csv'),
  clearScans: () => ipcRenderer.invoke('clear-scans'),
  newPairingCode: () => ipcRenderer.invoke('new-pairing-code'),
  openAccessibilitySettings: () => ipcRenderer.invoke('open-accessibility-settings'),
  on(event, callback) {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event ${event}`);
    ipcRenderer.on(event, (_e, payload) => callback(payload));
  },
});
