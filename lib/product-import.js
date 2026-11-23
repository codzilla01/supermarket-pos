'use strict';
/**
 * Product import: map a spreadsheet (Arabic or English headers) onto the
 * products table. Pure mapping/validation + a transactional applier, so the
 * same plan powers both the preview screen and the real import.
 */

const HEADER_ALIASES = {
  name: ['name', 'product', 'productname', 'item', 'itemname', 'description', 'اسم', 'الاسم', 'اسمالصنف', 'الصنف', 'المنتج', 'اسمالمنتج', 'بيان', 'البيان'],
  barcode: ['barcode', 'barcodeno', 'sku', 'code', 'itemcode', 'ean', 'الباركود', 'باركود', 'الكود', 'كود', 'كودالصنف', 'رمزالمنتج'],
  price: ['price', 'sellingprice', 'unitprice', 'retailprice', 'saleprice', 'سعر', 'السعر', 'سعرالبيع', 'سعرالوحدة', 'الثمن', 'سعرالتجزئة'],
  stock: ['stock', 'qty', 'quantity', 'onhand', 'instock', 'balance', 'المخزون', 'الكمية', 'الكميه', 'الرصيد', 'رصيد', 'رصيدالمخزون', 'العدد', 'المتوفر'],
  category: ['category', 'department', 'section', 'group', 'القسم', 'التصنيف', 'الفئة', 'المجموعة'],
  unit: ['unit', 'uom', 'measure', 'الوحدة', 'وحدةالقياس', 'وحدة'],
  tax: ['tax', 'taxrate', 'vat', 'taxpercent', 'الضريبة', 'نسبةالضريبة', 'ضريبة', 'ضريبةالقيمةالمضافة'],
  emoji: ['emoji', 'icon', 'الرمز', 'ايموجي', 'الايقونة'],
};

const CATEGORY_CANONICAL = {
  'خضار وفواكه': 'Produce', 'البان وبيض': 'Dairy & Eggs', 'مخبوزات': 'Bakery',
  'لحوم واسماك': 'Meat & Seafood', 'بقالة': 'Pantry', 'مشروبات': 'Beverages',
  'مجمدات': 'Frozen', 'وجبات خفيفة': 'Snacks', 'منظفات ومنزل': 'Household',
  'عناية شخصية': 'Personal Care', 'مستلزمات اطفال': 'Baby', 'اخرى': 'Other',
};

const UNIT_CANONICAL = {
  'كجم': 'kg', 'كيلو': 'kg', 'كيلوجرام': 'kg', 'كغ': 'kg', 'kg': 'kg', 'kgs': 'kg',
  'جم': 'g', 'جرام': 'g', 'g': 'g', 'gram': 'g', 'grams': 'g',
  'لتر': 'l', 'ليتر': 'l', 'l': 'l', 'lt': 'l', 'liter': 'l', 'litre': 'l',
  'قطعة': 'each', 'حبة': 'each', 'حبه': 'each', 'each': 'each', 'piece': 'each', 'pcs': 'each', 'pc': 'each', 'unit': 'each',
  'عبوة': 'pack', 'باكيت': 'pack', 'pack': 'pack',
  'علبة': 'box', 'box': 'box',
  'كيس': 'bag', 'bag': 'bag',
  'كرتونة': 'carton', 'كرتون': 'carton', 'carton': 'carton',
  'دستة': 'dozen', 'dozen': 'dozen',
};

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\uFB01]/g;
const DIACRITICS = /[\u064B-\u0652\u0670\u0640]/g;

/** Normalize a header cell so "سعر البيع", "سعرالبيع" and "Price " all match. */
function normKey(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(ZERO_WIDTH, '')
    .replace(DIACRITICS, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^0-9a-zA-Z\u0600-\u06FF]/g, '')
    .toLowerCase();
}

const ALIAS_LOOKUP = (() => {
  const map = new Map();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) map.set(normKey(alias), field);
  }
  return map;
})();

