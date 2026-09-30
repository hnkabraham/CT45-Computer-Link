import { spawn } from 'node:child_process';
import net from 'node:net';

const MAX_BUFFER = 1024 * 1024;

// The helper is a byte carrier to this app's fixed local TLS port, never an arbitrary proxy.
// Both sides still verify the QR certificate and pairing token before exchanging scans.
export function startBluetooth({ executable, serviceId, port, onState = () => {}, spawnHelper = spawn, connect = net.connect }) {
  const peers = new Map();
  let stopped = false;
  let ready = false;
  let input = '';
  const child = spawnHelper(executable, [serviceId], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
  const state = (value) => { if (!stopped) onState(value); };
  const write = (value) => {
    if (stopped || child.stdin.destroyed) return;
    if (child.stdin.writableLength > MAX_BUFFER) return fail('Bluetooth stopped responding. Try enabling it again.');
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const close = (id) => {
    const peer = peers.get(id);
    peers.delete(id);
    peer?.destroy();
    write({ command: 'close', id });
  };
  const timeout = setTimeout(() => fail('Bluetooth could not start. Check Bluetooth permission in System Settings, then try again.'), 15000);
  function fail(message) {
    if (stopped) return;
    state({ status: 'error', message });
    stop();
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    for (const peer of peers.values()) peer.destroy();
    peers.clear();
    const kill = setTimeout(() => child.kill(), 1500);
    kill.unref();
    child.once('exit', () => clearTimeout(kill));
    child.stdin.end();
  }
  function handle(event) {
    if (event.event === 'ready') {
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(event.serviceId || '') || event.serviceId !== serviceId) return fail('Bluetooth service identity is unavailable.');
      ready = true;
      clearTimeout(timeout);
      state({ status: 'ready', serviceId: event.serviceId });
    } else if (event.event === 'waiting') {
      ready = false; clearTimeout(timeout);
      state({ status: 'waiting', serviceId, message: event.message });
    } else if (event.event === 'error') {
      fail(typeof event.message === 'string' ? event.message : 'Bluetooth is unavailable.');
    } else if (ready && typeof event.id === 'string' && event.id.length <= 64) {
      const id = event.id;
      if (event.event === 'open') {
        if (peers.size >= 4 || peers.has(id)) return close(id);
        const peer = connect({ host: '127.0.0.1', port });
        peers.set(id, peer);
        peer.setNoDelay(true);
        // One local chunk at a time: the helper acknowledges each completed Bluetooth write.
        peer.on('data', (data) => { peer.pause(); write({ command: 'write', id, data: data.toString('base64') }); });
        peer.on('error', () => close(id));
        peer.on('close', () => { if (peers.has(id)) close(id); });
      } else if (event.event === 'data') {
        const peer = peers.get(id);
        if (!peer) return;
        if (typeof event.data !== 'string' || event.data.length > 90000 || peer.writableLength > MAX_BUFFER) return close(id);
        peer.write(Buffer.from(event.data, 'base64'));
      } else if (event.event === 'written') peers.get(id)?.resume();
      else if (event.event === 'close') close(id);
    }
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_BUFFER) return fail('Bluetooth returned too much data.');
    let newline;
    while ((newline = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      try { const event = JSON.parse(line); if (event && typeof event === 'object') handle(event); }
      catch { return fail('Bluetooth returned an invalid response.'); }
    }
  });
  child.stderr.resume(); // Native diagnostics never include pairing secrets or scan contents.
  child.stdin.on('error', () => fail('Bluetooth connection stopped. Try enabling it again.'));
  child.on('error', () => fail('The Bluetooth helper could not start. Reinstall the desktop app.'));
  child.on('exit', () => fail('Bluetooth stopped. Check that the adapter is on, then try again.'));
  return { stop, closed };
}
