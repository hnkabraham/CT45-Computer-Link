// Runs the real Electron app against a throwaway profile, drives it with a fake scanner, and
// checks the window over the DevTools protocol. Never turns typing on while scans arrive, so
// it can't type into whatever you have open.
//   npm run e2e            (SCREENSHOT_DIR=/some/dir to keep screenshots)
//   CT45_APP="dist/mac-arm64/CT45 Computer Link.app/Contents/MacOS/CT45 Computer Link" npm run e2e
//                          tests a packaged build instead of the source

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import WebSocket from 'ws';
import { fakeScan } from './fake-scanner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18765;
const DEBUG_PORT = 19333;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ct45-e2e-'));
const shots = process.env.SCREENSHOT_DIR;
const testBluetooth = process.env.CT45_BLUETOOTH_E2E === '1' && process.platform === 'darwin';
if (shots) fs.mkdirSync(shots, { recursive: true });

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => {
      ws.once('open', r);
      ws.once('error', j);
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  async waitFor(expression, timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.eval(expression).catch(() => false)) return true;
      await sleep(100);
    }
    return false;
  }
  async screenshot(name) {
    if (!shots) return;
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, name), Buffer.from(data, 'base64'));
  }
  close() {
    this.ws.close();
  }
}

async function launch() {
  const debug = `--remote-debugging-port=${DEBUG_PORT}`;
  const child = spawn(process.env.CT45_APP ?? electronPath, process.env.CT45_APP ? [debug] : [root, debug], {
    env: { ...process.env, CT45_USER_DATA: userData, CT45_PORT: String(PORT), CT45_E2E: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  // A first Rosetta launch may need time to translate the packaged Intel framework.
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.endsWith('index.html'));
      if (page) {
        const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
        await cdp.waitFor('document.readyState === "complete" && !!document.getElementById("qr").naturalWidth');
        return { child, cdp };
      }
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  child.kill();
  throw new Error(`Electron didn't start:\n${stderr}`);
}

async function quit(child) {
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await exited;
}

const text = (id) => `document.getElementById(${JSON.stringify(id)}).textContent`;
const rows = 'document.querySelectorAll("#rows tr").length';
const readSettings = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));

// The copy check uses the real clipboard; put back whatever text was on it.
const savedClipboard = process.platform === 'darwin' ? execFileSync('pbpaste') : null;

