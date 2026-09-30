import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import { CLOSE_BAD_TOKEN, CLOSE_NO_HELLO, CLOSE_REPAIRED, startServer } from '../src/server.js';

import { createIdentity } from '../src/identity.js';
const identity = await createIdentity();
const PORT = 28765;

async function withServer(opts, fn) {
  const scans = [];
  const deviceEvents = [];
  const server = await startServer({
    port: PORT,
    identity,
    getToken: () => 'secret',
    computerName: () => 'Test Mac',
    onScan: (s) => scans.push(s),
    onDevicesChanged: (d) => deviceEvents.push(d),
    ...opts,
  });
  try {
    await fn({ server, scans, deviceEvents });
  } finally {
    await server.close();
  }
}

// A minimal stand-in for the CT45 app: collects every message and the close code.
function connect(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { ca: identity.cert, checkServerIdentity: () => undefined });
  const inbox = [];
  const waiters = [];
  ws.on('message', (m) => {
    inbox.push(JSON.parse(m));
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return {
    ws,
    opened,
    closed,
    send: (obj) => ws.send(JSON.stringify(obj)),
    async next(pred = () => true) {
      for (;;) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0];
        await new Promise((r) => waiters.push(r));
      }
    },
  };
}

test('a scanner with the right token is welcomed and its scans are acknowledged', () =>
  withServer({}, async ({ server, scans, deviceEvents }) => {
    const c = connect(server.port);
    await c.opened;
    c.send({ type: 'hello', token: 'secret', device: 'CT45 #1' });
    assert.deepEqual(await c.next(), { type: 'welcome', name: 'Test Mac', version: 2, session: { id: 'default', name: 'General' } });
    assert.equal(server.devices()[0].device, 'CT45 #1');

    c.send({ type: 'scan', id: 'u1', data: '0123456789012', scannedAt: 1000, codeId: 'd' });
    assert.deepEqual(await c.next(), { type: 'ack', id: 'u1' });
    assert.equal(scans[0].data, '0123456789012');
    assert.equal(scans[0].device, 'CT45 #1');
    assert.equal(scans[0].codeId, 'd');

    c.send({ type: 'scan', id: 'u2' });
    const rejected = await c.next();
    assert.equal(rejected.code, 'bad-message');
    assert.equal(rejected.id, 'u2');

    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(server.devices(), []);
    assert.deepEqual(deviceEvents.map((d) => d.length), [1, 0]);
  }));

const order = [];
test('a burst is stored and acknowledged in order even when saving is slow', () =>
  withServer(
    {
      onScan: async (s) => {
        await new Promise((r) => setTimeout(r, s.data === 'first' ? 40 : 1));
        order.push(s.data);
      },
    },
    async ({ server }) => {
      const c = connect(server.port);
      await c.opened;
      c.send({ type: 'hello', token: 'secret' });
      await c.next((m) => m.type === 'welcome');
      for (const [id, data] of [['1', 'first'], ['2', 'second'], ['3', 'third']]) c.send({ type: 'scan', id, data, scannedAt: 1 });
      const acks = [await c.next(), await c.next(), await c.next()];
      assert.deepEqual(order, ['first', 'second', 'third']);
      assert.deepEqual(acks.map((a) => a.id), ['1', '2', '3']);
      c.ws.close();
    },
  ));

test('a wrong token is refused and the connection closed', () =>
  withServer({}, async ({ server, scans }) => {
    const c = connect(server.port);
    await c.opened;
    c.send({ type: 'hello', token: 'old-code' });
    assert.equal((await c.next()).code, 'bad-token');
    assert.equal(await c.closed, CLOSE_BAD_TOKEN);
    assert.equal(scans.length, 0);
  }));

test('scans before hello are refused', () =>
  withServer({}, async ({ server, scans }) => {
    const c = connect(server.port);
    await c.opened;
    c.send({ type: 'scan', id: 'x', data: 'y', scannedAt: 1 });
    assert.equal((await c.next()).code, 'not-paired');
    assert.equal(scans.length, 0);
    c.ws.close();
  }));

