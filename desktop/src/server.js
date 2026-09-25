import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, parseClientMessage, tokensMatch } from './protocol.js';

const HELLO_TIMEOUT_MS = 5000;
// Slow, to spare the CT45's battery. A scanner that closes the app or loses the pairing drops
// off the list at once; only one that vanishes silently (out of Wi-Fi range) takes up to two
// minutes.
const PING_EVERY_MS = 60_000;

// Close codes the CT45 app understands (see docs/protocol.md).
export const CLOSE_BAD_TOKEN = 4001;
export const CLOSE_NO_HELLO = 4002;
export const CLOSE_REPAIRED = 4003;

// Listens for CT45 scanners. Tries `port` and the next few if it's taken, because another
// copy of an app may be holding it; the pairing QR code always shows the port actually used.
export async function startServer({
  port,
  getToken,
  computerName,
  onScan,
  onDevicesChanged = () => {},
  helloTimeoutMs = HELLO_TIMEOUT_MS,
  pingEveryMs = PING_EVERY_MS,
  portAttempts = 10,
}) {
  let wss;
  let boundPort;
  for (let p = port; p < port + portAttempts; p++) {
    try {
      wss = await listen(p);
      boundPort = p;
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || p === port + portAttempts - 1) throw e;
    }
  }

  const devices = new Map(); // ws -> { device, address, since }
  const deviceList = () => [...devices.values()].sort((a, b) => a.since - b.since);
  const changed = () => onDevicesChanged(deviceList());

  wss.on('connection', (ws, req) => {
    const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    let alive = true;
    ws.on('pong', () => (alive = true));
    const helloTimer = setTimeout(() => ws.close(CLOSE_NO_HELLO, 'no hello'), helloTimeoutMs);

    const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

    // One message at a time, in order, even if saving a scan ever becomes asynchronous: a
    // burst from the outbox must be stored and acknowledged in the order it was scanned.
    let queue = Promise.resolve();
    ws.on('message', (raw) => {
      queue = queue.then(() => handleMessage(raw)).catch(() => {});
    });

    async function handleMessage(raw) {
      const parsed = parseClientMessage(raw);
      if (!parsed.ok) {
        return send({ type: 'error', code: 'bad-message', message: parsed.error, ...(parsed.id && { id: parsed.id }) });
      }
      const { msg } = parsed;

      if (msg.type === 'hello') {
        clearTimeout(helloTimer);
        if (!tokensMatch(getToken(), msg.token)) {
          send({ type: 'error', code: 'bad-token', message: 'This pairing code is no longer valid. Scan the new one.' });
          return ws.close(CLOSE_BAD_TOKEN, 'bad token');
        }
        devices.set(ws, { device: msg.device, address, since: Date.now() });
        send({ type: 'welcome', name: computerName(), version: PROTOCOL_VERSION });
        return changed();
      }

      if (!devices.has(ws)) return send({ type: 'error', code: 'not-paired', message: 'Send hello first.' });

      if (msg.type === 'scan') {
        try {
          await onScan({ ...msg, device: devices.get(ws).device, address });
          send({ type: 'ack', id: msg.id });
        } catch (e) {
          // No ack: the scanner keeps the scan queued and sends it again.
          send({ type: 'error', code: 'save-failed', message: String(e?.message ?? e), id: msg.id });
        }
      }
    }

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (devices.delete(ws)) changed();
    });
    ws.on('error', () => {});

    // Wi-Fi drops don't close sockets cleanly; a missed pong means the scanner is gone.
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, pingEveryMs);
    ws.on('close', () => clearInterval(ping));
  });

  return {
    port: boundPort,
    devices: deviceList,
    // After a new pairing code, scanners holding the old one must re-pair.
    disconnectAll(code = CLOSE_REPAIRED, reason = 'pairing code changed') {
      for (const ws of devices.keys()) ws.close(code, reason);
    },
    close: () =>
      new Promise((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port, maxPayload: 64 * 1024 });
    wss.once('listening', () => resolve(wss));
    wss.once('error', reject);
  });
}
