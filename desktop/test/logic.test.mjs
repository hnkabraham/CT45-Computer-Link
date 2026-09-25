import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newToken, pairingUrl, parseClientMessage, parsePairingUrl, tokensMatch } from '../src/protocol.js';
import { symbologyName } from '../src/symbology.js';
import { csvField, toCsv } from '../src/csv.js';
import { LIVE_SCAN_MS, cleanForTyping, createTyper, isPermissionError, typeCommand, wasDelayed } from '../src/typer.js';
import { lanAddresses } from '../src/network.js';
import { ScanStore } from '../src/store.js';

test('pairing URL round-trips', () => {
  const url = pairingUrl({ hosts: ['192.168.1.5', '10.0.0.2'], port: 8765, token: 'abc_-123', name: "Henok's Mac", computerId: "test-id", fingerprint: "a".repeat(64) });
  assert.ok(url.startsWith('ct45tracker://pair?'));
  assert.deepEqual(parsePairingUrl(url), { hosts: ['192.168.1.5', '10.0.0.2'], port: 8765, token: 'abc_-123', name: "Henok's Mac", computerId: "test-id", fingerprint: "a".repeat(64) });
});

test('ordinary barcodes are not mistaken for pairing codes', () => {
  assert.equal(parsePairingUrl('0123456789012'), null);
  assert.equal(parsePairingUrl('https://example.com/?h=1&p=2&t=3'), null);
  assert.equal(parsePairingUrl('ct45tracker://pair?h=1.2.3.4&p=99999&t=x'), null);
  assert.equal(parsePairingUrl('ct45tracker://pair?h=1.2.3.4&p=8765'), null);
});

test('tokens are random and compared exactly', () => {
  const t = newToken();
  assert.equal(t.length, 16);
  assert.notEqual(t, newToken());
  assert.ok(tokensMatch(t, t));
  assert.ok(!tokensMatch(t, t.slice(1)));
  assert.ok(!tokensMatch(t, undefined));
});

test('client messages are validated', () => {
  assert.deepEqual(parseClientMessage('{"type":"hello","token":"t","device":"CT45"}'), {
    ok: true,
    msg: { type: 'hello', token: 't', device: 'CT45', app: '' },
  });
  const scan = parseClientMessage(JSON.stringify({ type: 'scan', id: 'a', data: 'X1', scannedAt: 5, aimId: ']C0', extra: 1 }));
  assert.deepEqual(scan.msg, { type: 'scan', id: 'a', data: 'X1', scannedAt: 5, sentAt: null, aimId: ']C0', codeId: '', sessionId: '', sessionName: '' });
  assert.equal(parseClientMessage(JSON.stringify({ type: 'scan', id: 'a', data: 'X1', scannedAt: 5, sentAt: 9 })).msg.sentAt, 9);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'scan', id: 'a', data: 'X1', scannedAt: 5, sentAt: 'x' })).ok, false);
  assert.equal(parseClientMessage('nope').ok, false);
  assert.equal(parseClientMessage('{"type":"scan","id":"a","data":"","scannedAt":1}').ok, false);
  assert.equal(parseClientMessage('{"type":"scan","id":"a","data":"x"}').ok, false);
  assert.equal(parseClientMessage('{"type":"hello"}').ok, false);
  assert.equal(parseClientMessage('{"type":"boom"}').ok, false);
  assert.equal(parseClientMessage('null').ok, false);
});

test("a rejected scan's id comes back so the scanner can stop resending it", () => {
  assert.equal(parseClientMessage('{"type":"scan","id":"u2"}').id, 'u2');
  assert.equal(parseClientMessage('{"type":"scan","id":7}').id, undefined);
  assert.equal(parseClientMessage('not json').id, undefined);
});

test('symbology names prefer the Honeywell code ID, then the AIM ID', () => {
  assert.equal(symbologyName({ codeId: 'c', aimId: ']E0' }), 'UPC-A');
  assert.equal(symbologyName({ aimId: ']C1' }), 'GS1-128');
  assert.equal(symbologyName({ aimId: ']C0' }), 'Code 128');
  assert.equal(symbologyName({ aimId: ']Q1' }), 'QR Code');
  assert.equal(symbologyName({ codeId: '?', aimId: ']X0' }), '');
  assert.equal(symbologyName({}), '');
});

