import fs from 'node:fs';

// How many ids of cleared scans to remember (see clear()). The CT45 only resends scans it sent
// recently, so this is plenty.
const REMEMBER_CLEARED = 10_000;

// Scans are appended one JSON object per line, so a crash never loses earlier scans and a
// half-written last line only costs that one scan.
export class ScanStore {
  constructor(file) {
    this.file = file;
    this.scans = [];
    this.ids = new Set();
    this.needsRepair = false;
  }

  load() {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    // A crash can leave either partial JSON or a complete record without its newline.
    // Seal that tail before any new record is acknowledged, preserving complete records.
    if (text && !text.endsWith('\n')) fs.appendFileSync(this.file, '\n');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const scan = JSON.parse(line);
        if (scan?.id && !this.ids.has(scan.id)) {
          this.ids.add(scan.id);
          if (!scan.cleared) this.scans.push(scan);
        }
      } catch {
        // Skip a damaged line rather than refusing to start.
      }
    }
    return this;
  }

  has(id) {
    return this.ids.has(id);
  }

  // The scanner resends anything it hasn't seen acknowledged, so the same id can arrive twice.
  add(scan) {
    if (this.ids.has(scan.id)) return false;
    if (this.needsRepair) {
      let text = '';
      try {
        text = fs.readFileSync(this.file, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (text && !text.endsWith('\n')) fs.appendFileSync(this.file, '\n');
      this.needsRepair = false;
    }
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(scan)}\n`);
    } catch (e) {
      // A failed write can also leave a partial record during this process's lifetime.
      // Repair it on the next attempt, before accepting another scan.
      this.needsRepair = true;
      throw e;
    }
    this.ids.add(scan.id);
    this.scans.push(scan);
    return true;
  }

  // Newest first.
  list() {
    return [...this.scans].reverse();
  }

  // Only the ids are kept, even across restarts, so a scan the CT45 resends later (its
  // acknowledgement got lost) doesn't come back.
  clear() {
    const keep = [...this.ids].slice(-REMEMBER_CLEARED);
    fs.writeFileSync(this.file, keep.map((id) => `${JSON.stringify({ id, cleared: true })}\n`).join(''));
    this.ids = new Set(keep);
    this.scans = [];
  }
}
