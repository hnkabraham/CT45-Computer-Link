// Android feature/regression tests against the production desktop TLS server.
// Requires a DISPOSABLE emulator: reinstalls the debug app and seeds its private test log.
// ANDROID_SERIAL=emulator-5580 SCREENSHOT_DIR=../docs/images/v2.1 node scripts/android-polish-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { createIdentity, fingerprint } from '../src/identity.js';
import { newToken, pairingUrl } from '../src/protocol.js';
import { startServer } from '../src/server.js';

const serial = process.env.ANDROID_SERIAL;
if (!serial?.startsWith('emulator-')) throw new Error('Select a disposable emulator with ANDROID_SERIAL.');
const ADB = process.env.ADB || path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb');
const PKG = 'com.henokabraham.ct45tracker';
const adb = (...args) => execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 20 << 20 });
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const shell = (...args) => adb('shell', args.map(q).join(' '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(350); }
  throw new Error(`Timed out: ${label}`);
}
function check(label, ok) { if (!ok) throw new Error(`FAIL ${label}`); console.log(`PASS ${label}`); }
function screen() {
  // Android can briefly return a null accessibility root during a window transition.
  let xml = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
    if (xml.includes('<hierarchy')) break;
  }
  if (!xml.includes('<hierarchy')) throw new Error('Android accessibility snapshot unavailable');
  return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => {
    const attr = (name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] || '';
    const b = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    return { id: attr('resource-id').replace(`${PKG}:id/`, ''), text: attr('text').replaceAll('&amp;', '&').replaceAll('&apos;', "'"),
      bounds: b && b.slice(1).map(Number), center: b && [(+b[1] + +b[3]) >> 1, (+b[2] + +b[4]) >> 1] };
  });
}
function findControl(predicate) {
  let nodes = screen(), found = nodes.find(predicate);
  if (found) return found;
  const list = nodes.find((n) => n.id === 'recent')?.bounds;
  if (!list) return null;
  const x = (list[0] + list[2]) >> 1, high = Math.round(list[1] + (list[3] - list[1]) * .25), low = Math.round(list[1] + (list[3] - list[1]) * .75);
  // Start at the header, then use overlapping drags so short rows cannot be skipped.
  for (let i = 0; i < 3; i++) shell('input', 'swipe', String(x), String(high), String(x), String(low), '500');
  for (let i = 0; i < 7; i++) {
    nodes = screen(); found = nodes.find(predicate); if (found) return found;
    shell('input', 'swipe', String(x), String(low), String(x), String(high), '500');
  }
  return null;
}
const ui = (id) => findControl((n) => n.id === id)?.text || '';
function tap(predicate) {
  const node = findControl(predicate);
  if (!node?.center) throw new Error('Control not found');
  shell('input', 'tap', ...node.center.map(String));
}
const tapId = (id) => tap((n) => n.id === id);
const tapText = (text) => tap((n) => n.text.toLowerCase() === text.toLowerCase());
const launch = () => shell('am', 'start', '-W', '-n', `${PKG}/.MainActivity`);
const scan = (data) => shell('am', 'broadcast', '-a', `${PKG}.SCAN`, '--ei', 'version', '1', '--es', 'data', data, '--es', 'aimId', ']C0', '--es', 'codeId', 'j');
const shots = process.env.SCREENSHOT_DIR;
function screenshot(name) {
  if (!shots) return;
  screen(); // Wait for the UI to settle, including dialog animations, before capturing.
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, name + '.png'), execFileSync(ADB, ['-s', serial, 'exec-out', 'screencap', '-p']));
}