test('symbology lookups ignore built-in object properties', () => {
  assert.equal(symbologyName({ codeId: 'toString' }), '');
  assert.equal(symbologyName({ codeId: 'constructor', aimId: ']C0' }), 'Code 128');
});

test('CSV fields are quoted and formula-safe', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvField('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvField('-12'), '-12');
  assert.equal(csvField('+44'), '+44');
  assert.equal(csvField('-x'), "'-x");
});

test('CSV export is oldest first with a header, BOM and CRLF', () => {
  const t = new Date(2026, 8, 24, 9, 5, 7).getTime();
  const csv = toCsv([
    { data: 'B', scannedAt: t + 1000, device: 'CT45', codeId: 'j' },
    { data: 'A', scannedAt: t, device: 'CT45', aimId: ']Q1' },
  ]);
  assert.equal(
    csv,
    '﻿Scanned at,Barcode,Type,Device,Session\r\n2026-09-24 09:05:07,A,QR Code,CT45,General\r\n2026-09-24 09:05:08,B,Code 128,CT45,General\r\n',
  );
});

test('typing drops control characters', () => {
  assert.equal(cleanForTyping('01\u001d0123\r\n'), '010123');
});

test('macOS typing passes the barcode as an argument, after --', () => {
  const cmd = typeCommand('darwin', '-5 "quoted" end tell', 'enter');
  assert.equal(cmd.file, 'osascript');
  assert.deepEqual(cmd.args.slice(-2), ['--', '-5 "quoted" end tell']);
  assert.ok(cmd.args.includes('key code 36'));
  assert.ok(!typeCommand('darwin', 'x', 'none').args.some((a) => a.startsWith('key code')));
  assert.ok(typeCommand('darwin', 'x', 'tab').args.includes('key code 48'));
});

test('Windows typing passes the barcode in an environment variable', () => {
  const cmd = typeCommand('win32', 'A+B{1}', 'tab');
  assert.equal(cmd.file, 'powershell.exe');
  assert.equal(cmd.env.CT45_TEXT, 'A+B{1}');
  assert.ok(!cmd.args.join(' ').includes('A+B'));
  assert.ok(cmd.args.at(-1).endsWith("SendWait($t + '{TAB}')"));
  assert.ok(typeCommand('win32', 'x', 'none').args.at(-1).endsWith("SendWait($t + '')"));
  assert.equal(typeCommand('linux', 'x'), null);
});

test('macOS permission errors are recognised', () => {
  assert.ok(isPermissionError('execution error: osascript is not allowed to send keystrokes. (1002)'));
  assert.ok(!isPermissionError('some other failure'));
});

test('typing runs one scan at a time, in order', async () => {
  const log = [];
  const type = createTyper({
    platform: 'darwin',
    run: async ({ args }) => {
      log.push(`start ${args.at(-1)}`);
      await new Promise((r) => setTimeout(r, args.at(-1) === 'slow' ? 30 : 1));
      log.push(`end ${args.at(-1)}`);
    },
  });
  await Promise.all([type('slow', 'enter'), type('fast', 'enter')]);
  assert.deepEqual(log, ['start slow', 'end slow', 'start fast', 'end fast']);
  await assert.rejects(createTyper({ platform: 'linux' })('x'), /only supported/);
});

test('whether to type is decided right before typing, not when the scan arrived', async () => {
  let focused = false;
  const typed = [];
  const type = createTyper({
    platform: 'darwin',
    run: async ({ args }) => {
      typed.push(args.at(-1));
      focused = true; // the user clicks into CT45 Tracker while the first scan is being typed
      await new Promise((r) => setTimeout(r, 5));
    },
  });
  const skip = () => (focused ? 'focused' : null);
  const results = await Promise.all([type('A', 'enter', skip), type('B', 'enter', skip)]);
  assert.deepEqual(typed, ['A']);
  assert.deepEqual(results, [{ typed: true }, { skipped: 'focused' }]);
});