/** Arabic-Indic digits, thousands separators, currency words and percent signs. */
function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  if (!text) return null;
  const percent = /[%٪]/.test(text);
  text = text
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/\u066B/g, '.')
    .replace(/[\u066C\s\u00A0]/g, '')
    .replace(/(ج\.?\s*م|جنيه|ريال|درهم|دينار)/g, '')
    .replace(/(EGP|USD|EUR|GBP|SAR|AED)/gi, '')
    .replace(/[%٪$£€¥]/g, '');
  // 1,234.56 (comma thousands) vs 1.234,56 (comma decimal)
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) text = text.replace(/\./g, '').replace(',', '.');
  else if (text.includes(',') && !text.includes('.')) text = text.replace(',', '.');
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? { value: n, percent } : null;
}

function canonicalCategory(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const key = normKey(value);
  for (const [arabic, english] of Object.entries(CATEGORY_CANONICAL)) {
    if (key === normKey(arabic) || key === normKey(english)) return english;
  }
  return value.slice(0, 60);
}

/** Unit synonyms are normalized on both sides ("عبوة" → "عبوه", "Litre" → "litre"). */
const UNIT_LOOKUP = (() => {
  const map = new Map();
  for (const [alias, canonical] of Object.entries(UNIT_CANONICAL)) map.set(normKey(alias), canonical);
  return map;
})();

function canonicalUnit(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  return UNIT_LOOKUP.get(normKey(value)) || value.slice(0, 20);
}

function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 8);
  for (let i = 0; i < limit; i++) {
    const map = {};
    (rows[i] || []).forEach((cell, index) => {
      const field = ALIAS_LOOKUP.get(normKey(cell));
      if (field && map[field] === undefined) map[field] = index;
    });
    if (map.name !== undefined && map.price !== undefined) return { rowIndex: i, map };
  }
  return null;
}

function emptyRow(row) {
  return !row || row.every(v => String(v ?? '').trim() === '');
}

/**
 * Build an import plan.
 * @param {string[][]} rows            sheet rows (as returned by lib/spreadsheet)
 * @param {object[]} existingProducts  current active/inactive products
 * @param {{updateExisting?: boolean, defaultTaxRate?: number|null}} options
 */