test('a connection that never says hello is closed', () =>
  withServer({ helloTimeoutMs: 50 }, async ({ server }) => {
    const c = connect(server.port);
    await c.opened;
    assert.equal(await c.closed, CLOSE_NO_HELLO);
  }));

test('a failed save is reported without an ack so the scanner retries', () =>
  withServer({ onScan: () => { throw new Error('disk full'); } }, async ({ server }) => {
    const c = connect(server.port);
    await c.opened;
    c.send({ type: 'hello', token: 'secret' });
    await c.next((m) => m.type === 'welcome');
    c.send({ type: 'scan', id: 'z', data: 'y', scannedAt: 1 });
    assert.deepEqual(await c.next(), { type: 'error', code: 'save-failed', message: 'disk full', id: 'z' });
    c.ws.close();
  }));

test('disconnectAll drops paired scanners after a new pairing code', () =>
  withServer({}, async ({ server }) => {
    const c = connect(server.port);
    await c.opened;
    c.send({ type: 'hello', token: 'secret' });
    await c.next((m) => m.type === 'welcome');
    server.disconnectAll();
    assert.equal(await c.closed, CLOSE_REPAIRED);
  }));

test('moves to the next port when the preferred one is taken', async () => {
  const blocker = net.createServer().listen(PORT + 1);
  await new Promise((r) => blocker.once('listening', r));
  try {
    await withServer({ port: PORT + 1 }, async ({ server }) => {
      assert.equal(server.port, PORT + 2);
    });
  } finally {
    blocker.close();
  }
});

test('authenticated session selection updates all scanners and preserves queued scan attribution', async () => {
  const sessions = [{ id: 'a', name: 'Morning' }, { id: 'b', name: 'Afternoon' }];
  let active = sessions[0];
  let changed;
  await withServer({ getSession: () => active, getSessions: () => sessions, onSelectSession: (id) => { active = sessions.find((s) => s.id === id); changed(); } }, async ({ server, scans }) => {
    changed = server.sessionChanged;
    const a = connect(server.port); const b = connect(server.port);
    await Promise.all([a.opened, b.opened]);
    a.send({ type: 'select-session', sessionId: 'b', requestId: 'before-hello' });
    assert.equal((await a.next()).code, 'not-paired');
    assert.equal(active.id, 'a');
    for (const client of [a, b]) {
      client.send({ type: 'hello', token: 'secret' });
      const welcome = await client.next();
      assert.deepEqual(welcome.sessions, sessions);
      assert.deepEqual(welcome.capabilities, ['session-control']);
    }
    a.send({ type: 'select-session', sessionId: 'b', requestId: 'switch-1' });
    assert.equal((await a.next((m) => m.type === 'session')).session.id, 'b');
    assert.equal((await b.next()).session.id, 'b');
    assert.deepEqual(await a.next(), { type: 'session-selected', requestId: 'switch-1' });
    a.send({ type: 'scan', id: 'queued', data: '00001', scannedAt: 1, sessionId: 'a', sessionName: 'Morning' });
    await a.next((m) => m.type === 'ack');
    assert.equal(scans[0].sessionId, 'a');
    a.send({ type: 'select-session', sessionId: 'missing', requestId: 'switch-2' });
    const error = await a.next();
    assert.equal(error.code, 'session-unavailable');
    assert.equal(error.requestId, 'switch-2');
    assert.equal(error.id, undefined);
    assert.equal(active.id, 'b');
    a.ws.close(); b.ws.close();
  });
});

test('a failed session save reports the request failure without acknowledging or rejecting scans', () =>
  withServer({ onSelectSession: () => { throw new Error('disk full'); } }, async ({ server }) => {
    const c = connect(server.port); await c.opened;
    c.send({ type: 'hello', token: 'secret' }); await c.next();
    c.send({ type: 'select-session', sessionId: 'default', requestId: 'selection' });
    const error = await c.next();
    assert.equal(error.code, 'session-unavailable');
    assert.equal(error.requestId, 'selection');
    assert.equal(error.id, undefined);
    c.ws.close();
  }));
