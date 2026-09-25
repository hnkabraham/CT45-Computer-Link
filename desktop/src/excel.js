import ExcelJS from 'exceljs';
import { localTimestamp } from './csv.js';
import { symbologyName } from './symbology.js';

// SpreadsheetML escapes preserve GS1 separators and protect literal strings like _x001D_.
// ExcelJS otherwise strips XML control characters and decodes literal escape sequences.
export function excelText(value) {
  return String(value ?? '').replace(/_x[0-9a-fA-F]{4}_/g, (s) => `_x005F_${s.slice(1)}`)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\ufffe\uffff]/g, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
}

export async function toExcel(scans) {
  const book = new ExcelJS.Workbook();
  book.creator = 'CT45 Computer Link';
  const sheet = book.addWorksheet('Scans', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    { header: 'Scanned at (local)', key: 'time', width: 23 },
    { header: 'Barcode', key: 'barcode', width: 42, style: { numFmt: '@' } },
    { header: 'Type', key: 'type', width: 18 },
    { header: 'Device', key: 'device', width: 24 },
    { header: 'Session', key: 'session', width: 28 },
  ];
  for (const s of [...scans].sort((a, b) => a.scannedAt - b.scannedAt)) {
    // Explicit string values, never numbers or formulas. Leading zeros, long identifiers and
    // formula-looking barcodes survive opening and saving in Excel without apostrophes.
    sheet.addRow([localTimestamp(s.scannedAt), excelText(s.data), excelText(symbologyName(s)), excelText(s.device), excelText(s.sessionName || 'General')]);
  }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF194D45' } };
  sheet.getRow(1).height = 24;
  sheet.autoFilter = { from: 'A1', to: `E${Math.max(1, sheet.rowCount)}` };
  return book.xlsx.writeBuffer();
}
