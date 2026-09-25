'use strict';

const MAX_ROWS = 500;
const $ = (id) => document.getElementById(id);

const state = { scans: [], devices: [], pairing: null, settings: {}, typingSupported: true };
let newestId = null;
let toastTimer;

// Scanners send separators (GS in GS1 codes) and line endings; show them instead of hiding them.
function visible(text) {
  return String(text).replace(/[\u0000-\u001f]/g, (c) => String.fromCharCode(0x2400 + c.charCodeAt(0))).replace(/\u007f/g, '␡');
}

function plural(n, word, many = `${word}s`) {
  return `${n.toLocaleString()} ${n === 1 ? word : many}`;
}

function formatTime(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function renderConnection() {
  const n = state.devices.length;
  const box = $('connection');
  box.classList.toggle('on', n > 0);
  $('connection-text').textContent =
    n === 0 ? 'Waiting for a scanner' : n === 1 ? `${state.devices[0].device} connected` : `${n} scanners connected`;

  $('devices').hidden = n === 0;
  $('device-list').replaceChildren(
    ...state.devices.map((d) =>
      el('li', {}, el('span', { className: 'name', textContent: d.device }), el('span', { className: 'meta', textContent: `${d.address} · since ${formatTime(d.since)}` })),
    ),
  );
  // Once something is connected the QR code only matters for adding another scanner.
  const pair = $('pair');
  if (pair.dataset.auto !== String(n > 0)) {
    pair.open = n === 0;
    pair.dataset.auto = String(n > 0);
    $('pair-title').querySelector('h2').textContent = n === 0 ? 'Connect a scanner' : 'Connect another scanner';
  }
}

function renderPairing() {
  const p = state.pairing;
  if (!p) return;
  $('qr').src = p.qr;
  $('pair-address').textContent = p.hosts.length ? `${p.hosts[0]} : ${p.port}` : '';
  $('pair-address').title = p.hosts.map((h) => `${h}:${p.port}`).join('\n');
  $('no-network').hidden = p.hosts.length > 0;
}

function renderSettings() {
  const { typing, suffix } = state.settings;
  $('typing').checked = !!typing;
  $('typing').disabled = !state.typingSupported;
  $('suffix').disabled = !typing || !state.typingSupported;
  for (const r of document.querySelectorAll('input[name=suffix]')) r.checked = r.value === suffix;
  $('typing-unsupported').hidden = state.typingSupported;
  if (!typing) {
    $('typing-status').hidden = true;
    $('permission').hidden = true;
  }
}

function filteredScans() {
  const q = $('search').value.trim().toLowerCase();
  return q ? state.scans.filter((s) => s.data.toLowerCase().includes(q) || (s.symbology || '').toLowerCase().includes(q)) : state.scans;
}

function renderScans() {
  const total = state.scans.length;
  const list = filteredScans();
  const q = $('search').value.trim();
  $('count').textContent = q ? `${plural(list.length, 'match', 'matches')} of ${plural(total, 'scan')}` : plural(total, 'scan');
  $('count').hidden = total === 0;
  $('empty').hidden = total > 0;
  $('table').hidden = list.length === 0;
  for (const id of ['copy-all', 'export', 'clear']) $(id).disabled = total === 0;

  const shown = list.slice(0, MAX_ROWS);
  $('rows').replaceChildren(
    ...shown.map((s) => {
      const row = el(
        'tr',
        { title: 'Click to copy' },
        el('td', { className: 'time', textContent: formatTime(s.scannedAt) }),
        el('td', { className: 'data', textContent: visible(s.data) }),
        el('td', { className: 'kind', textContent: s.symbology || '—' }),
        el('td', { className: 'device', textContent: s.device }),
      );
      row.dataset.id = s.id;
      if (s.id === newestId) row.classList.add('new');
      return row;
    }),
  );
  $('truncated').hidden = list.length <= MAX_ROWS;
  $('truncated').textContent = `Showing the newest ${MAX_ROWS.toLocaleString()}. Search to find older scans, or export them all to CSV.`;
}

function render() {
  renderConnection();
  renderPairing();
  renderSettings();
  renderScans();
}

async function saveSettings(patch) {
  state.settings = await window.ct45.setSettings(patch);
  renderSettings();
}

// Events from the main process
window.ct45.on('scan', (scan) => {
  state.scans.unshift(scan);
  // Flash the new row once; later re-renders shouldn't flash it again.
  newestId = scan.id;
  renderScans();
  newestId = null;
});
window.ct45.on('devices', (devices) => {
  state.devices = devices;
  renderConnection();
});
window.ct45.on('pairing', (pairing) => {
  state.pairing = pairing;
  renderPairing();
});
window.ct45.on('typing', (result) => {
  const status = $('typing-status');
  status.hidden = false;
  $('permission').hidden = result.reason !== 'permission';
  if (result.ok) status.textContent = `Typed ${visible(result.data)}`;
  else if (result.reason === 'focused') status.textContent = 'Not typed: CT45 Tracker was the active window. Click into the app you want scans typed into.';
  else if (result.reason === 'delayed') status.textContent = `Not typed: ${visible(result.data)} was scanned while the CT45 was disconnected. It's in the list.`;
  else if (result.reason === 'permission') status.textContent = `Not typed: ${visible(result.data)}`;
  else status.textContent = `Couldn't type the scan: ${result.message}`;
});

// Controls
$('rows').addEventListener('click', async (e) => {
  const row = e.target.closest('tr');
  const scan = row && state.scans.find((s) => s.id === row.dataset.id);
  if (!scan) return;
  await window.ct45.copy(scan.data);
  toast(`Copied ${visible(scan.data)}`);
});

$('search').addEventListener('input', renderScans);

$('copy-all').addEventListener('click', async () => {
  const list = filteredScans();
  await window.ct45.copy(list.map((s) => s.data).join('\n'));
  toast(`Copied ${plural(list.length, 'scan')}, newest first`);
});

$('export').addEventListener('click', async () => {
  const result = await window.ct45.exportCsv();
  if (!result.canceled) toast(`Exported ${plural(result.count, 'scan')}`);
});

$('clear').addEventListener('click', () => {
  $('clear-question').textContent = `Clear all ${plural(state.scans.length, 'scan')}? Export first if you need them.`;
  $('clear-confirm').hidden = false;
  $('clear-no').focus();
});
$('clear-no').addEventListener('click', () => ($('clear-confirm').hidden = true));
$('clear-yes').addEventListener('click', async () => {
  state.scans = await window.ct45.clearScans();
  $('clear-confirm').hidden = true;
  renderScans();
  toast('Scans cleared');
});

$('copy-link').addEventListener('click', async () => {
  await window.ct45.copy(state.pairing.url);
  toast('Pairing link copied');
});
$('new-code').addEventListener('click', () => {
  $('new-code-confirm').hidden = false;
  $('new-code-no').focus();
});
$('new-code-no').addEventListener('click', () => ($('new-code-confirm').hidden = true));
$('new-code-yes').addEventListener('click', async () => {
  state.pairing = await window.ct45.newPairingCode();
  $('new-code-confirm').hidden = true;
  renderPairing();
  toast('New pairing code ready');
});

$('typing').addEventListener('change', (e) => saveSettings({ typing: e.target.checked }));
$('suffix').addEventListener('change', (e) => saveSettings({ suffix: e.target.value }));
$('open-accessibility').addEventListener('click', () => window.ct45.openAccessibilitySettings());

window.ct45.getState().then((initial) => {
  Object.assign(state, initial);
  render();
});
// Keep "since 9:14" and today-vs-yesterday labels current.
setInterval(() => {
  renderConnection();
  renderScans();
}, 60_000);
