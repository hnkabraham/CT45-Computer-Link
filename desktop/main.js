import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { loadIdentity } from './src/identity.js';
import { advertiseComputer } from './src/discovery.js';
import { startBluetooth } from './src/bluetooth.js';
import { Sessions, selectScans } from './src/sessions.js';
import { toExcel } from './src/excel.js';
import { toCsv, localTimestamp } from './src/csv.js';
import { computerName, lanAddresses } from './src/network.js';
import { newToken, pairingUrl } from './src/protocol.js';
import { startServer } from './src/server.js';
import { ScanStore } from './src/store.js';
import { symbologyName } from './src/symbology.js';
import { SUFFIXES, createTyper, isPermissionError, wasDelayed } from './src/typer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8765;
const NETWORK_CHECK_MS = 10_000;

// Lets the end-to-end test run against a throwaway profile and port.
const legacyData = ['CT45 Tracker', 'ct45-tracker'].map((name) => path.join(app.getPath('appData'), name));
app.setPath('userData', process.env.CT45_USER_DATA || legacyData.find((dir) => fs.existsSync(dir)) || legacyData[0]);

let win;
let server;
let store;
let settings;
let pairing;
let identity;
let discovery;
let sessions;
let bluetooth;
let bluetoothGeneration = 0;
let pairingGeneration = 0;
let bluetoothState = { status: process.platform === 'darwin' ? 'off' : 'unsupported' };
const type = createTyper();

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    // First run, or an unreadable file: start from defaults.
  }
  const s = {
    token: typeof saved.token === 'string' && saved.token ? saved.token : newToken(),
    port: Number(process.env.CT45_PORT) || (Number.isInteger(saved.port) ? saved.port : DEFAULT_PORT),
    typing: saved.typing === true,
    suffix: SUFFIXES.includes(saved.suffix) ? saved.suffix : 'enter',
    bluetooth: saved.bluetooth === true,
  };
  saveSettings(s);
  return s;
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${settingsFile()}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(`${settingsFile()}.tmp`, settingsFile());
}

async function buildPairing() {
  const hosts = lanAddresses();
  // 127.0.0.1 last: over a USB cable with `adb reverse`, the CT45 reaches us there when Wi-Fi
  // won't carry device-to-device traffic.
  const url = pairingUrl({ hosts: [...hosts, '127.0.0.1'], port: server.port, token: settings.token, name: computerName(), computerId: identity.id, fingerprint: identity.fingerprint, bluetoothService: bluetoothState.serviceId });
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 480, errorCorrectionLevel: 'M' });
  return { url, qr, hosts, port: server.port, name: computerName() };
}

async function publishPairing() {
  const generation = ++pairingGeneration;
  const next = await buildPairing();
  if (generation !== pairingGeneration) return;
  pairing = next;
  send('pairing', pairing);
}

