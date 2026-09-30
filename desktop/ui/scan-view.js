// Count intentional repeat scans, separately from transport resends (deduplicated by id).
export function repeatedBarcodes(scans) {
  const counts = new Map();
  for (const s of scans) {
    const key = JSON.stringify([s.sessionId || 'default', s.data]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return (scan) => counts.get(JSON.stringify([scan.sessionId || 'default', scan.data])) || 0;
}

export function connectionLabel(device) {
  if (device.transport === 'bluetooth') return 'Bluetooth';
  if (['127.0.0.1', '::1'].includes(device.address)) return 'Local connection';
  return 'Network';
}
