// Run only on a disposable emulator: OLD_APK=/path/to/v1.apk ANDROID_SERIAL=emulator-5580 node scripts/android-release-e2e.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { startServer } from '../src/server.js';
import { createIdentity, fingerprint } from '../src/identity.js';
import { advertiseComputer } from '../src/discovery.js';
import { pairingUrl } from '../src/protocol.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADB = process.env.ADB || path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb');
const serial = process.env.ANDROID_SERIAL;
if (!serial?.startsWith('emulator-')) throw new Error('Select a disposable emulator with ANDROID_SERIAL');
const PKG = 'com.henokabraham.ct45tracker';
const adb = (...args) => execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 });
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const shell = (...args) => adb('shell', args.map(q).join(' '));
const launch = () => shell('am', 'start', '-W', '-n', `${PKG}/.MainActivity`);
const scan = (data) => shell('am', 'broadcast', '-a', `${PKG}.SCAN`, '--es', 'data', data);
const screen = () => adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, description, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(250); }
  throw new Error(`Timed out: ${description}`);
}
const pass = (name) => console.log(`PASS ${name}`);
await until(() => shell('getprop', 'sys.boot_completed').trim() === '1', 'boot', 120000);
assert.equal(shell('getprop', 'ro.kernel.qemu').trim(), '1');
if (!process.env.OLD_APK) throw new Error('OLD_APK must point to the published v1.0.0 debug APK');
if (process.env.RESET_TEST_APP === '1') adb('uninstall', PKG);
adb('install', '-r', process.env.OLD_APK);
launch();
await until(() => screen().includes('Not connected'), 'old app ready');
scan('BEFORE-UPGRADE-00001');
await until(() => screen().includes('BEFORE-UPGRADE-00001'), 'old saved scan');
adb('install', '-r', path.join(root, 'android/app/build/outputs/apk/release/CT45-Computer-Link-2.0.0.apk'));
launch();
await until(() => screen().includes('BEFORE-UPGRADE-00001'), 'saved scan after upgrade');
const info = shell('dumpsys', 'package', PKG);
assert.ok(info.includes('versionName=2.0.0'));
assert.ok(!/flags=\[.*DEBUGGABLE/.test(info));
pass('published debug APK upgrades to signed non-debug release with saved scans intact');
const identity = await createIdentity();
const pin = fingerprint(new X509Certificate(identity.cert).raw);
let active = { id: 'morning', name: 'Morning count' };
const received = [];
let server;
let advertisement;
const start = async (port) => startServer({ port, identity, getToken: () => 'release-test', getSession: () => active, computerName: () => 'Demo Computer', onScan: (s) => received.push(s) });
const link = (port, cert = pin) => pairingUrl({ hosts: ['10.0.2.2'], port, token: 'release-test', computerId: identity.id, fingerprint: cert, name: 'Demo Computer' });
try {
  server = await start(18767);
  scan(link(server.port, '0'.repeat(64)));
  scan('PINNED-ONLY');
  await pause(7000);
  assert.equal(server.devices().length, 0);
  assert.equal(received.length, 0);
  pass('wrong certificate pin sends no credentials or queued barcodes');
  scan(link(server.port));
  await until(() => received.some((s) => s.data === 'BEFORE-UPGRADE-00001'), 'upgraded outbox delivered');
  await until(() => received.some((s) => s.data === 'PINNED-ONLY'), 'pinned outbox delivered');
  assert.equal(received.find((s) => s.data === 'BEFORE-UPGRADE-00001').sessionId, 'default');
  pass('valid encrypted pairing delivers the preserved outbox');
  scan('MORNING-00001');
  await until(() => received.some((s) => s.data === 'MORNING-00001'), 'morning scan');
  assert.equal(received.at(-1).sessionId, 'morning');
  active = { id: 'evening', name: 'Evening count' };
  server.sessionChanged();
  await until(() => screen().includes('Session: Evening count'), 'session switch on scanner');
  await server.close(); server = null;
  scan('OFFLINE-EVENING');
  await until(() => screen().includes('OFFLINE-EVENING'), 'offline scan saved');
  active = { id: 'morning', name: 'Morning count' };
  server = await start(18767);
  await until(() => received.some((s) => s.data === 'OFFLINE-EVENING'), 'offline replay');
  assert.equal(received.find((s) => s.data === 'OFFLINE-EVENING').sessionId, 'evening');
  pass('offline scan retains its capture session when the active desktop session changes');
  shell('am', 'force-stop', PKG); launch();
  await until(() => screen().includes('Session: Morning count'), 'persisted session');
  await until(() => server.devices().length === 1, 'reconnect after restart');
  pass('release app reconnects after restart');
  if (process.env.SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR, 'ct45-android.png'), execFileSync(ADB, ['-s', serial, 'exec-out', 'screencap', '-p']));
  }
  await server.close(); server = null;
  server = await start(18768);
  advertisement = advertiseComputer(identity, server.port, (e) => console.error(e.message));
  scan('AFTER-ADDRESS-CHANGE');
  if (process.env.DISCOVERY_FIXTURE_APK) {
    adb('install', '-r', process.env.DISCOVERY_FIXTURE_APK);
    shell('am', 'force-stop', 'test.ct45.discovery');
    shell('am', 'start', '-W', '-n', 'test.ct45.discovery/.DiscoveryFixture', '--es', 'id', identity.id, '--ei', 'targetPort', String(server.port));
    launch();
  }
  await until(() => received.some((s) => s.data === 'AFTER-ADDRESS-CHANGE'), 'mDNS address/port discovery', 90000);
  pass('mDNS finds the same computer at a new endpoint without rescanning the pairing code');
  assert.equal(received.filter((s) => s.data === 'AFTER-ADDRESS-CHANGE').length, 1);
} finally {
  if (process.env.DISCOVERY_FIXTURE_APK) shell('am', 'force-stop', 'test.ct45.discovery');
  advertisement?.stop();
  await server?.close();
}
