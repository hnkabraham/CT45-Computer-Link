import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export const GENERAL_SESSION = { id: 'default', name: 'General', createdAt: 0 };
export class Sessions {
  constructor(file) {
    this.file = file;
    try { this.state = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.state = { activeId: 'default', items: [GENERAL_SESSION] };
    }
    if (!Array.isArray(this.state.items) || !this.active) throw new Error('Invalid sessions file');
  }
  get active() { return this.state.items.find((s) => s.id === this.state.activeId); }
  save(next) {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.state = next;
  }
  create(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Use a session name of 1–80 characters');
    const s = { id: randomUUID(), name: name.trim(), createdAt: Date.now() };
    this.save({ activeId: s.id, items: [...this.state.items, s] });
    return this.state;
  }
  activate(id) {
    if (!this.state.items.some((s) => s.id === id)) throw new Error('Unknown session');
    this.save({ ...this.state, activeId: id });
    return this.state;
  }
  // Offline scans retain the session known by the scanner when captured. Unknown sessions
  // (e.g. after restoring a desktop backup) are recovered with their original name and id.
  resolve(msg) {
    if (!msg.sessionId) return GENERAL_SESSION;
    let s = this.state.items.find((s) => s.id === msg.sessionId);
    if (!s) {
      s = { id: msg.sessionId, name: msg.sessionName || 'Recovered session', createdAt: Date.now() };
      this.save({ ...this.state, items: [...this.state.items, s] });
    }
    return s;
  }
}

export function selectScans(scans, { sessionId = '', query = '' } = {}) {
  const q = String(query).trim().toLowerCase();
  return scans.filter((s) => (!sessionId || (s.sessionId || 'default') === sessionId)
    && (!q || s.data.toLowerCase().includes(q) || (s.symbology || '').toLowerCase().includes(q)));
}
