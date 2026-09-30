// Real CT45 tests through the production app and physical Bluetooth radio, using synthetic scans.
// Opt in explicitly. Preserves app data; temporarily changes pairing, connection mode, background
// mode and CT45 Wi-Fi/Bluetooth. Never resets the device or toggles the Mac's Bluetooth adapter.
// ANDROID_SERIAL=... CT45_HARDWARE_TEST=1 [CT45_SOAK_HOURS=6] node scripts/bluetooth-hardware.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadIdentity } from '../src/identity.js';
import { startServer } from '../src/server.js';
import { startBluetooth } from '../src/bluetooth.js';
import { ScanStore } from '../src/store.js';
import { newToken, pairingUrl } from '../src/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serial = process.env.ANDROID_SERIAL;
if (!serial || process.env.CT45_HARDWARE_TEST !== '1') throw new Error('Set ANDROID_SERIAL and CT45_HARDWARE_TEST=1 for the connected test device.');
const hours = Number(process.env.CT45_SOAK_HOURS || 0);
assert.ok(Number.isFinite(hours) && hours >= 0 && hours <= 8, 'Soak duration must be 0–8 hours');
const dir = process.env.CT45_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ct45-bluetooth-'));
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
if (fs.existsSync(path.join(dir, 'report.json'))) throw new Error('Use a new test directory to preserve previous results.');
console.log(`Test results: ${dir}`);
const report = { started: new Date().toISOString(), pid: process.pid, checks: [], status: 'running', soakHours: hours };
const store = new ScanStore(path.join(dir, 'received.jsonl')).load();
let duplicateDeliveries = 0;
const save = () => {
  report.updated = new Date().toISOString(); report.uniqueScans = store.list().length; report.duplicateDeliveries = duplicateDeliveries;
  fs.writeFileSync(path.join(dir, 'report.json.tmp'), JSON.stringify(report, null, 2), { mode: 0o600 });
  fs.renameSync(path.join(dir, 'report.json.tmp'), path.join(dir, 'report.json'));
};
const pass = (name) => { report.checks.push({ name, at: new Date().toISOString() }); save(); console.log(`PASS ${name}`); };
save();
const ADB = process.env.ADB || path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb');
const PKG = 'com.henokabraham.ct45tracker';
const adb = (...args) => execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const shell = (...args) => adb('shell', args.map(q).join(' '));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
async function until(fn, description, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (interrupted) throw new Error('Test interrupted');
    if (await fn()) return;
    await pause(300);
  }
  throw new Error(`Timed out: ${description}`);
}
const screen = () => adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
const launch = () => shell('am', 'start', '-W', '-n', `${PKG}/.MainActivity`);
const scan = (data) => shell('am', 'broadcast', '-a', `${PKG}.SCAN`, '--es', 'data', data);
const node = (xml, attribute, value) => xml.match(new RegExp(`<node[^>]*${attribute}="${value}"[^>]*>`))?.[0];
function tap(xml, attribute, value) {
  const bounds = node(xml, attribute, value)?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  assert.ok(bounds, `Control not found: ${value}`);
  shell('input', 'tap', String(Math.round((+bounds[1] + +bounds[3]) / 2)), String(Math.round((+bounds[2] + +bounds[4]) / 2)));
}
async function foreground() {
  shell('input', 'keyevent', 'KEYCODE_WAKEUP'); await pause(500); shell('wm', 'dismiss-keyguard'); launch();
  if (/Enter your (PIN|password)|Draw your pattern/i.test(screen())) throw new Error('Unlock the CT45 and leave the app open before running this test. Do not remove its screen lock.');
  await until(() => screen().includes(`${PKG}:id/connection_mode`), 'app connection control');
}
async function chooseMode(mode) {
  tap(screen(), 'resource-id', `${PKG}:id/connection_mode`);
  await pause(200); tap(screen(), 'text', `Connection: ${mode}`);
}
function background(on) {
  const xml = screen();
  const control = node(xml, 'resource-id', `${PKG}:id/background`);
  assert.ok(control, 'Background switch not found');
  if (control.includes('checked="true"') !== on) tap(xml, 'resource-id', `${PKG}:id/background`);
}
const model = shell('getprop', 'ro.product.model').trim();
assert.match(model, /^CT45/, 'This test is intended for a CT45');
report.model = model;
const identity = await loadIdentity(path.join(dir, 'identity.json'));
const token = newToken();
const prefix = `BT-TEST-${Date.now()}`;
let session = { id: 'bluetooth-test', name: 'Bluetooth testing — synthetic scans' };
let server, bridge, bluetooth;
let dropAck, failSave;
let originalBackground;
const originalWifi = shell('settings', 'get', 'global', 'wifi_on').trim() === '1';
const originalBluetooth = shell('settings', 'get', 'global', 'bluetooth_on').trim() === '1';
const originalStayOn = shell('settings', 'get', 'global', 'stay_on_while_plugged_in').trim();
const connected = () => server.devices().some((d) => d.transport === 'bluetooth');
const received = (value) => store.list().find((s) => s.data === value);
const waitReceived = (value) => until(() => received(value), `receive ${value.slice(0, 55)}`, 90000);
const acknowledged = () => until(() => node(screen(), 'resource-id', `${PKG}:id/last_scan_meta`)?.includes('Sent'), 'latest scan acknowledged');
const startBridge = async () => {
  bluetooth = null;
  bridge = startBluetooth({ serviceId: identity.id, executable: process.env.CT45_BT_HELPER || path.join(root, 'native/bin/ct45-bluetooth'), port: server.port,
    onState: (state) => { bluetooth = state; console.log(`Bluetooth: ${state.status}${state.message ? ` — ${state.message}` : ''}`); } });
  await until(() => bluetooth?.status === 'ready' || bluetooth?.status === 'error', 'Bluetooth service ready');
  assert.equal(bluetooth.status, 'ready', bluetooth.message);
};
const stopBridge = async () => { bridge?.stop(); await bridge?.closed; await until(() => !connected(), 'Bluetooth disconnect'); };
const link = (fingerprint = identity.fingerprint, hosts = ['192.0.2.1']) => pairingUrl({ hosts, port: server.port, token,
  computerId: identity.id, fingerprint, name: 'CT45 Bluetooth Test', bluetoothService: identity.id });