function planImport(rows, existingProducts = [], options = {}) {
  const updateExisting = options.updateExisting !== false;
  const header = findHeaderRow(rows);
  if (!header) {
    return { ok: false, code: 'NO_NAME_COLUMN', headerLine: null, columns: [], entries: [], summary: { total: 0, create: 0, update: 0, skip: 0, error: 0 } };
  }

  const byBarcode = new Map();
  const byName = new Map();
  for (const p of existingProducts) {
    if (p.barcode) byBarcode.set(String(p.barcode).trim(), p);
    byName.set(normKey(p.name), p);
  }

  const columns = Object.entries(header.map).map(([field, index]) => ({
    field,
    index,
    label: String(rows[header.rowIndex][index] ?? '').trim(),
  }));

  const entries = [];
  const seenBarcodes = new Map();
  const pick = (row, field) => (header.map[field] === undefined ? undefined : String(row[header.map[field]] ?? '').trim());

  for (let r = header.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (emptyRow(row)) continue;
    const line = r + 1; // 1-based spreadsheet line for the user
    const name = (pick(row, 'name') || '').slice(0, 120);
    const rawBarcode = (pick(row, 'barcode') || '').slice(0, 30);
    const rawPrice = pick(row, 'price');
    const rawStock = pick(row, 'stock');
    const entry = {
      line, status: 'create', message: null, name,
      barcode: rawBarcode, category: '', unit: '', price: null, stock: 0, taxRate: null, emoji: '',
      productId: null, changes: [],
    };
    const fail = (message) => { entry.status = 'error'; entry.message = message; entries.push(entry); };

    if (!name) { fail('NAME_REQUIRED'); continue; }

    const price = parseNumber(rawPrice);
    if (!price || price.value < 0) { fail('BAD_PRICE'); continue; }
    entry.price = Math.round(price.value * 100) / 100;

    if (rawStock !== undefined && rawStock !== '') {
      const stock = parseNumber(rawStock);
      if (!stock || stock.value < 0) { fail('BAD_STOCK'); continue; }
      entry.stock = Math.trunc(stock.value);
    }

    const rawTax = pick(row, 'tax');
    if (rawTax !== undefined && rawTax !== '') {
      const tax = parseNumber(rawTax);
      if (!tax || tax.value < 0) { fail('BAD_TAX'); continue; }
      const fraction = tax.value > 1 || tax.percent ? tax.value / 100 : tax.value;
      if (fraction > 1) { fail('BAD_TAX'); continue; }
      entry.taxRate = Math.round(fraction * 10000) / 10000;
    }

    entry.category = canonicalCategory(pick(row, 'category'));
    entry.unit = canonicalUnit(pick(row, 'unit')) || 'each';
    entry.emoji = (pick(row, 'emoji') || '').slice(0, 8);

    if (rawBarcode) {
      if (seenBarcodes.has(rawBarcode)) { fail('DUPLICATE_BARCODE'); continue; }
      seenBarcodes.set(rawBarcode, line);
    }

    const match = (rawBarcode && byBarcode.get(rawBarcode)) || byName.get(normKey(name)) || null;
    if (match) {
      entry.productId = match.id;
      entry.existing = {
        name: match.name, price: match.price, stock: match.stock,
        category: match.category, unit: match.unit, tax_rate: match.tax_rate ?? null,
      };
      if (!updateExisting) { entry.status = 'skip'; entry.message = 'EXISTS_KEPT'; entries.push(entry); continue; }
      const diff = (field, next, prev) => { if (next !== undefined && next !== '' && next !== prev) entry.changes.push({ field, from: prev, to: next }); };
      diff('name', name, match.name);
      diff('price', entry.price, match.price);
      diff('stock', rawStock === undefined || rawStock === '' ? undefined : entry.stock, match.stock);
      diff('category', entry.category || match.category, match.category);
      diff('unit', entry.unit, match.unit);
      diff('tax_rate', entry.taxRate, match.tax_rate);
      entry.status = entry.changes.length ? 'update' : 'skip';
      if (!entry.changes.length) entry.message = 'NO_CHANGES';
    }
    entries.push(entry);
  }

  const summary = { total: entries.length, create: 0, update: 0, skip: 0, error: 0 };
  for (const e of entries) summary[e.status]++;
  return { ok: true, headerLine: header.rowIndex + 1, columns, entries, summary };
}

/** Apply a plan inside one transaction; returns the counters actually written. */
function applyImport(db, plan) {
  const result = { created: 0, updated: 0, skipped: 0, failed: plan.entries.filter(e => e.status === 'error').length };
  const insert = db.prepare('INSERT INTO products(name, category, price, unit, stock, barcode, emoji, tax_rate) VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE products SET name = ?, category = ?, price = ?, unit = ?, stock = ?, barcode = ?, emoji = ?, tax_rate = ?, active = 1 WHERE id = ?');

  db.exec('BEGIN');
  try {
    for (const entry of plan.entries) {
      if (entry.status === 'error') continue;
      if (entry.status === 'skip') { result.skipped++; continue; }
      if (entry.status === 'create') {
        let barcode = entry.barcode;
        if (!barcode) {
          do { barcode = `9${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`; }
          while (db.prepare('SELECT 1 FROM products WHERE barcode = ?').get(barcode));
        }
        const info = insert.run(
          entry.name, entry.category || 'General', entry.price, entry.unit || 'each',
          entry.stock || 0, barcode, entry.emoji || '📦', entry.taxRate,
        );
        result.created++;
        entry.productId = Number(info.lastInsertRowid);
        continue;
      }
      const prev = db.prepare('SELECT * FROM products WHERE id = ?').get(entry.productId);
      if (!prev) { result.failed++; continue; }
      update.run(
        entry.name || prev.name,
        entry.category || prev.category,
        entry.price ?? prev.price,
        entry.unit || prev.unit,
        entry.stock ?? prev.stock,
        entry.barcode || prev.barcode,
        entry.emoji || prev.emoji,
        entry.taxRate === null ? prev.tax_rate : entry.taxRate,
        entry.productId,
      );
      result.updated++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
}

module.exports = { planImport, applyImport, parseNumber, normKey, canonicalCategory, canonicalUnit, HEADER_ALIASES };