test('scans that waited in the outbox are recognised by their own clock', () => {
  assert.equal(wasDelayed({ scannedAt: 1000, sentAt: 1500 }), false);
  assert.equal(wasDelayed({ scannedAt: 1000, sentAt: 1000 + LIVE_SCAN_MS + 1 }), true);
  assert.equal(wasDelayed({ scannedAt: 1000, sentAt: null }), false); // older CT45 app
  // A CT45 clock hours off from the computer's doesn't matter.
  assert.equal(wasDelayed({ scannedAt: 5e12, sentAt: 5e12 + 200 }), false);
});

test('LAN addresses skip loopback and self-assigned, and put VPNs last', () => {
  const ifaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    utun4: [{ family: 'IPv4', address: '10.8.0.2', internal: false }],
    en7: [{ family: 'IPv4', address: '169.254.3.3', internal: false }],
    en0: [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '192.168.128.220', internal: false },
    ],
    en5: [{ family: 'IPv4', address: '100.70.1.2', internal: false }],
  };
  assert.deepEqual(lanAddresses(ifaces), ['192.168.128.220', '100.70.1.2', '10.8.0.2']);
});

test('scan store dedupes, persists, survives a damaged line, and clears', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct45-store-'));
  const file = path.join(dir, 'scans.jsonl');
  const store = new ScanStore(file).load();
  assert.equal(store.add({ id: '1', data: 'A', scannedAt: 1 }), true);
  assert.equal(store.add({ id: '1', data: 'A', scannedAt: 1 }), false);
  assert.equal(store.add({ id: '2', data: 'B', scannedAt: 2 }), true);
  fs.appendFileSync(file, '{"id":"3","da');
  const reloaded = new ScanStore(file).load();
  assert.deepEqual(reloaded.list().map((s) => s.id), ['2', '1']);
  reloaded.clear();
  assert.deepEqual(reloaded.list(), []);
  assert.equal(reloaded.add({ id: '2', data: 'B', scannedAt: 2 }), false);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('"data"'), 'no barcodes left on disk');
  // After a restart, a resent old scan still doesn't come back, and new ones still do.
  const restarted = new ScanStore(file).load();
  assert.deepEqual(restarted.list(), []);
  assert.equal(restarted.add({ id: '1', data: 'A', scannedAt: 1 }), false);
  assert.equal(restarted.add({ id: '4', data: 'D', scannedAt: 4 }), true);
  assert.deepEqual(new ScanStore(file).load().list().map((s) => s.id), ['4']);
});

test('new scans survive another restart after an interrupted JSONL write', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct45-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'scans.jsonl');
  new ScanStore(file).load().add({ id: 'before', data: 'A', scannedAt: 1 });
  fs.appendFileSync(file, '{"id":"interrupted","data":"');
  const recovered = new ScanStore(file).load();
  assert.equal(recovered.add({ id: 'after', data: 'B', scannedAt: 2 }), true);
  const restarted = new ScanStore(file).load();
  assert.deepEqual(restarted.list().map((s) => s.id), ['after', 'before']);
  assert.equal(restarted.add({ id: 'after', data: 'B', scannedAt: 2 }), false);
});

test('recovery preserves a complete last record that is missing its newline', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct45-newline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'scans.jsonl');
  fs.writeFileSync(file, JSON.stringify({ id: 'complete', data: 'Café 📦', scannedAt: 1 }));
  const recovered = new ScanStore(file).load();
  assert.equal(recovered.add({ id: 'complete', data: 'Café 📦', scannedAt: 1 }), false);
  recovered.add({ id: 'new', data: 'B', scannedAt: 2 });
  assert.deepEqual(new ScanStore(file).load().list().map((s) => s.data), ['B', 'Café 📦']);
});

test('a partial failed append can be retried safely without restarting', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct45-write-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'scans.jsonl');
  const store = new ScanStore(file).load();
  const append = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (file, text) => {
    append(file, text.slice(0, 12));
    throw new Error('disk full');
  }, { times: 1 });
  const scan = { id: 'retry', data: 'A', scannedAt: 1 };
  assert.throws(() => store.add(scan), /disk full/);
  assert.equal(store.has(scan.id), false);
  assert.equal(store.add(scan), true);
  assert.deepEqual(new ScanStore(file).load().list(), [scan]);
});