try {
  server = await startServer({ port: 18785, identity, getToken: () => token, getSession: () => session,
    computerName: () => 'CT45 Bluetooth Test', onScan: (scan) => {
      if (scan.data === failSave) { failSave = null; throw new Error('Injected test save failure'); }
      if (!store.add(scan)) duplicateDeliveries++;
      if (scan.data === dropAck) { dropAck = null; server.disconnectAll(1012, 'Injected lost acknowledgement'); }
    } });
  await startBridge();
  shell('pm', 'grant', PKG, 'android.permission.BLUETOOTH_CONNECT');
  shell('pm', 'grant', PKG, 'android.permission.BLUETOOTH_SCAN');
  shell('pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS');
  shell('cmd', 'bluetooth_manager', 'enable');
  await foreground();
  originalBackground = node(screen(), 'resource-id', `${PKG}:id/background`).includes('checked="true"');
  shell('svc', 'power', 'stayon', 'usb');
  await chooseMode('Bluetooth');
  fs.writeFileSync(path.join(dir, 'pairing.txt'), link(), { mode: 0o600 });
  scan(link());
  await until(connected, 'encrypted Bluetooth connection', 90000);
  pass('physical CT45 establishes certificate-pinned TLS over Bluetooth with an unreachable network address');
  const first = `${prefix}-first-000001`; scan(first); await waitReceived(first);
  assert.equal(received(first).sessionId, session.id);
  pass('scan arrives with its named session over Bluetooth');
  await acknowledged(); pass('CT45 receives the latest scan acknowledgement');

  shell('svc', 'wifi', 'disable');
  const withoutWifi = `${prefix}-wifi-off`; scan(withoutWifi); await waitReceived(withoutWifi);
  pass('Bluetooth delivery works with CT45 Wi-Fi disabled and no USB network tunnel');

  for (const value of ['000123456789012345678901234567890', '0100012345678905\u001d21Café 📦\n=SUM(A1)', 'L'.repeat(8192)]) {
    scan(value); await waitReceived(value);
    assert.equal(received(value).data, value);
  }
  await acknowledged(); pass('leading zeros, long numbers, GS1 separators, Unicode and an 8192-character barcode survive the radio link');

  scan(link('0'.repeat(64))); await until(() => !connected(), 'wrong-pin disconnect');
  const untrusted = `${prefix}-wrong-pin`; scan(untrusted); await pause(12000);
  assert.equal(connected(), false); assert.equal(received(untrusted), undefined);
  assert.ok(node(screen(), 'resource-id', `${PKG}:id/last_scan_meta`)?.includes('Waiting'));
  pass('incorrect certificate pin prevents authentication and leaves scans queued');
  scan(link()); await waitReceived(untrusted); await acknowledged();
  pass('correct pairing replays the queued scan');

  const lost = `${prefix}-lost-ack`; dropAck = lost; scan(lost);
  await until(() => duplicateDeliveries > 0, 'lost acknowledgement retransmission', 90000);
  await acknowledged();
  assert.equal(store.list().filter((s) => s.data === lost).length, 1);
  pass('lost acknowledgement triggers replay without duplicating the stored scan');
  const disk = `${prefix}-save-retry`; failSave = disk; scan(disk); await waitReceived(disk); await acknowledged();
  pass('desktop save failure is retried and acknowledged after recovery');

  const oldSession = session;
  await stopBridge();
  const backlog = Array.from({ length: 25 }, (_, n) => `${prefix}-queued-${String(n).padStart(4, '0')}`);
  for (const value of backlog) { scan(value); await pause(25); }
  assert.equal(backlog.some(received), false);
  shell('am', 'force-stop', PKG); await foreground();
  session = { id: 'bluetooth-next', name: 'Bluetooth test — next session' };
  await startBridge(); await waitReceived(backlog.at(-1)); await acknowledged();
  for (const value of backlog) assert.equal(received(value)?.sessionId, oldSession.id);
  assert.deepEqual(store.scans.filter((s) => backlog.includes(s.data)).map((s) => s.data), backlog);
  pass('25 offline scans survive an app restart and replay in order with their original session');
  await until(() => screen().includes(session.name), 'new session broadcast');
  const next = `${prefix}-new-session`; scan(next); await waitReceived(next);
  assert.equal(received(next).sessionId, session.id);
  pass('newly captured scans follow the new desktop session');

  shell('cmd', 'bluetooth_manager', 'disable'); await until(() => !connected(), 'CT45 adapter off');
  const radio = `${prefix}-radio-off`; scan(radio); await pause(1500); assert.equal(received(radio), undefined);
  shell('cmd', 'bluetooth_manager', 'enable'); await waitReceived(radio); await acknowledged();
  pass('CT45 Bluetooth off/on automatically reconnects and delivers queued scans');

  // An explicit USB fallback test, isolated to this server's port and removed immediately after.
  const usb = `tcp:${server.port}`;
  assert.ok(!adb('reverse', '--list').includes(usb), 'Test USB port must be unused');
  adb('reverse', usb, usb);
  try {
    scan(link(identity.fingerprint, ['127.0.0.1'])); await chooseMode('Wi-Fi / USB');
    await until(() => server.devices().some((d) => d.transport === 'network'), 'USB fallback');
    const value = `${prefix}-usb-fallback`; scan(value); await waitReceived(value);
    pass('switching from Bluetooth to encrypted USB fallback works');
    await chooseMode('Bluetooth'); scan(link()); await until(connected, 'switch back to Bluetooth');
  } finally { adb('reverse', '--remove', usb); }
  pass('switching back to Bluetooth restores the radio connection');

  background(true); shell('input', 'keyevent', 'KEYCODE_HOME'); shell('input', 'keyevent', 'KEYCODE_SLEEP');
  await pause(3000);
  const screenOff = `${prefix}-screen-off`; scan(screenOff); await waitReceived(screenOff);
  pass('background service receives and delivers a synthetic scan with the CT45 screen off');
  await stopBridge();
  const backgroundQueue = `${prefix}-background-reconnect`; scan(backgroundQueue);
  await pause(2000); await startBridge(); await waitReceived(backgroundQueue);
  pass('screen-off background mode reconnects after the Mac Bluetooth service restarts');

  if (hours > 0) {
    report.status = 'soaking'; report.soakStarted = new Date().toISOString();
    const end = Date.now() + hours * 3600000;
    report.soakEnds = new Date(end).toISOString(); report.soakCycles = 0; save();
    while (Date.now() < end) {
      const cycle = ++report.soakCycles;
      const value = `${prefix}-soak-${String(cycle).padStart(5, '0')}`;
      if (cycle % 15 === 0) { await stopBridge(); scan(value); await pause(3000); await startBridge(); }
      else scan(value);
      await waitReceived(value); report.lastSoakDelivery = new Date().toISOString(); save();
      if (cycle % 15 === 0) console.log(`Soak healthy: ${cycle} cycles, ${store.list().length} scans`);
      while (Date.now() < end && Date.now() < Date.parse(report.lastSoakDelivery) + 120000) {
        if (interrupted) throw new Error('Test interrupted');
        await pause(1000);
      }
    }
    pass(`${hours}-hour screen-off Bluetooth soak with periodic disconnects completed`);
  }
  const persisted = new ScanStore(path.join(dir, 'received.jsonl')).load().list();
  assert.equal(persisted.length, store.list().length);
  pass('all received scans remain present after reloading the desktop log');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; console.error(error);
  try { fs.writeFileSync(path.join(dir, 'failure-screen.xml'), screen(), { mode: 0o600 }); } catch {}
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString(); save();
  bridge?.stop(); await server?.close();
  try {
    if (originalWifi) shell('svc', 'wifi', 'enable');
    if (!originalBluetooth) shell('cmd', 'bluetooth_manager', 'disable');
    if (originalStayOn === 'null') shell('settings', 'delete', 'global', 'stay_on_while_plugged_in');
    else shell('settings', 'put', 'global', 'stay_on_while_plugged_in', originalStayOn);
    if (originalBackground !== undefined) { await foreground(); background(originalBackground); }
  } catch (error) {
    report.cleanupError = error.message;
    // A PIN lock can prevent restoring the switch. If background mode was originally off,
    // stop this test app so it releases the scanner and does not retry all night after exit.
    if (originalBackground === false) {
      try { shell('am', 'force-stop', PKG); report.appStopped = true; } catch {}
    }
    save();
  }
}
