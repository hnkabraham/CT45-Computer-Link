// Runs the Android app on an emulator (or a USB-connected device) against the desktop server
// code, sending scans the way the CT45's scanner does. Build the APK first:
//   (cd ../android && ./gradlew assembleDebug) && npm run android-e2e
// The emulator reaches this computer at 10.0.2.2. On a real device set HOST to this
// computer's LAN address. SCREENSHOT_DIR=/some/dir keeps screenshots.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { newToken, pairingUrl } from '../src/protocol.js';
import { CLOSE_REPAIRED, startServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADB = process.env.ADB ?? path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb');
const APK = path.join(here, '../../android/app/build/outputs/apk/debug/app-debug.apk');
const PKG = 'com.henokabraham.ct45tracker';
const HOST = process.env.HOST ?? '10.0.2.2';
const PORT = 18766;
const shots = process.env.SCREENSHOT_DIR;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(250);
  }
  return false;
}

const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 20 << 20 });
// adb shell joins its arguments into one remote command line, so quote each one.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const shell = (...args) => adb('shell', args.map(q).join(' '));

// Exactly what Honeywell's service broadcasts for a scan: implicit, no target package.
function scan(data, { aimId = ']C0', codeId = 'j' } = {}) {
  shell('am', 'broadcast', '-a', `${PKG}.SCAN`, '--ei', 'version', '1', '--es', 'data', data, '--es', 'aimId', aimId, '--es', 'codeId', codeId);
}

function screen() {
  const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
  const nodes = [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
    const attr = (name) => (new RegExp(`${name}="([^"]*)"`).exec(m[0]) ?? [])[1] ?? '';
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'));
    return {
      text: attr('text').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
      id: attr('resource-id').replace(`${PKG}:id/`, ''),
      center: b ? [(+b[1] + +b[3]) >> 1, (+b[2] + +b[4]) >> 1] : null,
    };
  });
  return { nodes, text: (id) => nodes.find((n) => n.id === id)?.text ?? null, has: (t) => nodes.some((n) => n.text.includes(t)) };
}

function screenshot(name) {
  if (shots) fs.writeFileSync(path.join(shots, name), execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 50 << 20 }));
}

function launchApp() {
  shell('am', 'start', '-W', '-n', `${PKG}/.MainActivity`);
}

// The desktop side: the same server code the Electron app runs.
const received = [];
let token = newToken();
let server;
async function startDesktop() {
  server = await startServer({
    port: PORT,
    portAttempts: 1,
    getToken: () => token,
    computerName: () => 'Test Mac',
    onScan: (s) => received.push(s),
  });
}
const link = () => pairingUrl({ hosts: [HOST], port: PORT, token, name: 'Test Mac' });

// A computer that misbehaves on purpose. 'silent': accepts the connection and never answers a
// scan, like a laptop whose Wi-Fi died without closing anything. 'reject': refuses every scan.
async function startFakeDesktop(port, mode) {
  const wss = new WebSocketServer({ port });
  await new Promise((r) => wss.once('listening', r));
  const fake = { connections: 0, scans: [], wss, link: pairingUrl({ hosts: [HOST], port, token: 'fake-token', name: 'Fake Mac' }) };
  wss.on('connection', (ws) => {
    fake.connections++;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'welcome', name: 'Fake Mac', version: 1 }));
      if (m.type === 'scan') {
        fake.scans.push(m.data);
        if (mode === 'reject') ws.send(JSON.stringify({ type: 'error', code: 'bad-message', message: 'no', id: m.id }));
      }
    });
  });
  fake.close = () => new Promise((r) => {
    for (const c of wss.clients) c.terminate();
    wss.close(r);
  });
  return fake;
}

// Boot, install, fresh state
execFileSync(ADB, ['wait-for-device']);
await until(() => shell('getprop', 'sys.boot_completed').trim() === '1', 180_000);
adb('install', '-r', APK);
shell('pm', 'clear', PKG);
shell('cmd', 'uimode', 'night', 'no');
await startDesktop();

