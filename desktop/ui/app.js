'use strict';
import { repeatedBarcodes, connectionLabel } from './scan-view.js';

const MAX_ROWS = 500;
const $ = (id) => document.getElementById(id);

const state = { scans: [], devices: [], pairing: null, settings: {}, sessions: { items: [], activeId: 'default' }, typingSupported: true };
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
      el('li', {}, el('span', { className: 'name', textContent: d.device }), el('span', { className: 'meta', title: d.address, textContent: `${connectionLabel(d)} · since ${formatTime(d.since)}` })),
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

function renderBluetooth() {
  const b = state.bluetooth || { status: 'off' };
  const button = $('bluetooth-toggle');
  button.hidden = b.status === 'unsupported';
  button.disabled = b.status === 'starting';
  button.textContent = b.status === 'starting' ? 'Starting Bluetooth…' : b.enabled || ['ready', 'waiting'].includes(b.status) ? 'Turn off Bluetooth connection' : 'Enable Bluetooth';
  $('bluetooth-status').textContent = b.status === 'ready'
    ? 'Bluetooth ready. Scan this QR code, then choose Change connection → Bluetooth on the CT45. Allow Nearby devices when asked.'
    : ['error', 'waiting'].includes(b.status) ? b.message
    : b.status === 'unsupported' ? 'Bluetooth connections are currently available on macOS.'
    : 'Bluetooth works nearby without a shared Wi-Fi network. Your scans stay encrypted.';
}

function filteredScans() {
  const q = $('search').value.trim().toLowerCase();
  const id = $('view-session').value;
  return state.scans.filter((s) => (!id || (s.sessionId || 'default') === id) && (!q || s.data.toLowerCase().includes(q) || (s.symbology || '').toLowerCase().includes(q)));
}

function renderScans() {
  const viewId = $('view-session').value;
  const total = state.scans.filter((s) => !viewId || (s.sessionId || 'default') === viewId).length;
  const list = filteredScans();
  const q = $('search').value.trim();
  $('count').textContent = q ? `${plural(list.length, 'match', 'matches')} of ${plural(total, 'scan')}` : plural(total, 'scan');
  $('count').hidden = total === 0 && !q;
  $('empty').hidden = list.length > 0;
  $('empty-title').textContent = q ? 'No matching scans' : viewId ? 'No scans in this session' : 'No scans yet';
  $('empty-hint').textContent = q ? 'Try another search or clear it to see the scans in this view.'
    : viewId ? 'Choose this session under Scanning into to add scans, or show another session.'
    : 'Scan a barcode with the CT45 and it shows up here.';
  $('clear-search').hidden = !q;
  $('table').hidden = list.length === 0;
  for (const id of ['copy-all', 'export', 'export-csv']) $(id).disabled = list.length === 0;
  $('clear').disabled = total === 0;

  const shown = list.slice(0, MAX_ROWS);
  const repeats = repeatedBarcodes(state.scans);
  $('rows').replaceChildren(
    ...shown.map((s) => {
      const row = el(
        'tr',
        { title: 'Click to copy' },
        el('td', { className: 'time', textContent: formatTime(s.scannedAt) }),
        el('td', { className: 'data' }, el('span', { textContent: visible(s.data) }),
          ...(repeats(s) > 1 ? [el('span', { className: 'repeat-badge', title: 'Repeated barcode in this session; every scan is kept', textContent: `Seen ${repeats(s)}×` })] : [])),
        el('td', { className: 'kind', textContent: s.symbology || '—' }),
        el('td', { className: 'device', textContent: s.device }),
        el('td', { className: 'session', textContent: s.sessionName || 'General' }),
        el('td', { className: 'row-action' }, el('button', { type: 'button', className: 'btn small copy-scan', textContent: 'Copy', ariaLabel: `Copy barcode ${visible(s.data)}` })),
      );
      row.dataset.id = s.id;
      if (s.id === newestId) row.classList.add('new');
      return row;
    }),
  );
  $('truncated').hidden = list.length <= MAX_ROWS;
  $('truncated').textContent = `Showing the newest ${MAX_ROWS.toLocaleString()}. Search to find older scans, or export the current view.`;
}

