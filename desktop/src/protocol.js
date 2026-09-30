// Messages between the CT45 app and this computer. docs/protocol.md has the full description;
// android/.../Protocol.kt is the other half and must stay in step with this file.

import crypto from 'node:crypto';

export const PROTOCOL_VERSION = 2;
export const PAIR_PREFIX = 'ct45tracker://pair';
export const MAX_DATA_LENGTH = 8192;

export function newToken() {
  return crypto.randomBytes(12).toString('base64url');
}

export function tokensMatch(expected, given) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(given ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The QR code the CT45 scans to pair. Kept short so the code stays easy to scan from a screen.
export function pairingUrl({ hosts, port, token, name, computerId, fingerprint, bluetoothService }) {
  const q = new URLSearchParams({ v: '2', h: hosts.join(','), p: String(port), t: token, id: computerId, fp: fingerprint });
  if (name) q.set('n', name);
  if (bluetoothService) q.set('bt', bluetoothService);
  return `${PAIR_PREFIX}?${q}`;
}

export function parsePairingUrl(text) {
  if (!String(text).startsWith(`${PAIR_PREFIX}?`)) return null;
  const q = new URLSearchParams(String(text).slice(PAIR_PREFIX.length + 1));
  const hosts = (q.get('h') ?? '').split(',').filter(Boolean);
  const port = Number(q.get('p'));
  const token = q.get('t');
  if (!hosts.length || !Number.isInteger(port) || port < 1 || port > 65535 || !token) return null;
  const computerId = q.get('id');
  const fingerprint = q.get('fp');
  if (q.get('v') !== '2' || !/^[a-zA-Z0-9-]{1,64}$/.test(computerId || '') || !/^[a-f0-9]{64}$/.test(fingerprint || '')) return null;
  const bluetoothService = q.get('bt');
  if (bluetoothService && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bluetoothService)) return null;
  return { hosts, port, token, name: q.get('n') ?? '', computerId, fingerprint, ...(bluetoothService && { bluetoothService: bluetoothService.toLowerCase() }) };
}

const isShortString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const optionalString = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);

// Returns { ok: true, msg } or { ok: false, error, id? }. Only fields we use are passed
// through. A rejected scan's id is returned when it has a usable one, so the CT45 can stop
// sending that scan instead of retrying it forever.
export function parseClientMessage(raw) {
  let m;
  try {
    m = JSON.parse(String(raw));
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (!m || typeof m !== 'object') return { ok: false, error: 'not an object' };
  const result = checkMessage(m);
  if (!result.ok && isShortString(m.id, 64)) result.id = m.id;
  return result;
}

function checkMessage(m) {
  switch (m.type) {
    case 'select-session':
      if (!isShortString(m.sessionId, 64) || !isShortString(m.requestId, 64)) return { ok: false, error: 'invalid session selection' };
      return { ok: true, msg: { type: m.type, sessionId: m.sessionId, requestId: m.requestId } };
    case 'hello':
      if (!isShortString(m.token, 128)) return { ok: false, error: 'hello needs a token' };
      if (!optionalString(m.device, 100)) return { ok: false, error: 'bad device name' };
      return { ok: true, msg: { type: 'hello', token: m.token, device: m.device || 'Scanner', app: String(m.app ?? '') } };
    case 'scan':
      if (!isShortString(m.id, 64)) return { ok: false, error: 'scan needs an id' };
      if (!isShortString(m.data, MAX_DATA_LENGTH)) return { ok: false, error: 'scan needs data' };
      if (!Number.isFinite(m.scannedAt)) return { ok: false, error: 'scan needs scannedAt' };
      if (!optionalString(m.aimId, 8) || !optionalString(m.codeId, 8)) return { ok: false, error: 'bad symbology' };
      if (m.sentAt !== undefined && !Number.isFinite(m.sentAt)) return { ok: false, error: 'bad sentAt' };
      if (!optionalString(m.sessionId, 64) || !optionalString(m.sessionName, 80)) return { ok: false, error: 'bad session' };
      return {
        ok: true,
        msg: {
          type: 'scan',
          id: m.id,
          data: m.data,
          scannedAt: m.scannedAt,
          // When the CT45 sent it, by its own clock. Older app versions leave it out.
          sentAt: m.sentAt ?? null,
          aimId: m.aimId || '',
          codeId: m.codeId || '',
          sessionId: m.sessionId || '',
          sessionName: m.sessionName || '',
        },
      };
    default:
      return { ok: false, error: `unknown type ${JSON.stringify(m.type)}` };
  }
}