try {
  launchApp();
  check('starts not connected', await until(() => screen().text('status_title') === 'Not connected'));
  check('says there is no Honeywell scanner on the emulator', screen().text('scanner_missing')?.startsWith('No Honeywell scanner'));

  // Pair by "scanning" the QR code.
  scan(link(), { aimId: ']Q1', codeId: 's' });
  check('pairs from the QR code', await until(() => server.devices().length === 1));
  check('shows the computer name', await until(() => screen().text('status_title') === 'Connected to Test Mac'));
  const device = server.devices()[0]?.device ?? '';
  check(`reports a device name (${device})`, device.length > 0);
  check('pairing code is not logged as a scan', received.length === 0 && screen().text('last_scan') === 'Nothing scanned yet');

  // Scanner button
  scan('0123456789012', { aimId: ']E0', codeId: 'd' });
  check('scan reaches the computer', await until(() => received.some((s) => s.data === '0123456789012')));
  const first = received.find((s) => s.data === '0123456789012');
  check('barcode type travels with it', first?.aimId === ']E0' && first?.codeId === 'd');
  check('scan marked sent on the device', await until(() => screen().text('last_scan_meta')?.endsWith('Sent')));
  scan('Box 7 / "fragile" & more', { aimId: ']Q1', codeId: 's' });
  check('spaces and symbols survive', await until(() => received.some((s) => s.data === 'Box 7 / "fragile" & more')));

  // Typed entry
  const field = screen().nodes.find((n) => n.id === 'manual');
  shell('input', 'tap', ...field.center.map(String));
  shell('input', 'text', 'MANUAL-42');
  shell('input', 'keyevent', 'KEYCODE_ENTER');
  check('typed barcode reaches the computer', await until(() => received.some((s) => s.data === 'MANUAL-42')));
  shell('input', 'keyevent', 'KEYCODE_BACK'); // hide the keyboard
  await sleep(500);
  screenshot('ct45-android-connected.png');

  // Out of range: scans queue, survive the app being killed, then go in order.
  await server.close();
  check('notices the computer is gone', await until(() => /^(Can't reach|Connecting to) Test Mac/.test(screen().text('status_title') ?? '')));
  scan('OFFLINE-1');
  await until(() => screen().text('last_scan') === 'OFFLINE-1');
  check('queued scan shown as waiting', screen().text('last_scan_meta')?.endsWith('Waiting'));
  screenshot('ct45-android-waiting.png');
  shell('am', 'force-stop', PKG);
  launchApp();
  await sleep(1500);
  scan('OFFLINE-2');
  check('queue survives the app being killed', await until(() => screen().has('2 scans waiting to send.')));
  const before = received.length;
  await startDesktop();
  check('queued scans arrive after reconnecting', await until(() => received.length === before + 2, 40_000));
  check('in the order they were scanned', received.slice(before).map((s) => s.data).join() === 'OFFLINE-1,OFFLINE-2');
  check('shows connected again', await until(() => screen().text('status_title') === 'Connected to Test Mac'));

  // The desktop makes a new pairing code: the device must be told to re-pair.
  token = newToken();
  server.disconnectAll();
  check('asks to re-pair after a new pairing code', await until(() => screen().text('status_title') === 'Pairing code changed'));
  scan(link(), { aimId: ']Q1', codeId: 's' });
  check('re-pairs from the new code', await until(() => screen().text('status_title') === 'Connected to Test Mac'));
  scan('AFTER-REPAIR');
  check('scans flow after re-pairing', await until(() => received.some((s) => s.data === 'AFTER-REPAIR')));

  // USB fallback: an address that doesn't answer, then 127.0.0.1 forwarded over adb.
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
  scan(pairingUrl({ hosts: ['192.0.2.1', '127.0.0.1'], port: PORT, token, name: 'Test Mac' }), { aimId: ']Q1', codeId: 's' });
  check('falls back to the next address in the pairing code', await until(() => server.devices()[0]?.address === '127.0.0.1', 30_000));
  scan('VIA-USB');
  check('scans flow over USB', await until(() => received.some((s) => s.data === 'VIA-USB')));
  adb('reverse', '--remove', `tcp:${PORT}`);

  // A connection that died without closing: steady scanning must not hide it.
  const silent = await startFakeDesktop(PORT + 1, 'silent');
  scan(silent.link, { aimId: ']Q1', codeId: 's' });
  await until(() => screen().text('status_title') === 'Connected to Fake Mac');
  const firstScanAt = Date.now();
  let reconnectedAfter = null;
  for (let i = 1; i <= 8 && reconnectedAfter === null; i++) {
    scan(`UNANSWERED-${i}`);
    if (await until(() => silent.connections >= 2, 3000)) reconnectedAfter = Date.now() - firstScanAt;
  }
  check(`notices a silent computer within 15 s while scanning every 3 s (${reconnectedAfter} ms)`, reconnectedAfter !== null && reconnectedAfter < 15_000);
  const unanswered = [...new Set(silent.scans)];
  await silent.close();
  scan(link(), { aimId: ']Q1', codeId: 's' });
  check('scans the silent computer never answered arrive after pairing with the real one', await until(() => unanswered.every((d) => received.some((r) => r.data === d)), 20_000), unanswered.join());

  // A computer that refuses a scan: marked Rejected, not resent forever.
  const rejecting = await startFakeDesktop(PORT + 2, 'reject');
  scan(rejecting.link, { aimId: ']Q1', codeId: 's' });
  await until(() => screen().text('status_title') === 'Connected to Fake Mac');
  scan('REJECT-ME');
  check('a refused scan is marked Rejected', await until(() => screen().text('last_scan_meta')?.endsWith('Rejected')));
  await sleep(12_000);
  check('and is not sent again', rejecting.scans.filter((d) => d === 'REJECT-ME').length === 1 && rejecting.connections === 1, `${rejecting.scans.length} sends, ${rejecting.connections} connections`);
  await rejecting.close();

  // New pairing code while a scan is on its way: stays put, no pointless reconnect.
  const repairing = await startFakeDesktop(PORT + 3, 'silent');
  scan(repairing.link, { aimId: ']Q1', codeId: 's' });
  await until(() => screen().text('status_title') === 'Connected to Fake Mac');
  scan('IN-FLIGHT');
  await until(() => repairing.scans.includes('IN-FLIGHT'));
  for (const c of repairing.wss.clients) c.close(CLOSE_REPAIRED, 'pairing code changed');
  check('shows the pairing code changed', await until(() => screen().text('status_title') === 'Pairing code changed'));
  await sleep(13_000);
  check('and stays that way without reconnecting', screen().text('status_title') === 'Pairing code changed' && repairing.connections === 1, `${repairing.connections} connections`);
  await repairing.close();

  // Background mode. Back on the normal address first.
  scan(link(), { aimId: ']Q1', codeId: 's' });
  await until(() => screen().text('status_title') === 'Connected to Test Mac');
  shell('pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS'); // skip Android's dialog
  const tapSwitch = () => shell('input', 'tap', ...screen().nodes.find((n) => n.id === 'background').center.map(String));
  const serviceRunning = () => shell('dumpsys', 'activity', 'services', PKG).includes('isForeground=true');
  const notification = () => shell('dumpsys', 'notification', '--noredact');
  const arrives = (data, timeout) => until(() => received.some((s) => s.data === data), timeout);
  tapSwitch();
  check('background switch starts the service', await until(serviceRunning));
  check('background notification shows the connection', await until(() => notification().includes('Sending scans to Test Mac')));

  scan('BOTH-1');
  await arrives('BOTH-1');
  await sleep(1000);
  check('app open and background on: a scan arrives once', received.filter((s) => s.data === 'BOTH-1').length === 1);

  shell('input', 'keyevent', 'KEYCODE_HOME');
  await sleep(1000);
  const onScreen = () => shell('dumpsys', 'activity', 'activities').split('\n').filter((l) => /ResumedActivity/.test(l)).join('\n');
  check('app is off screen after Home', !onScreen().includes(PKG), onScreen());
  scan('BG-OTHER-APP');
  check('scan with another app in front reaches the computer', await arrives('BG-OTHER-APP'));

  // Another app sends a pairing code while CT45 Tracker is in the background: ignored.
  const rogue = await startFakeDesktop(PORT + 4, 'silent');
  scan(rogue.link, { aimId: ']Q1', codeId: 's' });
  await sleep(4000);
  check('a pairing code from the background is ignored', rogue.connections === 0 && server.devices().length === 1);
  await rogue.close();

  const power = () => shell('dumpsys', 'power');
  const keyguard = () => shell('dumpsys', 'window').includes('isKeyguardShowing=true');
  shell('locksettings', 'set-pin', '1234');
  try {
    shell('input', 'keyevent', 'KEYCODE_SLEEP');
    await until(() => power().includes('mWakefulness=Asleep'));
    scan('BG-SCREEN-OFF');
    check('scan with the screen off and locked reaches the computer', await arrives('BG-SCREEN-OFF'));

    shell('input', 'keyevent', 'KEYCODE_WAKEUP');
    check('lock screen is showing', await until(keyguard));
    scan('BG-LOCK-SCREEN');
    check('scan on the lock screen reaches the computer', await arrives('BG-LOCK-SCREEN'));
    await sleep(500);
    screenshot('ct45-android-lockscreen.png');

    // Deep sleep (Doze), as after the device sits locked for a while.
    shell('input', 'keyevent', 'KEYCODE_SLEEP');
    shell('dumpsys', 'battery', 'unplug');
    shell('dumpsys', 'deviceidle', 'force-idle');
    scan('BG-DOZE');
    const duringDoze = await arrives('BG-DOZE', 15_000);
    shell('dumpsys', 'deviceidle', 'unforce');
    shell('dumpsys', 'battery', 'reset');
    check(`scan in deep sleep reaches the computer (${duringDoze ? 'right away' : 'after waking'})`, duringDoze || (await arrives('BG-DOZE', 30_000)));
  } finally {
    shell('dumpsys', 'deviceidle', 'unforce');
    shell('dumpsys', 'battery', 'reset');
    shell('locksettings', 'clear', '--old', '1234');
    shell('input', 'keyevent', 'KEYCODE_WAKEUP');
    shell('wm', 'dismiss-keyguard');
  }

  // Survives a restart without opening the app.
  adb('reboot');
  execFileSync(ADB, ['wait-for-device']);
  await until(() => shell('getprop', 'sys.boot_completed').trim() === '1', 180_000);
  check('background mode comes back after a restart', await until(serviceRunning, 60_000));
  shell('input', 'keyevent', 'KEYCODE_WAKEUP');
  shell('wm', 'dismiss-keyguard');
  scan('AFTER-REBOOT');
  check('scans reach the computer after a restart, app never opened', await arrives('AFTER-REBOOT', 30_000));

  // Off again, from the notification's Turn off: the scanner goes back to other apps.
  shell('cmd', 'statusbar', 'expand-notifications');
  await sleep(1500);
  const turnOff = await until(() => screen().nodes.some((n) => n.text === 'Turn off'));
  if (turnOff) shell('input', 'tap', ...screen().nodes.find((n) => n.text === 'Turn off').center.map(String));
  check('Turn off in the notification stops the service', turnOff && (await until(() => !serviceRunning())));
  shell('cmd', 'statusbar', 'collapse');
  check('and removes the notification', !notification().includes('Sending scans to Test Mac'));
  launchApp();
  check('and the switch shows off', await until(() => /checked="false"/.test(adb('exec-out', 'uiautomator', 'dump', '/dev/tty').match(/resource-id="com.henokabraham.ct45tracker:id\/background"[^>]*/)?.[0] ?? '')));
  shell('input', 'keyevent', 'KEYCODE_HOME');
  await sleep(1000);
  scan('OFF-OTHER-APP');
  await sleep(3000);
  check('with it off, scans outside the app are left alone', !received.some((s) => s.data === 'OFF-OTHER-APP'));

  check('no scan arrived twice', new Set(received.map((s) => s.id)).size === received.length);

  launchApp();
  shell('cmd', 'uimode', 'night', 'yes');
  await sleep(2500);
  screenshot('ct45-android-dark.png');
} finally {
  shell('cmd', 'uimode', 'night', 'no');
  await server?.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
