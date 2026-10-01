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
import { newToken, pairingUrl, parsePairingUrl } from '../src/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serial = process.env.ANDROID_SERIAL;
if (!serial || process.env.CT45_HARDWARE_TEST !== '1') throw new Error('Set ANDROID_SERIAL and CT45_HARDWARE_TEST=1 for the connected test device.');
const hours = Number(process.env.CT45_SOAK_HOURS || 0);
// Locking a managed device may require its owner's PIN again. Background tests normally use
// the Home screen; opt into deliberate screen-off testing only when an unlock is available.
const screenOff = process.env.CT45_SCREEN_OFF_TEST === '1';
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
const screen = () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
    if (xml.includes('<hierarchy')) return xml;
  }
  throw new Error('Android accessibility snapshot unavailable');
};
const launch = () => shell('am', 'start', '-W', '-n', `${PKG}/.MainActivity`);
const scan = (data) => shell('am', 'broadcast', '-a', `${PKG}.SCAN`, '--es', 'data', data);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const node = (xml, attribute, value) => xml.match(new RegExp(`<node[^>]*${attribute}="${escapeRegex(value)}"[^>]*>`, 'i'))?.[0];
const boundsOf = (control) => control?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)?.slice(1).map(Number);
function seek(attribute, value, direction = 'up', find = (xml) => node(xml, attribute, value)) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const xml = screen(), control = find(xml), bounds = boundsOf(control);
    if (bounds && bounds[2] > bounds[0] && bounds[3] > bounds[1]) return xml;
    const list = boundsOf(node(xml, 'resource-id', `${PKG}:id/recent`));
    assert.ok(list, `App list unavailable while seeking ${value}; unlock or management action may be required`);
    // Slow, overlapping drags avoid a fling skipping the row we are trying to inspect.
    const x = Math.round((list[0] + list[2]) / 2), high = Math.round(list[1] + (list[3] - list[1]) * .3), low = Math.round(list[1] + (list[3] - list[1]) * .7);
    shell('input', 'swipe', String(x), String(direction === 'up' ? high : low), String(x), String(direction === 'up' ? low : high), '600');
  }
  throw new Error(`Control not visible: ${value}`);
}
const seekId = (id, direction) => {
  if (direction || id === 'connection_mode') return seek('resource-id', `${PKG}:id/${id}`, direction);
  const xml = screen(), b = boundsOf(node(xml, 'resource-id', `${PKG}:id/${id}`));
  if (b && b[3] > b[1]) return xml;
  seek('resource-id', `${PKG}:id/connection_mode`, 'up');
  return seek('resource-id', `${PKG}:id/${id}`, 'down');
};
const tapId = (id, direction) => tap(seekId(id, direction), 'resource-id', `${PKG}:id/${id}`);
const tapText = (text) => tap(screen(), 'text', text);
function tap(xml, attribute, value) {
  tapControl(node(xml, attribute, value));
}
function tapControl(control) {
  const bounds = boundsOf(control);
  assert.ok(bounds, 'Control not found');
  shell('input', 'tap', String(Math.round((bounds[0] + bounds[2]) / 2)), String(Math.round((bounds[1] + bounds[3]) / 2)));
}
async function foreground() {
  launch();
  if (/Enter your (PIN|password)|Draw your pattern/i.test(screen())) throw new Error('Unlock the CT45 and leave the app open before running this test. Do not remove its screen lock.');
  seekId('connection_mode');
}
async function chooseMode(mode) {
  tapId('connection_mode');
  await pause(200); tapText(mode);
}
function background(on = undefined) {
  let xml = seekId('settings_toggle');
  const toggle = node(xml, 'resource-id', `${PKG}:id/settings_toggle`);
  const expanded = toggle?.includes('text="Hide scanning settings"');
  if (!expanded) tap(xml, 'resource-id', `${PKG}:id/settings_toggle`);
  xml = seekId('background', 'down');
  const control = node(xml, 'resource-id', `${PKG}:id/background`);
  assert.ok(control, 'Background switch not found');
  const current = control.includes('checked="true"');
  if (on !== undefined && current !== on) {
    tap(xml, 'resource-id', `${PKG}:id/background`);
    assert.equal(node(seekId('background', 'down'), 'resource-id', `${PKG}:id/background`).includes('checked="true"'), on, 'Background preference did not persist');
  }
  if (!expanded) tapId('settings_toggle');
  return current;
}
const model = shell('getprop', 'ro.product.model').trim();
assert.match(model, /^CT45/, 'This test is intended for a CT45');
report.model = model;
const existingProfile = process.env.CT45_EXISTING_TEST_PROFILE;
const originalPairing = existingProfile ? fs.readFileSync(path.join(existingProfile, 'pairing.txt'), 'utf8').trim() : null;
const originalPair = originalPairing ? parsePairingUrl(originalPairing) : null;
const identity = await loadIdentity(path.join(existingProfile || dir, 'identity.json'));
if (originalPairing) {
  assert.equal(originalPair?.computerId, identity.id);
  assert.equal(originalPair?.fingerprint, identity.fingerprint);
  assert.deepEqual(originalPair?.hosts, ['192.0.2.1'], 'Only an existing Bluetooth-only disposable test profile can be reused');
}
const token = originalPair?.token || newToken();
const prefix = `BT-TEST-${Date.now()}`;
let session = { id: 'bluetooth-test', name: 'Bluetooth testing — synthetic scans' };
const sessions = [session, { id: 'bluetooth-next', name: 'Bluetooth test — next session' }];
let server, bridge, bluetooth;
let dropAck, failSave;
let originalBackground;
let originalBluetoothMode;
const originalWifi = shell('settings', 'get', 'global', 'wifi_on').trim() === '1';
const originalBluetooth = shell('settings', 'get', 'global', 'bluetooth_on').trim() === '1';
const originalStayOn = shell('settings', 'get', 'global', 'stay_on_while_plugged_in').trim();
const connected = () => server.devices().some((d) => d.transport === 'bluetooth');
const received = (value) => store.list().find((s) => s.data === value);
const waitReceived = (value) => until(() => received(value), `receive ${value.slice(0, 55)}`, 90000);
const acknowledged = () => until(() => node(seekId('last_scan_meta'), 'resource-id', `${PKG}:id/last_scan_meta`)?.includes('Sent'), 'latest scan acknowledged');
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
  server = await startServer({ port: originalPair?.port || 18785, portAttempts: 1, identity, getToken: () => token, getSession: () => session,
    getSessions: () => sessions, onSelectSession: (id) => { session = sessions.find((s) => s.id === id); server.sessionChanged(); },
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
  originalBluetoothMode = node(screen(), 'resource-id', `${PKG}:id/connection_mode`)?.includes('content-desc="Change connection: Bluetooth"');
  originalBackground = background();
  // Some CT45 USB docks report AC power. Cover every charging source, then restore it.
  shell('svc', 'power', 'stayon', 'true');
  await chooseMode('Bluetooth');
  fs.writeFileSync(path.join(dir, 'pairing.txt'), link(), { mode: 0o600 });
  scan(link());
  await until(connected, 'encrypted Bluetooth connection', 90000);
  pass('physical CT45 establishes certificate-pinned TLS over Bluetooth with an unreachable network address');
  const first = `${prefix}-first-000001`; scan(first); await waitReceived(first);
  assert.equal(received(first).sessionId, session.id);
  pass('scan arrives with its named session over Bluetooth');
  await acknowledged(); pass('CT45 receives the latest scan acknowledgement');

  shell('cmd', 'bluetooth_manager', 'disable');
  // Honeywell may retain the physical LE radio in BLE_ON for system scanning. Verify the
  // public switch and our app's response, rather than waiting for a stale desktop peer list.
  await until(() => /enabled: false/.test(shell('dumpsys', 'bluetooth_manager')), 'CT45 adapter switch off', 20000);
  await until(() => !node(seekId('status_title'), 'resource-id', `${PKG}:id/status_title`)?.includes('Connected to'), 'app respects disabled Bluetooth', 20000);
  const radio = `${prefix}-radio-off`; scan(radio); await pause(3000); assert.equal(received(radio), undefined);
  shell('cmd', 'bluetooth_manager', 'enable'); await waitReceived(radio); await acknowledged();
  pass('CT45 Bluetooth off/on automatically reconnects and delivers queued scans');

  tapId('session_mode');
  assert.ok(screen().includes('every scanner'), 'Session picker must explain shared selection');
  tapText(sessions[1].name); tapText('Change session');
  await until(() => session.id === sessions[1].id, 'handheld session selection');
  const selected = `${prefix}-selected-session`; scan(selected); await waitReceived(selected);
  assert.equal(received(selected).sessionId, sessions[1].id);
  tapId('session_mode'); tapText(sessions[0].name); tapText('Change session');
  await until(() => session.id === sessions[0].id, 'restore first session');
  pass('handheld selects an existing shared session and new scans use it');

  shell('svc', 'wifi', 'disable');
  const withoutWifi = `${prefix}-wifi-off`; scan(withoutWifi); await waitReceived(withoutWifi);
  pass('Bluetooth delivery works with CT45 Wi-Fi disabled and no USB network tunnel');
  // The unreachable pairing host still proves Bluetooth isolation. Restore normal network
  // access promptly, including the device's ordinary management-policy communication.
  if (originalWifi) shell('svc', 'wifi', 'enable');

  for (const value of ['000123456789012345678901234567890', '0100012345678905\u001d21Café 📦\n=SUM(A1)', 'L'.repeat(8192)]) {
    scan(value); await waitReceived(value);
    assert.equal(received(value).data, value);
  }
  await acknowledged(); pass('leading zeros, long numbers, GS1 separators, Unicode and an 8192-character barcode survive the radio link');

  scan(link('0'.repeat(64))); await until(() => !connected(), 'wrong-pin disconnect');
  const untrusted = `${prefix}-wrong-pin`; scan(untrusted); await pause(12000);
  assert.equal(connected(), false); assert.equal(received(untrusted), undefined);
  assert.ok(node(seekId('last_scan_meta'), 'resource-id', `${PKG}:id/last_scan_meta`)?.includes('Waiting'));
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
  await until(() => node(seekId('session_hint'), 'resource-id', `${PKG}:id/session_hint`)?.includes('Connect to the computer'), 'disabled session explanation');
  tapId('connection_help');
  assert.ok(screen().includes('Nearby devices'), 'Bluetooth help must explain permission recovery');
  shell('input', 'keyevent', 'KEYCODE_BACK');
  tapId('retry_now');
  pass('offline session explanation, Bluetooth help and manual retry remain accessible');
  const discarded = `${prefix}-discarded`; scan(discarded);
  seekId('connection_mode');
  const findDiscardRow = (xml) => [...xml.matchAll(/<node[^>]*>/g)].map(([tag]) => tag).find((tag) => tag.includes(`resource-id="${PKG}:id/data"`) && tag.includes(`text="${discarded}"`));
  tapControl(findDiscardRow(seek('text', discarded, 'down', findDiscardRow))); tapText('Discard locally');
  assert.ok(screen().includes('may already have received'), 'Discard confirmation must explain lost acknowledgements');
  tapText('Discard locally');
  await until(() => node(seekId('last_scan_meta'), 'resource-id', `${PKG}:id/last_scan_meta`)?.includes('Discarded locally'), 'durable discard marker');
  const backlog = Array.from({ length: 25 }, (_, n) => `${prefix}-queued-${String(n).padStart(4, '0')}`);
  for (const value of backlog) { scan(value); await pause(25); }
  assert.equal(backlog.some(received), false);
  shell('am', 'force-stop', PKG); await foreground();
  session = sessions[1];
  await startBridge(); await waitReceived(backlog.at(-1)); await acknowledged();
  for (const value of backlog) assert.equal(received(value)?.sessionId, oldSession.id);
  assert.deepEqual(store.scans.filter((s) => backlog.includes(s.data)).map((s) => s.data), backlog);
  pass('25 offline scans survive an app restart and replay in order with their original session');
  assert.equal(received(discarded), undefined);
  pass('confirmed local discard prevents replay after process restart');
  await until(() => screen().includes(session.name), 'new session broadcast');
  const next = `${prefix}-new-session`; scan(next); await waitReceived(next);
  assert.equal(received(next).sessionId, session.id);
  pass('newly captured scans follow the new desktop session');

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

  background(true); shell('input', 'keyevent', 'KEYCODE_HOME');
  if (screenOff) shell('input', 'keyevent', 'KEYCODE_SLEEP');
  await pause(3000);
  const backgroundScan = `${prefix}-background`; scan(backgroundScan); await waitReceived(backgroundScan);
  pass(`background service delivers a synthetic scan ${screenOff ? 'with the CT45 screen off' : 'while the Home screen is visible'}`);
  await stopBridge();
  const backgroundQueue = `${prefix}-background-reconnect`; scan(backgroundQueue);
  await pause(2000); await startBridge(); await waitReceived(backgroundQueue);
  pass(`background mode reconnects after the Mac Bluetooth service restarts (${screenOff ? 'screen off' : 'Home screen visible'})`);

  if (hours > 0) {
    report.status = 'soaking'; report.soakStarted = new Date().toISOString();
    const end = Date.now() + hours * 3600000;
    report.soakEnds = new Date(end).toISOString(); report.soakCycles = 0; report.soakRestarts = 0; save();
    while (Date.now() < end) {
      const cycle = ++report.soakCycles;
      const value = `${prefix}-soak-${String(cycle).padStart(5, '0')}`;
      if (cycle % 15 === 0) { await stopBridge(); scan(value); await pause(3000); await startBridge(); report.soakRestarts++; }
      else scan(value);
      await waitReceived(value); report.lastSoakDelivery = new Date().toISOString(); save();
      if (cycle % 15 === 0) console.log(`Soak healthy: ${cycle} cycles, ${store.list().length} scans`);
      while (Date.now() < end && Date.now() < Date.parse(report.lastSoakDelivery) + 120000) {
        if (interrupted) throw new Error('Test interrupted');
        await pause(1000);
      }
    }
    pass(`${hours}-hour background Bluetooth scan soak completed with ${report.soakRestarts} planned helper restarts (${screenOff ? 'screen off' : 'Home screen visible'})`);
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
  const cleanupErrors = [];
  const restore = async (name, fn) => { try { await fn(); } catch (error) { cleanupErrors.push(`${name}: ${error.message}`); } };
  await restore('Wi-Fi', () => shell('svc', 'wifi', originalWifi ? 'enable' : 'disable'));
  await restore('stay awake', () => originalStayOn === 'null' ? shell('settings', 'delete', 'global', 'stay_on_while_plugged_in') : shell('settings', 'put', 'global', 'stay_on_while_plugged_in', originalStayOn));
  await restore('app preferences', async () => {
    if (originalBackground !== undefined) {
      await foreground(); background(originalBackground);
      if (originalPairing) scan(originalPairing);
      if (originalBluetoothMode !== undefined) await chooseMode(originalBluetoothMode ? 'Bluetooth' : 'Wi-Fi / USB');
    }
  });
  bridge?.stop(); await bridge?.closed; await server?.close();
  await restore('Bluetooth', () => shell('cmd', 'bluetooth_manager', originalBluetooth ? 'enable' : 'disable'));
  await restore('Home screen', () => shell('input', 'keyevent', 'KEYCODE_HOME'));
  if (cleanupErrors.length) {
    report.cleanupError = cleanupErrors.join('\n');
    if (report.status === 'passed') report.status = 'checks-passed-cleanup-incomplete';
    process.exitCode = 1;
    if (originalBackground === false) { try { shell('am', 'force-stop', PKG); report.appStopped = true; } catch {} }
  }
  report.finished = new Date().toISOString(); save();
}
