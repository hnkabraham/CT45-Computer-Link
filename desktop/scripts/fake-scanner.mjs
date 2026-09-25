// Pretends to be the CT45 app, for trying the desktop app without the device.
//   npm run fake-scanner -- "<pairing link>" 0123456789012 ABC-123
// Get the pairing link from "Copy pairing link" in the app.

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { parsePairingUrl } from '../src/protocol.js';

export async function fakeScan(link, barcodes, { device = 'Fake CT45', host } = {}) {
  const pairing = parsePairingUrl(link);
  if (!pairing) throw new Error('That is not a CT45 Computer Link pairing link.');
  const url = `wss://${host ?? pairing.hosts[0]}:${pairing.port}`;
  const ws = new WebSocket(url, { rejectUnauthorized: false });
  const inbox = [];
  let wake = () => {};
  ws.on('message', (m) => {
    inbox.push(JSON.parse(m));
    wake();
  });
  const next = async (pred) => {
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await new Promise((r) => (wake = r));
    }
  };
  await new Promise((resolve, reject) => {
    ws.once('open', () => {
      const raw = ws._socket.getPeerCertificate().raw;
      const pin = crypto.createHash('sha256').update(raw).digest('hex');
      if (pin !== pairing.fingerprint) { ws.terminate(); reject(new Error('Computer certificate does not match the pairing code')); }
      else resolve();
    });
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'hello', token: pairing.token, device, app: 'fake-scanner' }));
  const reply = await next((m) => m.type === 'welcome' || m.type === 'error');
  if (reply.type === 'error') { ws.close(); throw new Error(reply.message); }

  for (const data of barcodes) {
    const id = crypto.randomUUID();
    ws.send(JSON.stringify({ type: 'scan', id, data, scannedAt: Date.now(), aimId: ']C0', codeId: 'j', sessionId: reply.session.id, sessionName: reply.session.name }));
    await next((m) => m.id === id);
  }
  return { ws, computer: reply.name };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [link, ...barcodes] = process.argv.slice(2);
  if (!link || !barcodes.length) {
    console.error('Usage: npm run fake-scanner -- "<pairing link>" <barcode> [more barcodes]');
    process.exit(1);
  }
  const { ws, computer } = await fakeScan(link, barcodes);
  console.log(`Sent ${barcodes.length} scan(s) to ${computer}.`);
  ws.close();
}
