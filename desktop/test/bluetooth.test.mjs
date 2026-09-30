import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import WebSocket from 'ws';
import { startBluetooth } from '../src/bluetooth.js';
import { createIdentity, fingerprint } from '../src/identity.js';
import { startServer } from '../src/server.js';
import { pairingUrl, parsePairingUrl } from '../src/protocol.js';

const child = () => {
  const c = new EventEmitter();
  c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
  c.kill = () => c.emit('exit', 0);
  c.stdin.on('finish', () => c.kill());
  c.event = (event) => c.stdout.write(`${JSON.stringify(event)}\n`);
  return c;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const serviceId = 'e89c1e7a-0450-4d82-9b4c-b5c3f155cf45';
const ready = { event: 'ready', serviceId };

test('Bluetooth QR remains compatible with network pairing and rejects malformed service UUIDs', () => {
  const options = { hosts: ['127.0.0.1'], port: 8765, token: 'test', computerId: 'test', fingerprint: 'a'.repeat(64) };
  assert.equal(parsePairingUrl(pairingUrl(options)).bluetoothService, undefined);
  const url = pairingUrl({ ...options, bluetoothService: serviceId.toUpperCase() });
  assert.equal(parsePairingUrl(url).bluetoothService, serviceId);
  assert.equal(parsePairingUrl(pairingUrl({ ...options, bluetoothService: 'host:8765' })), null);
  assert.equal(parsePairingUrl(url.replace('fp=aaaa', 'fp=oops')), null);
});

test('helper failure is reported without affecting the network server', async () => {
  const helper = child();
  const states = [];
  const bridge = startBluetooth({ serviceId, executable: 'fake', port: 1, spawnHelper: () => helper, onState: (s) => states.push(s) });
  helper.emit('error', new Error('not installed'));
  assert.match(states.at(-1).message, /could not start/);
  assert.equal(states.at(-1).status, 'error');
  bridge.stop();
  await pause(1);
});

test('malformed helper messages and excessive buffers stop the bridge safely', async () => {
  for (const invalid of ['invalid\n', 'x'.repeat(1024 * 1024 + 1), JSON.stringify({ ...ready, serviceId: 'nope' }) + '\n']) {
    const helper = child();
    const states = [];
    const bridge = startBluetooth({ serviceId, executable: 'fake', port: 1, spawnHelper: () => helper, onState: (s) => states.push(s) });
    helper.stdout.write(invalid);
    assert.equal(states.at(-1).status, 'error');
    bridge.stop();
  }
  await pause(1);
});

test('fragmented opaque Bluetooth bytes preserve TLS, scan acknowledgements, sessions and pin rejection', { timeout: 15000 }, async () => {
  const identity = await createIdentity();
  const expected = fingerprint(new X509Certificate(identity.cert).raw);
  const scans = [];
  let session = { id: 'stock', name: 'Stock count' };
  const server = await startServer({ port: 0, identity, getToken: () => 'test-token', getSession: () => session,
    computerName: () => 'Test', onScan: (scan) => scans.push(scan) });
  const helper = child();
  const sockets = new Map();
  helper.once('exit', () => { for (const socket of sockets.values()) socket.destroy(); });
  let nextId = 0;
  let commandBuffer = '';
  helper.stdin.on('data', (chunk) => {
    commandBuffer += chunk;
    let i;
    while ((i = commandBuffer.indexOf('\n')) >= 0) {
      const command = JSON.parse(commandBuffer.slice(0, i)); commandBuffer = commandBuffer.slice(i + 1);
      if (command.command === 'close') sockets.get(command.id)?.destroy();
      if (command.command === 'write') {
        sockets.get(command.id)?.write(Buffer.from(command.data, 'base64'));
        queueMicrotask(() => helper.event({ event: 'written', id: command.id }));
      }
    }
  });
  const carrier = net.createServer((socket) => {
    const id = String(++nextId); sockets.set(id, socket); helper.event({ event: 'open', id });
    socket.on('data', (bytes) => {
      // Split both TLS records and JSON messages independently, as Bluetooth/stdio may do.
      for (let offset = 0; offset < bytes.length; offset += 71) {
        const line = JSON.stringify({ event: 'data', id, data: bytes.subarray(offset, offset + 71).toString('base64') }) + '\n';
        helper.stdout.write(line.slice(0, 17)); helper.stdout.write(line.slice(17));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(id); helper.event({ event: 'close', id }); });
  });
  await new Promise((resolve) => carrier.listen(0, '127.0.0.1', resolve));
  const bridge = startBluetooth({ serviceId, executable: 'fake', port: server.port, spawnHelper: () => helper });
  helper.event(ready);
  let ws;
  try {
    const connect = (pin) => new WebSocket(`wss://127.0.0.1:${carrier.address().port}`, { ca: identity.cert,
      headers: { 'X-CT45-Transport': 'bluetooth' },
      checkServerIdentity: (_host, cert) => fingerprint(cert.raw) === pin ? undefined : new Error('pin mismatch') });
    const bad = connect('0'.repeat(64));
    await once(bad, 'error');
    assert.equal(server.devices().length, 0);
    ws = connect(expected);
    await once(ws, 'open');
    let reply = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'hello', token: 'test-token', device: 'CT45 test' }));
    assert.equal(JSON.parse((await reply)[0]).session.id, 'stock');
    assert.equal(server.devices()[0].transport, 'bluetooth');
    const value = '00012345678901234567890\u001dCafé 📦\n=SUM(A1)';
    reply = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'scan', id: 'bt-1', data: value, scannedAt: 1, sessionId: 'stock', sessionName: 'Stock count' }));
    assert.deepEqual(JSON.parse((await reply)[0]), { type: 'ack', id: 'bt-1' });
    assert.equal(scans[0].data, value);
    assert.equal(scans[0].sessionId, 'stock');
    session = { id: 'next', name: 'Next count' };
    reply = once(ws, 'message'); server.sessionChanged();
    assert.equal(JSON.parse((await reply)[0]).session.id, 'next');
    bridge.stop();
    await once(ws, 'close');
  } finally {
    ws?.terminate(); bridge.stop();
    for (const socket of sockets.values()) socket.destroy();
    await new Promise((resolve) => carrier.close(resolve));
    await server.close();
  }
});
