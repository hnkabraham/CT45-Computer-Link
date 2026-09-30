// Continues an EXISTING test pairing, including while the CT45 is locked. No device UI or
// settings are changed. This verifies radio/TLS connection recovery, not barcode capture.
// Inputs must be a disposable hardware test profile's identity.json and pairing.txt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadIdentity } from '../src/identity.js';
import { startServer } from '../src/server.js';
import { startBluetooth } from '../src/bluetooth.js';
import { parsePairingUrl } from '../src/protocol.js';
import { ScanStore } from '../src/store.js';

assert.equal(process.env.CT45_HARDWARE_TEST, '1', 'Explicit CT45_HARDWARE_TEST=1 opt-in required');
const profile = process.env.CT45_EXISTING_TEST_PROFILE;
const dir = process.env.CT45_TEST_DIR;
assert.ok(profile && dir && path.resolve(profile) !== path.resolve(dir), 'Supply existing test profile and a new output directory');
const hours = Number(process.env.CT45_SOAK_HOURS || 6);
assert.ok(Number.isFinite(hours) && hours > 0 && hours <= 8, 'Duration must be >0 and at most 8 hours');
const p = parsePairingUrl(fs.readFileSync(path.join(profile, 'pairing.txt'), 'utf8').trim());
const identity = await loadIdentity(path.join(profile, 'identity.json'));
assert.equal(p?.computerId, identity.id); assert.equal(p?.fingerprint, identity.fingerprint);
assert.equal(p?.bluetoothService, identity.id);
assert.deepEqual(p.hosts, ['192.0.2.1'], 'Only a Bluetooth-only disposable test pairing is allowed');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
assert.ok(!fs.existsSync(path.join(dir, 'report.json')), 'Do not overwrite an existing report');
const store = new ScanStore(path.join(dir, 'received.jsonl')).load();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = { status: 'starting', scope: 'connection-only; scan capture and background service are not tested',
  pid: process.pid, started: new Date().toISOString(), soakHours: hours, connectedSamples: 0, reconnects: [], unexpectedDisconnects: 0 };
let bridge, server, interrupted = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { interrupted = true; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = () => {
  report.updated = new Date().toISOString(); report.storedScans = store.list().length;
  fs.writeFileSync(path.join(dir, 'report.json.tmp'), JSON.stringify(report, null, 2), { mode: 0o600 });
  fs.renameSync(path.join(dir, 'report.json.tmp'), path.join(dir, 'report.json'));
};
const connected = () => server.devices().some((d) => d.transport === 'bluetooth');
async function waitFor(fn, description) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    if (interrupted) throw new Error('Test interrupted');
    if (fn()) return;
    await sleep(500);
  }
  throw new Error(`Timed out: ${description}`);
}
async function startBridge() {
  const started = Date.now();
  bridge = startBluetooth({ serviceId: identity.id, port: server.port,
    executable: process.env.CT45_BT_HELPER || path.join(root, 'native/bin/ct45-bluetooth'),
    onState: (s) => { report.helperStatus = s.status; if (s.status === 'error') report.helperError = s.message; save(); } });
  await waitFor(connected, 'existing CT45 Bluetooth pairing');
  report.reconnects.push({ at: new Date().toISOString(), milliseconds: Date.now() - started }); save();
  console.log(`Connected over Bluetooth (${report.reconnects.at(-1).milliseconds} ms)`);
}
save();
try {
  // Require the paired port instead of silently binding another local service.
  server = await startServer({ port: p.port, portAttempts: 1, identity, getToken: () => p.token,
    computerName: () => 'CT45 Bluetooth Test', getSession: () => ({ id: 'bluetooth-test', name: 'Bluetooth testing — synthetic scans' }),
    pingEveryMs: 15000, onScan: (scan) => store.add(scan) });
  await startBridge();
  // Exercise a restart immediately, then every 30 minutes during the soak.
  bridge.stop(); await bridge.closed; await waitFor(() => !connected(), 'disconnect');
  await startBridge();
  report.status = 'soaking'; const end = Date.now() + hours * 3600000;
  report.soakEnds = new Date(end).toISOString(); save();
  let nextRestart = Date.now() + 30 * 60000;
  while (Date.now() < end) {
    if (interrupted) throw new Error('Test interrupted');
    if (!connected()) {
      report.unexpectedDisconnects++; save();
      await waitFor(connected, 'automatic recovery');
    }
    report.connectedSamples++; report.lastConnected = new Date().toISOString(); save();
    if (Date.now() >= nextRestart) {
      bridge.stop(); await bridge.closed; await waitFor(() => !connected(), 'planned disconnect');
      await startBridge(); nextRestart = Date.now() + 30 * 60000;
    }
    await sleep(5000);
  }
  assert.ok(connected(), 'CT45 must still be connected at completion');
  report.status = 'passed';
  console.log('PASS Bluetooth connection soak completed');
} catch (error) {
  report.status = interrupted ? 'interrupted' : 'failed'; report.error = error.stack;
  console.error(error.message); process.exitCode = 1;
} finally {
  bridge?.stop(); await server?.close(); report.finished = new Date().toISOString(); save();
}
