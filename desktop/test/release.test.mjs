import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import WebSocket from 'ws';
import { loadIdentity, createIdentity, fingerprint } from '../src/identity.js';
import { X509Certificate } from 'node:crypto';
import { toExcel } from '../src/excel.js';
import { Sessions, selectScans } from '../src/sessions.js';
import { ScanStore } from '../src/store.js';
import { startServer } from '../src/server.js';
import { pairingUrl, parsePairingUrl, parseClientMessage } from '../src/protocol.js';
import { fakeScan } from '../scripts/fake-scanner.mjs';

const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct45-release-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('Excel stores leading zeros, long numbers and formula-like barcodes as exact text', async () => {
  const values = ['0000123456789', '123456789012345678901234567890', '=HYPERLINK("bad")', '+12345', '-12', '@SUM(A1)', 'Café 📦', 'a\u001db', '_x001D_', 'a\nb'];
  const buffer = await toExcel(values.map((data, i) => ({ data, scannedAt: i, sessionName: 'Stock count', device: 'CT45' })));
  const book = await new ExcelJS.Workbook().xlsx.load(buffer);
  const sheet = book.worksheets[0];
  values.forEach((value, i) => {
    const cell = sheet.getCell(i + 2, 2);
    assert.equal(cell.type, ExcelJS.ValueType.String);
    assert.equal(cell.value, value);
    assert.equal(cell.numFmt, '@');
    assert.equal(sheet.getCell(i + 2, 5).value, 'Stock count');
  });
  assert.equal(sheet.views[0].ySplit, 1);
});

test('sessions survive restart and offline scans keep their original session', (t) => {
  const file = path.join(temp(t), 'sessions.json');
  const sessions = new Sessions(file);
  sessions.create('Morning count');
  const morning = sessions.active;
  sessions.create('Afternoon count');
  assert.deepEqual(sessions.resolve({ sessionId: morning.id, sessionName: morning.name }), morning);
  const restored = new Sessions(file);
  assert.equal(restored.active.name, 'Afternoon count');
  assert.equal(restored.resolve({}).name, 'General');
  restored.activate(morning.id);
  assert.equal(new Sessions(file).active.name, 'Morning count');
  assert.throws(() => sessions.create(' '));
  assert.throws(() => sessions.create('a'.repeat(81)));
  assert.throws(() => sessions.activate('missing'));
  assert.equal(sessions.resolve({ sessionId: 'recovered', sessionName: 'Previous computer' }).name, 'Previous computer');
});

test('session exports and clear preserve other sessions and deduplication after restart', (t) => {
  const file = path.join(temp(t), 'scans.jsonl');
  const store = new ScanStore(file).load();
  store.add({ id: 'old', data: '001' });
  store.add({ id: 'a', data: 'A', sessionId: 'one' });
  store.add({ id: 'b', data: 'B', sessionId: 'two' });
  assert.deepEqual(selectScans(store.list(), { sessionId: 'default' }).map((s) => s.id), ['old']);
  assert.deepEqual(selectScans(store.list(), { sessionId: 'one', query: 'a' }).map((s) => s.id), ['a']);
  store.clear('one');
  const restored = new ScanStore(file).load();
  assert.deepEqual(restored.list().map((s) => s.id), ['b', 'old']);
  assert.equal(restored.add({ id: 'a', data: 'resend' }), false);
});

test('computer identity persists, is private, and a corrupt identity never silently changes', async (t) => {
  const file = path.join(temp(t), 'identity.json');
  const identity = await loadIdentity(file);
  assert.deepEqual(await loadIdentity(file), identity);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{}');
  await assert.rejects(loadIdentity(file));
});

test('pairing requires a certificate pin and session fields are bounded', () => {
  assert.equal(parsePairingUrl('ct45tracker://pair?h=localhost&p=8765&t=secret'), null);
  const url = pairingUrl({ hosts: ['localhost'], port: 8765, token: 'secret', computerId: 'computer', fingerprint: 'a'.repeat(64) });
  assert.equal(parsePairingUrl(url.replace('fp=aaaa', 'fp=zzzz')), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'scan', id: 's', data: 'x', scannedAt: 1, sessionName: 'x'.repeat(81) })).ok, false);
});

test('TLS rejects plaintext, wrong certificates send no credentials, and session changes reach scanners', async () => {
  const identity = await createIdentity();
  const scans = [];
  let active = { id: 'first', name: 'First count' };
  const server = await startServer({ port: 0, identity, getToken: () => 'secret', computerName: () => 'Test', getSession: () => active, onScan: (s) => scans.push(s) });
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('open', () => { ws.terminate(); reject(new Error('Plaintext was accepted')); });
      ws.on('error', resolve);
    });
    const p = { hosts: ['127.0.0.1'], port: server.port, token: 'secret', computerId: identity.id, fingerprint: '0'.repeat(64) };
    await assert.rejects(fakeScan(pairingUrl(p), ['private']), /certificate/);
    assert.equal(server.devices().length, 0);
    assert.equal(scans.length, 0);
    p.fingerprint = fingerprint(new X509Certificate(identity.cert).raw);
    const client = await fakeScan(pairingUrl(p), ['001']);
    assert.equal(scans[0].sessionId, 'first');
    const change = new Promise((resolve) => client.ws.once('message', (m) => resolve(JSON.parse(m))));
    active = { id: 'second', name: 'Second count' };
    server.sessionChanged();
    assert.deepEqual(await change, { type: 'session', session: active });
    client.ws.close();
  } finally { await server.close(); }
});
