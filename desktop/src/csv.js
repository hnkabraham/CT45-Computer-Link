import { symbologyName } from './symbology.js';

const pad = (n) => String(n).padStart(2, '0');

// Local time, in a form Excel and Numbers both read as a date.
export function localTimestamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function csvField(value) {
  let s = String(value ?? '');
  // A barcode like =HYPERLINK(...) would run as a formula when the CSV is opened in a
  // spreadsheet. Plain numbers such as -12 or +44 are left alone.
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// Oldest first, which is how people read a log in a spreadsheet. The BOM and CRLF make Excel
// on Windows open it as UTF-8 with proper rows.
export function toCsv(scans) {
  const rows = [['Scanned at', 'Barcode', 'Type', 'Device', 'Session']];
  for (const s of [...scans].sort((a, b) => a.scannedAt - b.scannedAt)) {
    rows.push([localTimestamp(s.scannedAt), s.data, symbologyName(s), s.device, s.sessionName || 'General']);
  }
  return `﻿${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`;
}