function renderSessions() {
  const view = $('view-session').value;
  const options = () => state.sessions.items.map((s) => el('option', { value: s.id, textContent: s.name }));
  $('active-session').replaceChildren(...options());
  $('active-session').value = state.sessions.activeId;
  $('view-session').replaceChildren(el('option', { value: '', textContent: 'All sessions' }), ...options());
  $('view-session').value = state.sessions.items.some((s) => s.id === view) ? view : '';
}

function render() {
  renderSessions();
  renderConnection();
  renderPairing();
  renderSettings();
  renderBluetooth();
  renderScans();
}

async function saveSettings(patch) {
  state.settings = await window.ct45.setSettings(patch);
  renderSettings();
}

window.ct45.on('sessions', (sessions) => { state.sessions = sessions; renderSessions(); renderScans(); });
window.ct45.on('bluetooth', (bluetooth) => { state.bluetooth = bluetooth; renderBluetooth(); });
$('bluetooth-toggle').addEventListener('click', async () => {
  try { state.bluetooth = await window.ct45.setBluetooth(!(state.bluetooth?.enabled || ['ready', 'waiting'].includes(state.bluetooth?.status))); renderBluetooth(); }
  catch { toast('Could not change Bluetooth settings.'); }
});

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
  else if (result.reason === 'focused') status.textContent = 'Not typed: CT45 Computer Link was the active window. Click into the app you want scans typed into.';
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
$('clear-search').addEventListener('click', () => { $('search').value = ''; renderScans(); $('search').focus(); });

$('copy-all').addEventListener('click', async () => {
  const list = filteredScans();
  await window.ct45.copy(list.map((s) => s.data).join('\n'));
  toast(`Copied ${plural(list.length, 'scan')}, newest first`);
});

async function exportScans(format) {
  try {
    const result = await window.ct45.exportScans({ format, sessionId: $('view-session').value, query: $('search').value });
    if (!result.canceled) toast(`Exported ${plural(result.count, 'scan')}`);
  } catch { toast('Could not save the export. Try another location.'); }
}
$('export').addEventListener('click', () => exportScans('xlsx'));
$('export-csv').addEventListener('click', () => exportScans('csv'));
$('view-session').addEventListener('change', () => { $('clear-confirm').hidden = true; renderScans(); });
$('active-session').addEventListener('change', async (e) => {
  try { state.sessions = await window.ct45.activateSession(e.target.value); renderSessions(); }
  catch { renderSessions(); toast('Could not save the active session.'); }
});
$('new-session').addEventListener('click', () => { $('session-form').hidden = false; $('session-name').focus(); });
$('session-cancel').addEventListener('click', () => { $('session-form').hidden = true; });
$('session-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('session-name').value.trim();
  if (!name) return;
  try {
    state.sessions = await window.ct45.createSession(name);
    renderSessions();
    $('view-session').value = state.sessions.activeId;
    $('search').value = '';
    $('session-form').hidden = true;
    $('session-name').value = '';
    renderScans();
    toast(`Started ${name}`);
  } catch { toast('Could not save the new session. Check available disk space.'); }
});

$('clear').addEventListener('click', () => {
  $('clear-question').textContent = `Clear scans from ${$('view-session').selectedOptions[0].textContent}? This includes search results and hidden matches. Export first if you need them.`;
  $('clear-confirm').hidden = false;
  $('clear-no').focus();
});
$('clear-no').addEventListener('click', () => ($('clear-confirm').hidden = true));
$('clear-yes').addEventListener('click', async () => {
  try {
    state.scans = await window.ct45.clearScans($('view-session').value);
    $('clear-confirm').hidden = true;
    renderScans();
    toast('Scans cleared');
  } catch { toast('Could not clear scans. Check available disk space.'); }
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
  try {
    state.pairing = await window.ct45.newPairingCode();
    $('new-code-confirm').hidden = true;
    renderPairing();
    toast('New pairing code ready');
  } catch { toast('Could not create a new pairing code. Check available disk space and try again.'); }
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
