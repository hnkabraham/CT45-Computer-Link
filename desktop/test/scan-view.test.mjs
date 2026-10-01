import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repeatedBarcodes, connectionLabel } from '../ui/scan-view.js';

test('repeat markers count exact barcode values within each session without removing records', () => {
  const scans = [
    { id: '1', data: '00001', sessionId: 'a' }, { id: '2', data: '00001', sessionId: 'a' },
    { id: '3', data: '00001', sessionId: 'b' }, { id: '4', data: '1', sessionId: 'a' },
    { id: '5', data: 'ABC' }, { id: '6', data: 'ABC', sessionId: 'default' },
  ];
  const snapshot = structuredClone(scans);
  assert.deepEqual(scans.map(repeatedBarcodes(scans)), [2, 2, 1, 1, 2, 2]);
  assert.deepEqual(scans, snapshot);
});

test('loopback is labeled local without claiming USB transport', () => {
  assert.equal(connectionLabel({ address: '127.0.0.1', transport: 'network' }), 'Local connection');
  assert.equal(connectionLabel({ address: '127.0.0.1', transport: 'bluetooth' }), 'Bluetooth');
  assert.equal(connectionLabel({ address: '192.0.2.1', transport: 'network' }), 'Network');
});