let { child, cdp } = await launch();
try {
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  // Empty, unpaired
  check('starts waiting for a scanner', (await cdp.eval(text('connection-text'))) === 'Waiting for a scanner');
  check('empty state shown', await cdp.eval('!document.getElementById("empty").hidden'));
  check('export disabled with no scans', await cdp.eval('document.getElementById("export").disabled'));
  const state = await cdp.eval('window.ct45.getState()');
  check('pairing link names the port and a LAN address', state.pairing.port === PORT && state.pairing.hosts.length > 0, JSON.stringify(state.pairing.hosts));
  check('pairing QR rendered', (await cdp.eval('document.getElementById("qr").naturalWidth')) > 100);
  check('pairing panel open while nothing is connected', await cdp.eval('document.getElementById("pair").open'));
  check('typing off by default', (await cdp.eval('document.getElementById("typing").checked')) === false && readSettings().typing === false);
  check('Bluetooth starts disabled without changing network pairing', !readSettings().bluetooth && !new URL(state.pairing.url).searchParams.has('bt'));
  if (testBluetooth) {
    await cdp.eval('document.getElementById("bluetooth-toggle").click(); true');
    check('packaged Bluetooth helper starts and adds its identity to the QR', await cdp.waitFor('(async () => { const s = await window.ct45.getState(); return s.bluetooth.status === "ready" && new URL(s.pairing.url).searchParams.get("bt") === s.bluetooth.serviceId; })()', 30000));
    await cdp.eval('Promise.all([window.ct45.setBluetooth(true), window.ct45.setBluetooth(false)])');
    check('rapid Bluetooth enable/disable leaves no stale QR endpoint', await cdp.waitFor('(async () => { const s = await window.ct45.getState(); return s.bluetooth.status === "off" && !new URL(s.pairing.url).searchParams.has("bt"); })()'));
    await cdp.eval('window.ct45.setBluetooth(true)');
    check('Bluetooth can start again', await cdp.waitFor('(async () => (await window.ct45.getState()).bluetooth.status === "ready")()', 30000));
  }
  await cdp.screenshot('ct45-desktop-empty.png');

  // A scanner connects and scans. Connect over loopback: the LAN address can be firewalled.
  const { ws } = await fakeScan(state.pairing.url, ['0123456789012', 'ABC-123', '=cmd|x'], { host: '127.0.0.1' });
  check('shows the scanner as connected', await cdp.waitFor(`${text('connection-text')} === "Fake CT45 connected"`));
  check('three scans listed', await cdp.waitFor(`${rows} === 3`));
  check('newest scan first', (await cdp.eval('document.querySelector("#rows tr .data").textContent')) === '=cmd|x');
  check('symbology shown', (await cdp.eval('document.querySelector("#rows tr .kind").textContent')) === 'Code 128');
  check('pairing panel folds away once connected', await cdp.eval('!document.getElementById("pair").open'));
  check('count updated', (await cdp.eval(text('count'))) === '3 scans');

  // The scanner resends anything whose ack it missed; the list must not double up.
  const dup = { type: 'scan', id: 'resend-1', data: '\u001d0109501101530003', scannedAt: Date.now(), aimId: ']C1' };
  ws.send(JSON.stringify(dup));
  ws.send(JSON.stringify(dup));
  check('a resent scan is listed once', await cdp.waitFor(`${rows} === 4`) && (await sleep(300), (await cdp.eval(rows)) === 4));
  check('GS1 separator shown visibly', (await cdp.eval('document.querySelector("#rows tr .data").textContent')) === '␝0109501101530003');

  // Search
  await cdp.eval('const s = document.getElementById("search"); s.value = "abc"; s.dispatchEvent(new Event("input")); true');
  check('search filters', (await cdp.eval(rows)) === 1 && (await cdp.eval(text('count'))) === '1 match of 4 scans');
  await cdp.eval('const s3 = document.getElementById("search"); s3.value = "01"; s3.dispatchEvent(new Event("input")); true');
  check('several matches read correctly', (await cdp.eval(text('count'))) === '2 matches of 4 scans', await cdp.eval(text('count')));
  await cdp.eval('const s2 = document.getElementById("search"); s2.value = ""; s2.dispatchEvent(new Event("input")); true');

  // Copy
  await cdp.eval('document.querySelector("#rows tr:nth-child(3)").click(); true');
  check('clicking a row copies it', await cdp.waitFor(`${text('toast')} === "Copied ABC-123"`));

  if (shots) await sleep(2600); // Let the copy toast clear before documenting the interface.
  await cdp.screenshot('ct45-desktop-light.png');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  await cdp.screenshot('ct45-desktop-dark.png');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 2, mobile: false });
  await sleep(200);
  check('no sideways scrolling at 420px wide', await cdp.eval('document.documentElement.scrollWidth <= 420'));
  await cdp.screenshot('ct45-desktop-narrow.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  // Disconnect
  ws.close();
  check('shows disconnect', await cdp.waitFor(`${text('connection-text')} === "Waiting for a scanner"`));

  // Typing switch persists (no scans are sent while it's on).
  await cdp.eval('document.getElementById("typing").click(); true');
  await sleep(200);
  check('typing switch saves', readSettings().typing === true && (await cdp.eval('!document.getElementById("suffix").disabled')));
  await cdp.eval('document.querySelector("input[name=suffix][value=tab]").click(); true');
  await sleep(200);
  check('suffix saves', readSettings().suffix === 'tab');
  await cdp.eval('document.getElementById("typing").click(); true');
  await sleep(200);
  check('typing switch turns off', readSettings().typing === false);

  // Scans survive a restart.
  cdp.close();
  await quit(child);
  ({ child, cdp } = await launch());
  check('scans survive a restart', await cdp.waitFor(`${rows} === 4`));
  if (testBluetooth) {
    check('Bluetooth preference survives a desktop restart', readSettings().bluetooth && await cdp.waitFor('(async () => (await window.ct45.getState()).bluetooth.status === "ready")()', 30000));
    await cdp.eval('window.ct45.setBluetooth(false)');
    check('Bluetooth can be disabled after restart', (await cdp.eval('window.ct45.getState()')).bluetooth.status === 'off');
  }

  // New pairing code invalidates the old link.
  const oldLink = (await cdp.eval('window.ct45.getState()')).pairing.url;
  await cdp.eval('document.getElementById("new-code").click(); document.getElementById("new-code-yes").click(); true');
  await cdp.waitFor(`${text('toast')} === "New pairing code ready"`);
  const refused = await fakeScan(oldLink, ['x'], { host: '127.0.0.1' }).then(
    () => false,
    (e) => /no longer valid/.test(e.message),
  );
  check('old pairing code is refused after making a new one', refused);
  const newLink = (await cdp.eval('window.ct45.getState()')).pairing.url;
  const again = await fakeScan(newLink, ['after-repair'], { host: '127.0.0.1' });
  check('new pairing code works', await cdp.waitFor(`${rows} === 5`));
  again.ws.close();

  // Clear
  await cdp.eval('document.getElementById("clear").click(); true');
  check('clear asks first', await cdp.eval('!document.getElementById("clear-confirm").hidden') && (await cdp.eval(rows)) === 5);
  await cdp.eval('document.getElementById("clear-yes").click(); true');
  check('clear empties the list', await cdp.waitFor('!document.getElementById("empty").hidden'));
  check('clear leaves no barcodes in the file', !fs.readFileSync(path.join(userData, 'scans.jsonl'), 'utf8').includes('"data"'));

  // Session controls, offline attribution and session-scoped clearing.
  await cdp.eval('document.getElementById("new-session").click(); document.getElementById("session-name").value = "Warehouse count"; document.getElementById("session-form").requestSubmit(); true');
  check('new session selected for scanning and viewing', await cdp.waitFor('document.getElementById("active-session").selectedOptions[0].textContent === "Warehouse count" && document.getElementById("view-session").value === document.getElementById("active-session").value'));
  const named = await fakeScan(newLink, ['0000123456789', '12345678901234567890', 'BIN-A-0042'], { host: '127.0.0.1', device: 'Demo CT45' });
  check('new scans carry the active session', await cdp.waitFor(`${rows} === 3`) && (await cdp.eval('window.ct45.getState()')).scans.every((s) => s.sessionName === 'Warehouse count'));
  named.ws.send(JSON.stringify({ type: 'scan', id: 'late', data: 'OFFLINE-GENERAL', scannedAt: Date.now() - 120000, sessionId: 'default', sessionName: 'General' }));
  await sleep(250);
  check('offline scan stays in its earlier session', (await cdp.eval(rows)) === 3 && (await cdp.eval('window.ct45.getState()')).scans.find((s) => s.id === 'late').sessionId === 'default');
  await sleep(2600);
  await cdp.screenshot('ct45-desktop-sessions.png');
  named.ws.close();
  cdp.close();
  await quit(child);
  ({ child, cdp } = await launch());
  check('active session persists after restart', (await cdp.eval('document.getElementById("active-session").selectedOptions[0].textContent')) === 'Warehouse count');
  await cdp.eval('document.getElementById("view-session").value = document.getElementById("active-session").value; document.getElementById("view-session").dispatchEvent(new Event("change")); document.getElementById("clear").click(); document.getElementById("clear-yes").click(); true');
  check('clearing one session keeps the other session', await cdp.waitFor('document.querySelectorAll("#rows tr").length === 0') && (await cdp.eval('window.ct45.getState()')).scans.length === 1);
  await cdp.eval('document.getElementById("active-session").value = "default"; document.getElementById("active-session").dispatchEvent(new Event("change")); true');
  check('an earlier session can be resumed', await cdp.waitFor('(async () => (await window.ct45.getState()).sessions.activeId === "default")()'));

  const repeats = await fakeScan(newLink, ['BIN-A-0042', 'BIN-A-0042'], { host: '127.0.0.1', device: 'Demo CT45' });
  await cdp.eval('document.getElementById("view-session").value = ""; document.getElementById("view-session").dispatchEvent(new Event("change")); true');
  check('intentional repeated scans are kept and labeled', await cdp.waitFor('document.querySelectorAll(".repeat-badge").length === 2') && (await cdp.eval('window.ct45.getState()')).scans.length === 3);
  check('copy has a keyboard-accessible button', await cdp.eval('document.querySelector("#rows .copy-scan").tagName === "BUTTON"'));
  await cdp.eval('document.querySelector("#rows .copy-scan").click(); true');
  check('copy button copies only the barcode', await cdp.waitFor(`${text('toast')} === "Copied BIN-A-0042"`));
  check('loopback does not pretend to be USB', await cdp.eval('document.querySelector("#device-list .meta").textContent.startsWith("Local connection")'));
  const target = (await cdp.eval('window.ct45.getState()')).sessions.items.find((s) => s.name === 'Warehouse count');
  repeats.ws.send(JSON.stringify({ type: 'select-session', sessionId: target.id, requestId: 'from-handheld' }));
  check('handheld session selection updates the desktop control', await cdp.waitFor('document.getElementById("active-session").selectedOptions[0].textContent === "Warehouse count"'));
  await sleep(2600);
  await cdp.screenshot('ct45-desktop-repeats.png');
  repeats.ws.close();

} finally {
  cdp.close();
  await quit(child);
  fs.rmSync(userData, { recursive: true, force: true });
  if (savedClipboard) execFileSync('pbcopy', { input: savedClipboard });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