check('target is an emulator', shell('getprop', 'ro.kernel.qemu').trim() === '1');
await until(() => shell('getprop', 'sys.boot_completed').trim() === '1', 'emulator boot');
try { adb('uninstall', PKG); } catch {}
adb('install', '-r', '../android/app/build/outputs/apk/debug/app-debug.apk');
for (const permission of ['BLUETOOTH_CONNECT', 'BLUETOOTH_SCAN']) shell('pm', 'grant', PKG, `android.permission.${permission}`);
const originalFontScale = shell('settings', 'get', 'system', 'font_scale').trim();
const originalName = shell('settings', 'get', 'global', 'device_name').trim();
const originalSize = shell('wm', 'size').match(/Override size: (.+)/)?.[1] || 'reset';
const originalDensity = shell('wm', 'density').match(/Override density: (.+)/)?.[1] || 'reset';
shell('settings', 'put', 'global', 'device_name', 'D'.repeat(101));
shell('cmd', 'uimode', 'night', 'no');
shell('input', 'keyevent', 'KEYCODE_WAKEUP');
shell('wm', 'dismiss-keyguard');

// Simulate a queue saved by an older build, before oversized-input validation existed.
const old = (id, data) => ({ id, data, scannedAt: 1, sent: false, aimId: ']C0', codeId: 'j', sessionId: 'default', sessionName: 'General' });
const xml = `<?xml version="1.0" encoding="utf-8"?><map><string name="scans">${JSON.stringify([old('valid-old', 'QUEUED-VALID'), old('oversized-old', 'X'.repeat(70000))])}</string></map>`;
shell('run-as', PKG, 'mkdir', '-p', 'shared_prefs');
execFileSync(ADB, ['-s', serial, 'shell', ['run-as', PKG, 'sh', '-c', 'cat > shared_prefs/ct45tracker.xml'].map(q).join(' ')], { input: xml });
const identity = await createIdentity();
const token = newToken();
const received = [];
const sessions = [{ id: 'default', name: 'General' }, { id: 'warehouse', name: 'Warehouse count' }];
let active = sessions[0];
let server;
async function startDesktop() {
  server = await startServer({ port: 18796, portAttempts: 1, identity, getToken: () => token,
    computerName: () => 'Demo Computer', getSession: () => active, getSessions: () => sessions,
    onSelectSession: (id) => { active = sessions.find((s) => s.id === id); server.sessionChanged(); },
    onScan: (s) => received.push(s) });
}
const pair = () => scan(pairingUrl({ hosts: ['10.0.2.2'], port: 18796, token, name: 'Demo Computer', computerId: identity.id, fingerprint: fingerprint(new X509Certificate(identity.cert).raw) }));
try {
  await startDesktop(); launch();
  await until(() => ui('status_title') === 'Not connected', 'initial screen');
  pair();
  await until(() => received.some((s) => s.data === 'QUEUED-VALID'), 'valid scan behind oversized entry');
  await until(() => ui('status_title') === 'Connected to Demo Computer', 'connected state after queue recovery');
  check('an old oversized entry cannot block later scans', received.every((s) => s.id === 'valid-old'));
  check('long device name is bounded and connects', server.devices()[0].device.length === 100);
  // One character over the app limit; larger command arguments exceed adb's shell limit.
  scan('X'.repeat(8193)); await sleep(800);
  check('new oversized input is rejected without disconnecting', received.length === 1 && server.devices().length === 1);
  tapId('session_mode');
  check('shared-session effect is explained', screen().some((n) => n.text.includes('every scanner')));
  tapText('Warehouse count'); tapText('Change session');
  await until(() => active.id === 'warehouse' && ui('session_mode').includes('Warehouse count'), 'remote session selection');
  scan('IN-WAREHOUSE');
  await until(() => received.some((s) => s.data === 'IN-WAREHOUSE'), 'scan after session change');
  check('handheld selects the session for new scans', received.find((s) => s.data === 'IN-WAREHOUSE').sessionId === 'warehouse');

  await server.close(); server = null;
  await until(() => ui('status_title').startsWith("Can't reach"), 'offline state');
  check('disabled session selection explains why', ui('session_hint').includes('Connect to the computer'));
  tapId('connection_help');
  check('network help includes USB forwarding', screen().some((n) => n.text.includes('adb reverse')));
  shell('input', 'keyevent', 'KEYCODE_BACK');
  tapId('retry_now');
  await until(() => ui('status_title').startsWith("Can't reach"), 'manual retry returns to offline state');
  scan('WAITING-KEEP'); scan('WAITING-DISCARD');
  await until(() => ui('waiting_status').includes('2 scans'), 'separate waiting count');
  tap((n) => n.id === 'data' && n.text === 'WAITING-DISCARD');
  tapText('Discard locally');
  check('discard warns about possible previous delivery', screen().some((n) => n.text.includes('may already have received')));
  tapText('Discard locally');
  await until(() => ui('last_scan_meta').includes('Discarded locally'), 'discard marker');
  shell('am', 'force-stop', PKG); launch();
  check('discard marker survives restart', ui('last_scan_meta').includes('Discarded locally'));
  active = sessions[0]; await startDesktop();
  await until(() => received.some((s) => s.data === 'WAITING-KEEP'), 'remaining queue delivery');
  check('discarded scan is not retried and waiting scan keeps its session', !received.some((s) => s.data === 'WAITING-DISCARD') && received.find((s) => s.data === 'WAITING-KEEP').sessionId === 'warehouse');

  tapId('connection_mode'); tapText('Bluetooth');
  await until(() => ui('status_title') === 'Choose a connection', 'guided connection choice');
  check('missing Bluetooth endpoint offers an action instead of a false retry', !ui('status_detail').includes('Retrying automatically') && !!ui('use_network'));
  screenshot('ct45-android-connection-recovery');
  tapId('connection_help');
  check('Bluetooth help explains permissions and desktop support', screen().some((n) => n.text.includes('Nearby devices') && n.text.includes('Windows')));
  shell('input', 'keyevent', 'KEYCODE_BACK');
  tapId('use_network');
  await until(() => ui('status_title') === 'Connected to Demo Computer', 'guided network reconnection');
  const since = server.devices()[0].since;
  tapId('connection_mode'); tapText('Wi-Fi / USB'); await sleep(500);
  check('choosing the active transport preserves the connection', server.devices()[0].since === since);

  // Fresh synthetic examples for the public gallery, without the recovery test's large row.
  shell('am', 'force-stop', PKG); shell('pm', 'clear', PKG);
  active = sessions[1]; launch(); pair();
  await until(() => ui('status_title') === 'Connected to Demo Computer', 'gallery connection');
  for (const data of ['0000123456789', '12345678901234567890', 'BIN-A-0042']) scan(data);
  await until(() => ui('last_scan_meta').includes(' · Sent ·'), 'gallery acknowledgements');
  check('compact view keeps the session and scans prominent', ui('session_mode').includes('Warehouse count') && !screen().some((n) => n.id === 'background'));
  tapId('nav_scan');
  check('Scan has a deliberate manual-entry action', screen().some((n) => n.id === 'manual_toggle') && !screen().some((n) => n.id === 'manual'));
  await sleep(3000); screenshot('ct45-android-connected');
  tapId('nav_history');
  check('History exposes scan rows without the latest-scan card', screen().some((n) => n.id === 'data') && !screen().some((n) => n.id === 'last_scan'));
  screenshot('ct45-android-history');
  tapId('nav_scan');
  tapId('settings_toggle');
  check('Settings hides the scan history', !screen().some((n) => n.id === 'data'));
  check('scanning settings disclose feedback off by default', ui('feedback_mode').endsWith('Off') && screen().some((n) => n.id === 'background'));
  screenshot('ct45-android-settings');
  tapId('feedback_mode');
  check('feedback explains received versus saved waiting', screen().some((n) => n.text.includes('Received by computer') && n.text.includes('still waiting')));
  screenshot('ct45-android-feedback');
  tapText('Vibration');
  check('feedback choice is reflected in settings', ui('feedback_mode').endsWith('Vibration'));
  shell('am', 'force-stop', PKG); launch();
  await until(() => ui('status_title') === 'Connected to Demo Computer', 'reconnect after feedback preference restart');
  tapId('settings_toggle');
  check('feedback preference survives restart', ui('feedback_mode').endsWith('Vibration'));
  tapId('feedback_mode'); tapText('Off'); tapId('nav_scan');
  tapId('connection_mode'); screenshot('ct45-android-connection-options'); shell('input', 'keyevent', 'KEYCODE_BACK');
  tapId('session_mode'); screenshot('ct45-android-sessions'); shell('input', 'keyevent', 'KEYCODE_BACK');
  shell('cmd', 'uimode', 'night', 'yes'); launch(); await sleep(2000); screenshot('ct45-android-dark');
  shell('cmd', 'uimode', 'night', 'no'); launch();
  await server.close(); server = null;
  await until(() => ui('status_title').startsWith("Can't reach"), 'gallery offline state');
  scan('BIN-A-0043');
  await until(() => ui('last_scan_meta').includes(' · Waiting ·'), 'gallery waiting scan');
  screenshot('ct45-android-waiting');
  tap((n) => n.id === 'data' && n.text === 'BIN-A-0043'); screenshot('ct45-android-queue-actions');
  tapText('Copy barcode'); tapId('manual_toggle'); tapId('manual'); screen(); // Let the keyboard finish opening.
  // Deliver Paste to the focused EditText rather than the emulator's input method.
  shell('input', 'keyevent', 'KEYCODE_BACK'); screen();
  shell('input', 'keyevent', 'KEYCODE_PASTE');
  await until(() => ui('manual') === 'BIN-A-0043', 'pasted barcode');
  check('Android Copy preserves the barcode text', ui('manual') === 'BIN-A-0043');
  shell('input', 'keyevent', 'KEYCODE_MOVE_END');
  shell('input', 'keyevent', ...Array(10).fill('KEYCODE_DEL'));
  // Keep input usable when the status/help content exceeds a short handheld screen.
  shell('wm', 'size', '720x1280'); shell('wm', 'density', '320'); launch();
  await until(() => !!ui('status_title'), 'compact layout');
  const compact = screen();
  check('compact layout keeps barcode entry and Send visible', ['manual', 'send'].every((id) => {
    const b = compact.find((n) => n.id === id)?.bounds;
    return b && b[3] - b[1] >= 96 && b[3] <= 1232;
  }));
  check('small screen can scroll to recent scans', !!findControl((n) => n.id === 'data' && n.text === 'BIN-A-0043'));
  tap((n) => n.id === 'data' && n.text === 'BIN-A-0043');
  check('compact layout can scroll to queue actions', screen().some((n) => n.text.toLowerCase() === 'discard locally'));
  shell('input', 'keyevent', 'KEYCODE_BACK');
  screenshot('ct45-android-compact');
  tapId('manual_close');
  tapId('nav_scan');
  check('entry can close without hiding Scan navigation', screen().some((n) => n.id === 'manual_toggle') && screen().some((n) => n.id === 'nav_scan'));
  shell('input', 'text', 'WEDGE-001');
  await until(() => ui('manual') === 'WEDGE-001', 'hardware-keyboard fallback reveals input');
  check('keyboard wedge fallback opens entry and keeps exact text', ui('manual') === 'WEDGE-001');
  tapId('manual_close');
  tapId('nav_history');
  shell('settings', 'put', 'system', 'font_scale', '1.3'); launch();
  check('larger text keeps navigation reachable', ['nav_scan', 'nav_history', 'settings_toggle'].every((id) => screen().some((n) => n.id === id)));
  screenshot('ct45-android-large-text');
  if (originalFontScale === 'null') shell('settings', 'delete', 'system', 'font_scale');
  else shell('settings', 'put', 'system', 'font_scale', originalFontScale);
  tapId('nav_scan'); screenshot('ct45-android-small-scan');
  console.log('All Android polish checks passed');
} finally {
  if (server) await server.close();
  shell('am', 'force-stop', PKG);
  if (originalFontScale === 'null') shell('settings', 'delete', 'system', 'font_scale');
  else shell('settings', 'put', 'system', 'font_scale', originalFontScale);
  if (originalName === 'null') shell('settings', 'delete', 'global', 'device_name');
  else shell('settings', 'put', 'global', 'device_name', originalName);
  shell('wm', 'size', originalSize); shell('wm', 'density', originalDensity);
}
