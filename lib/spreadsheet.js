'use strict';
/**
 * Zero-dependency spreadsheet reader for product import.
 *
 * Supports:
 *  - .xlsx / .xlsm  (a ZIP container of OOXML parts; ZIP central directory is
 *    walked by hand and entries are inflated with node:zlib)
 *  - .csv / .txt    (RFC 4180 quoting, BOM, comma/semicolon/tab detection)
 *
 * Only what a shop actually uploads is parsed: the first sheet with data,
 * shared or inline strings, numbers and formula results. Styles, formulas and
 * pivot parts are ignored on purpose.
 */
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Read every file of a ZIP archive into a Map<name, Buffer>. */
function unzip(buf) {
  if (buf.length < 22) throw new Error('EMPTY_FILE');
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('NOT_A_SPREADSHEET');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) throw new Error('CORRUPT_ARCHIVE');

  const files = new Map();
  let ptr = cdOffset;
  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CD_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    if (localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === LFH_SIG) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, Math.min(start + compSize, buf.length));
      if (compSize > MAX_ENTRY_BYTES) throw new Error('FILE_TOO_LARGE');
      try {
        if (method === 0) files.set(name, Buffer.from(raw));
        else if (method === 8) files.set(name, zlib.inflateRawSync(raw));
        // Other methods (bzip2, lzma, zstd) never appear in Excel files.
      } catch { /* skip unreadable entry, keep the rest usable */ }
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  if (!files.size) throw new Error('CORRUPT_ARCHIVE');
  return files;
}

function decodeEntities(text) {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (m, hex, dec, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name];
  });
}

function textOf(xml) {
  return [...String(xml).matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeEntities(m[1])).join('');
}

function parseSharedStrings(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) out.push(textOf(m[1]));
  return out;
}

function columnIndex(ref) {
  const m = /^([A-Z]+)/i.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const rowMatch of String(xml).matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowRef = /r="(\d+)"/.exec(rowMatch[1]);
    const rowIndex = rowRef ? Number(rowRef[1]) - 1 : rows.length;
    const cells = [];
    for (const cell of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] || '';
      const inner = cell[2] || '';
      const ref = /r="([A-Z]+\d+)"/i.exec(attrs);
      const index = ref ? columnIndex(ref[1]) : cells.length;
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || 'n';
      let value = '';
      if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? (shared[Number(v[1])] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textOf(inner);
      } else if (type === 'b') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v && v[1] === '1' ? 'TRUE' : 'FALSE';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? decodeEntities(v[1]) : '';
      }
      if (index >= 0) cells[index] = value;
    }
    rows[rowIndex] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  // Drop fully empty trailing rows.
  while (rows.length && rows[rows.length - 1].every(v => v === undefined || String(v).trim() === '')) rows.pop();
  return rows;
}

function readXlsx(buf) {
  const files = unzip(buf);
  const shared = files.has('xl/sharedStrings.xml') ? parseSharedStrings(files.get('xl/sharedStrings.xml').toString('utf8')) : [];
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const targets = new Map();
  for (const r of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(r[1])?.[1];
    const target = /Target="([^"]+)"/.exec(r[1])?.[1];
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const sheets = [];
  for (const s of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = decodeEntities(/name="([^"]*)"/.exec(s[1])?.[1] || '');
    const rid = /r:id="([^"]+)"/.exec(s[1])?.[1];
    const target = rid ? targets.get(rid) : null;
    if (!target) continue;
    const file = files.get('xl/' + target) || files.get(target);
    if (!file) continue;
    sheets.push({ name, rows: parseSheet(file.toString('utf8'), shared) });
  }
  if (!sheets.length) {
    const key = [...files.keys()].find(k => /^xl\/worksheets\/[^/]+\.xml$/.test(k));
    if (!key) throw new Error('EMPTY_WORKBOOK');
    sheets.push({ name: 'Sheet1', rows: parseSheet(files.get(key).toString('utf8'), shared) });
  }
  return sheets;
}

function detectDelimiter(line) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts[ch] !== undefined) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ',';
}

function parseCsv(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = detectDelimiter(firstLine);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every(v => String(v).trim() === '')) rows.pop();
  return rows;
}

/**
 * Turn any supported upload into `{ rows, sheetName, format }`.
 * `filename` is only a hint; the content is sniffed so a renamed CSV still works.
 */
function looksLikeText(buffer) {
  const sample = buffer.subarray(0, 4096);
  return !sample.includes(0) && !sample.some(byte => byte < 9 || (byte > 13 && byte < 32));
}

function readTable(buffer, filename = '') {
  const name = String(filename).toLowerCase();
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK"
  // Content wins: a real workbook is a ZIP. An .xlsx name without ZIP content is
  // a corrupt/renamed file, which the user must hear about explicitly.
  if (!isZip && /\.(xlsx|xlsm)$/.test(name)) throw new Error('NOT_A_SPREADSHEET');
  if (!isZip && !looksLikeText(buffer)) throw new Error('NOT_A_SPREADSHEET');
  if (isZip) {
    const sheets = readXlsx(buffer);
    const best = sheets
      .map(s => ({ ...s, filled: s.rows.filter(r => r.some(v => String(v).trim() !== '')).length }))
      .sort((a, b) => b.filled - a.filled)[0];
    if (!best || !best.filled) throw new Error('EMPTY_WORKBOOK');
    return { rows: best.rows, sheetName: best.name, format: 'xlsx' };
  }
  return { rows: parseCsv(buffer.toString('utf8')), sheetName: '', format: 'csv' };
}

module.exports = { readTable, parseCsv, readXlsx, unzip };