// Wi-Fi changes (new network, new DHCP address) change what the QR code must say.
async function refreshPairing() {
  const hosts = lanAddresses();
  if (pairing && hosts.join() === pairing.hosts.join()) return;
  await publishPairing();
  discovery?.refresh();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function publicSettings() {
  return { typing: settings.typing, suffix: settings.suffix };
}

async function setBluetooth(enabled) {
  const generation = ++bluetoothGeneration;
  bluetooth?.stop();
  bluetooth = null;
  settings.bluetooth = enabled && process.platform === 'darwin';
  saveSettings(settings);
  const update = async (next) => {
    if (generation !== bluetoothGeneration) return;
    bluetoothState = next;
    send('bluetooth', next);
    await publishPairing();
  };
  await update({ status: process.platform !== 'darwin' ? 'unsupported' : enabled ? 'starting' : 'off' });
  if (generation !== bluetoothGeneration || !settings.bluetooth) return bluetoothState;
  const executable = app.isPackaged ? path.join(process.resourcesPath, 'bluetooth', 'ct45-bluetooth') : path.join(here, 'native/bin/ct45-bluetooth');
  bluetooth = startBluetooth({ executable, serviceId: identity.id, port: server.port, onState: (next) => update(next).catch(console.error) });
  return bluetoothState;
}

async function handleScan(msg) {
  if (store.has(msg.id)) return;
  const previous = sessions.state;
  const session = sessions.resolve(msg);
  if (previous !== sessions.state) send('sessions', sessions.state);
  const scan = {
    id: msg.id,
    data: msg.data,
    scannedAt: msg.scannedAt,
    sentAt: msg.sentAt,
    receivedAt: Date.now(),
    aimId: msg.aimId,
    codeId: msg.codeId,
    symbology: symbologyName(msg),
    device: msg.device,
    sessionId: session.id,
    sessionName: session.name,
  };
  if (!store.add(scan)) return; // a resend of something we already have
  send('scan', scan);
  if (settings.typing) typeScan(scan);
}

function typeScan(scan) {
  if (wasDelayed(scan)) {
    send('typing', { ok: false, reason: 'delayed', data: scan.data });
    return;
  }
  const skipReason = () => {
    if (!settings.typing) return 'off'; // switched off while a burst was being typed
    // With this window in front the keystrokes would land in our own search box.
    if (BrowserWindow.getFocusedWindow()) return 'focused';
    return null;
  };
  type(scan.data, settings.suffix, skipReason).then(
    (r) => {
      if (r.typed) send('typing', { ok: true, data: scan.data });
      else if (r.skipped !== 'off') send('typing', { ok: false, reason: r.skipped, data: scan.data });
    },
    (e) => send('typing', { ok: false, reason: isPermissionError(e.message) ? 'permission' : 'error', message: e.message, data: scan.data }),
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 420,
    minHeight: 480,
    title: 'CT45 Computer Link',
    backgroundColor: '#f5f6f8',
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The end-to-end test shouldn't steal focus from whatever you're doing.
  win.once('ready-to-show', () => (process.env.CT45_E2E ? win.showInactive() : win.show()));
  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(here, 'ui', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('get-state', () => ({
    scans: store.list(),
    sessions: sessions.state,
    devices: server.devices(),
    pairing,
    bluetooth: bluetoothState,
    settings: publicSettings(),
    platform: process.platform,
    typingSupported: process.platform === 'darwin' || process.platform === 'win32',
  }));

  ipcMain.handle('set-bluetooth', (_e, enabled) => setBluetooth(enabled === true));

  ipcMain.handle('set-settings', (_e, patch) => {
    if (typeof patch?.typing === 'boolean') settings.typing = patch.typing;
    if (SUFFIXES.includes(patch?.suffix)) settings.suffix = patch.suffix;
    saveSettings(settings);
    return publicSettings();
  });

  ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text)));

  ipcMain.handle('create-session', (_e, name) => {
    sessions.create(name);
    server.sessionChanged();
    send('sessions', sessions.state);
    return sessions.state;
  });
  ipcMain.handle('activate-session', (_e, id) => {
    sessions.activate(id);
    server.sessionChanged();
    send('sessions', sessions.state);
    return sessions.state;
  });

  ipcMain.handle('export-scans', async (_e, options = {}) => {
    const format = options.format === 'csv' ? 'csv' : 'xlsx';
    const scans = selectScans(store.list(), options);
    const stamp = localTimestamp(Date.now()).replace(/[: ]/g, '-').slice(0, 16);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export scans',
      defaultPath: path.join(app.getPath('documents'), `CT45 scans ${stamp}.${format}`),
      filters: [{ name: format === 'csv' ? 'CSV' : 'Excel workbook', extensions: [format] }],
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, format === 'csv' ? toCsv(scans) : await toExcel(scans));
    return { path: filePath, count: scans.length };
  });

  // Returns what's left, so the window can't drop a scan that raced the clear.
  ipcMain.handle('clear-scans', (_e, sessionId) => {
    store.clear(sessionId);
    return store.list();
  });

  ipcMain.handle('new-pairing-code', async () => {
    settings.token = newToken();
    saveSettings(settings);
    server.disconnectAll();
    await publishPairing();
    return pairing;
  });

  ipcMain.handle('open-accessibility-settings', () => {
    if (process.platform === 'darwin') {
      return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
  });
}

// Two copies would fight over the port and the scan file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      settings = loadSettings();
      store = new ScanStore(path.join(app.getPath('userData'), 'scans.jsonl')).load();
      sessions = new Sessions(path.join(app.getPath('userData'), 'sessions.json'));
      identity = await loadIdentity(path.join(app.getPath('userData'), 'identity.json'));
      server = await startServer({
        port: settings.port,
        identity,
        getSession: () => sessions.active,
        getToken: () => settings.token,
        computerName,
        onScan: handleScan,
        onDevicesChanged: (devices) => send('devices', devices),
      });
    } catch (e) {
      dialog.showErrorBox('CT45 Computer Link', `Couldn't start listening for scanners: ${e.message}`);
      app.quit();
      return;
    }
    // If the usual port was busy, keep the one we got so paired scanners find us next time.
    if (server.port !== settings.port && !process.env.CT45_PORT) {
      settings.port = server.port;
      saveSettings(settings);
    }
    pairing = await buildPairing();
    discovery = advertiseComputer(identity, server.port, (e) => console.warn('Local discovery unavailable:', e.message));
    registerIpc();
    createWindow();
    if (settings.bluetooth) await setBluetooth(true);
    setInterval(() => refreshPairing().catch(() => {}), NETWORK_CHECK_MS);
  });

  // The window is the app: closing it stops listening for scanners, on every platform.
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { ++bluetoothGeneration; ++pairingGeneration; bluetooth?.stop(); discovery?.stop(); server?.close(); });
}
