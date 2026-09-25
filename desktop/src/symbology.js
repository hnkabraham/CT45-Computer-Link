// Human names for the barcode type. The CT45 reports both Honeywell's own code ID (more
// specific, e.g. UPC-A vs EAN-13) and the standard AIM identifier, so try Honeywell's first.

const HONEYWELL = {
  a: 'Codabar',
  b: 'Code 39',
  c: 'UPC-A',
  d: 'EAN-13',
  D: 'EAN-8',
  E: 'UPC-E',
  e: 'Interleaved 2 of 5',
  i: 'Code 93',
  j: 'Code 128',
  I: 'GS1-128',
  r: 'PDF417',
  s: 'QR Code',
  w: 'Data Matrix',
  x: 'MaxiCode',
  y: 'GS1 DataBar',
  z: 'Aztec',
};

// Keyed by the AIM code character, with a few modifier-specific names.
const AIM = {
  A: 'Code 39',
  C: 'Code 128',
  C1: 'GS1-128',
  d: 'Data Matrix',
  d2: 'GS1 Data Matrix',
  E: 'EAN/UPC',
  E4: 'EAN-8',
  e: 'GS1 DataBar',
  F: 'Codabar',
  G: 'Code 93',
  H: 'Code 11',
  I: 'Interleaved 2 of 5',
  L: 'PDF417',
  M: 'MSI',
  Q: 'QR Code',
  U: 'MaxiCode',
  z: 'Aztec',
};

// Own keys only: a code ID like "toString" must not find Object.prototype's.
const lookup = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

export function symbologyName({ codeId, aimId } = {}) {
  if (codeId && lookup(HONEYWELL, codeId)) return HONEYWELL[codeId];
  const m = /^\]([A-Za-z])(\w?)/.exec(aimId ?? '');
  if (m) return lookup(AIM, m[1] + m[2]) ?? lookup(AIM, m[1]) ?? '';
  return '';
}
