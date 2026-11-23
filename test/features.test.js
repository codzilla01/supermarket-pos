'use strict';
/**
 * Feature tests: stock import (Excel/CSV), audit trail, automatic backups,
 * request ids + JSON logging, PWA icons, and one end-to-end till flow.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildXlsx } = require('./helpers/xlsx-fixture');
const { readTable, parseCsv } = require('../lib/spreadsheet');
const { planImport, parseNumber, canonicalUnit, canonicalCategory } = require('../lib/product-import');

const ROOT = path.join(__dirname, '..');
const PORT = 3108;
const BASE = `http://localhost:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `pos-features-${Date.now()}.db`);
const backupDir = path.join(os.tmpdir(), `pos-features-backups-${Date.now()}`);

const round2 = value => Math.round(value * 100) / 100;

let server;
let cookie = '';
let stdout = '';

async function req(method, p, body, useCookie = true) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-POS-Register': 'Register 1', ...(useCookie && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  return { status: res.status, data, headers: res.headers };
}

const IMPORT_ROWS = [
  ['اسم المنتج', 'القسم', 'السعر', 'الوحدة', 'المخزون', 'الباركود', 'الضريبة'],
  ['أرز مصري ١ كجم', 'بقالة', '٢٨٫٥', 'كجم', '٥٠', '6001234567890', '14%'],
  ['Whole Milk 1L', 'ألبان وبيض', '22.50', 'each', '10', '200001', ''],
  ['منتج بدون سعر', 'أخرى', '', 'each', 5, '6001234567893', ''],
  ['', '', '', '', '', '', ''],
  ['أرز مصري ١ كجم', 'بقالة', '30', 'كجم', '55', '6001234567890', '14'],
];

function uploadPayload(filename, buffer) {
  return { filename, contentBase64: buffer.toString('base64') };
}

before(async () => {
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      POS_DB_PATH: tmpDb,
      POS_INITIAL_ADMIN_PASSWORD: 'store-initial-admin-test-2026!',
      POS_DEVELOPER_USERNAME: 'platform-dev',
      POS_DEVELOPER_PASSWORD: 'dev-console-password-2026!',
      POS_BACKUP_DIR: backupDir,
      POS_BACKUP_KEEP: '2',
      POS_BACKUP_INTERVAL_HOURS: '24',
      POS_LOG_FORMAT: 'json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => { stdout += d; });
  server.stderr.on('data', d => { stdout += d; });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) break; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }
  // Sign in and rotate the starter password so the API is usable.
  await req('POST', '/api/login', { username: 'admin', password: 'store-initial-admin-test-2026!' }, false);
  await req('POST', '/api/me/password', { current: 'store-initial-admin-test-2026!', next: 'store-manager-password-2026!' });
});

after(() => {
  server.kill();
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------- spreadsheet reader ----------
test('the spreadsheet reader handles stored and deflated xlsx plus csv', () => {
  const rows = [['name', 'price', 'stock'], ['Tea', 12.5, 30], ['Rice', '28', '50']];
  for (const deflate of [false, true]) {
    const table = readTable(buildXlsx(rows, { sheetName: 'Stock', deflate }), 'stock.xlsx');
    assert.equal(table.format, 'xlsx');
    assert.equal(table.sheetName, 'Stock');
    assert.equal(table.rows.length, 3);
    assert.deepEqual(table.rows[1], ['Tea', '12.5', '30']);
  }
  const csv = parseCsv('\uFEFFname;price\r\n"Tea, green";12.5\r\nRice;28\r\n');
  assert.deepEqual(csv[0], ['name', 'price']);
  assert.deepEqual(csv[1], ['Tea, green', '12.5']);
  assert.equal(csv.length, 3);
  // Content decides the format: a plain CSV is accepted whatever its name…
  assert.equal(readTable(Buffer.from('name,price\nTea,9\n'), 'stock.csv').format, 'csv');
  // …while an .xlsx that is not really a workbook is reported, not parsed as text.
  assert.throws(() => readTable(Buffer.from('name,price\nTea,9\n'), 'stock.xlsx'), /NOT_A_SPREADSHEET/);
  assert.throws(() => readTable(Buffer.from([0, 1, 2, 3, 0, 9]), 'stock.csv'), /NOT_A_SPREADSHEET/);
});

test('Arabic headers, Arabic-Indic digits, units, categories and tax formats are understood', () => {
  assert.equal(parseNumber('١٢٣٫٤٥').value, 123.45);
  assert.equal(parseNumber('1,234.50').value, 1234.5);
  assert.equal(parseNumber('ج.م 28').value, 28);
  assert.equal(parseNumber('14%').percent, true);
  assert.equal(canonicalUnit('كجم'), 'kg');
  assert.equal(canonicalUnit('علبة'), 'box');
  assert.equal(canonicalUnit('عبوة'), 'pack');
  assert.equal(canonicalCategory('بقالة'), 'Pantry');
  assert.equal(canonicalCategory('منظفات ومنزل'), 'Household');

  const table = readTable(buildXlsx([['الصنف', 'الثمن', 'وحدة القياس', 'رصيد']].concat([['شاي', '٦٥', 'علبة', '٣٠']])), 'ar.xlsx');
  const plan = planImport(table.rows, [], {});
  assert.equal(plan.ok, true);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].status, 'create');
  assert.equal(plan.entries[0].price, 65);
  assert.equal(plan.entries[0].stock, 30);
  assert.equal(plan.entries[0].unit, 'box');
});

test('a file without a name+price header is rejected with a clear code', () => {
  const plan = planImport([['foo', 'bar'], ['1', '2']], [], {});
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'NO_NAME_COLUMN');
});

// ---------- import endpoints ----------
test('import preview classifies every row and writes nothing', async () => {
  const before = (await req('GET', '/api/products')).data.length;
  const preview = await req('POST', '/api/products/import/preview', uploadPayload('stock.xlsx', buildXlsx(IMPORT_ROWS, { deflate: true })));
  assert.equal(preview.status, 200);
  assert.equal(preview.data.format, 'xlsx');
  assert.equal(preview.data.headerLine, 1);
  assert.deepEqual(preview.data.summary, { total: 4, create: 1, update: 1, skip: 0, error: 2 });
  const statuses = preview.data.entries.map(e => e.status);
  assert.deepEqual(statuses, ['create', 'update', 'error', 'error']);
  assert.equal(preview.data.entries[2].message, 'BAD_PRICE');
  assert.equal(preview.data.entries[3].message, 'DUPLICATE_BARCODE');
  const after = (await req('GET', '/api/products')).data.length;
  assert.equal(after, before, 'preview must not create products');
});

test('import applies creates and updates, and a repeat run changes nothing', async () => {
  const payload = uploadPayload('stock.xlsx', buildXlsx(IMPORT_ROWS, { deflate: true }));
  const applied = await req('POST', '/api/products/import', payload);
  assert.equal(applied.status, 200);
  assert.equal(applied.data.created, 1);
  assert.equal(applied.data.updated, 1);
  assert.equal(applied.data.failed, 2);

  const products = (await req('GET', '/api/products')).data;
  const rice = products.find(p => p.name === 'أرز مصري ١ كجم');
  assert.ok(rice, 'the new product exists');
  assert.equal(rice.price, 28.5);
  assert.equal(rice.stock, 50);
  assert.equal(rice.unit, 'kg');
  assert.equal(rice.category, 'Pantry');
  assert.equal(rice.tax_rate, 0.14);

  const milk = products.find(p => p.barcode === '200001');
  assert.equal(milk.price, 22.5);
  assert.equal(milk.stock, 10);
  assert.equal(milk.category, 'Dairy & Eggs');

  const again = await req('POST', '/api/products/import', payload);
  assert.equal(again.data.created, 0, 'no duplicates on re-import');
  assert.equal(again.data.skipped, 2, 'unchanged rows are skipped');
});

test('import accepts CSV, keeps existing rows when asked, and rejects junk', async () => {
  const csv = '\uFEFFاسم المنتج,السعر,المخزون,الباركود\nChocolate Wafer,12.5,40,800999\nWhole Milk 1L,99,99,200001\n';
  const kept = await req('POST', '/api/products/import', { ...uploadPayload('stock.csv', Buffer.from(csv)), updateExisting: false });
  assert.equal(kept.status, 200);
  assert.equal(kept.data.created, 1);
  assert.equal(kept.data.skipped, 1);
  const milk = (await req('GET', '/api/products')).data.find(p => p.barcode === '200001');
  assert.equal(milk.price, 22.5, 'existing row untouched when updateExisting=false');

  const junk = await req('POST', '/api/products/import/preview', uploadPayload('stock.xlsx', Buffer.from('this is not a workbook')));
  assert.equal(junk.status, 400);
  assert.equal(junk.data.code, 'BAD_FILE');
  assert.ok(junk.data.messageAr, 'errors carry an Arabic message');

  const none = await req('POST', '/api/products/import/preview', {});
  assert.equal(none.status, 400);
  assert.equal(none.data.code, 'NO_FILE');
});

test('the import template downloads as Arabic-headed CSV', async () => {
  const raw = await fetch(BASE + '/api/products/import/template', { headers: { Cookie: cookie } });
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-disposition') || '', /products-template\.csv/);
  const bytes = Buffer.from(await raw.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM so Excel reads UTF-8');
  const text = bytes.toString('utf8');
  assert.ok(text.includes('اسم المنتج'), 'Arabic headers');
  const parsed = parseCsv(text);
  assert.ok(parsed.length >= 2);
  const plan = planImport(parsed, [], {});
  assert.equal(plan.ok, true, 'the template parses with our own reader');
  assert.equal(plan.entries.every(e => e.status === 'create'), true);
});

test('import is admin-only', async () => {
  const created = await req('POST', '/api/users', { username: 'till1', name: 'Till One', password: 'till-one-password-2026!', role: 'cashier' });
  assert.equal(created.status, 201);
  cookie = '';
  await req('POST', '/api/login', { username: 'till1', password: 'till-one-password-2026!' }, false);
  await req('POST', '/api/me/password', { current: 'till-one-password-2026!', next: 'till-one-password-2026-b!' });
  const forbidden = await req('POST', '/api/products/import/preview', uploadPayload('x.csv', Buffer.from('name,price\nA,1\n')));
  assert.equal(forbidden.status, 403);
  const auditForbidden = await req('GET', '/api/audit');
  assert.equal(auditForbidden.status, 403);
  const backupsForbidden = await req('GET', '/api/backups');
  assert.equal(backupsForbidden.status, 403);
  cookie = '';
  await req('POST', '/api/login', { username: 'admin', password: 'store-manager-password-2026!' }, false);
});

// ---------- audit ----------
test('the audit trail records imports, logins and password changes', async () => {
  const audit = await req('GET', '/api/audit?limit=100');
  assert.equal(audit.status, 200);
  assert.ok(audit.data.total >= 6);
  const actions = audit.data.entries.map(e => e.action);
  for (const expected of ['login', 'password_changed', 'products_imported', 'user_created', 'login_failed']) {
    if (expected === 'login_failed') continue; // produced by the failing-login test below
    assert.ok(actions.includes(expected), `audit should contain ${expected}, got ${actions.join(',')}`);
  }
  const imported = audit.data.entries.find(e => e.action === 'products_imported');
  assert.ok(imported.actor === 'admin');
  assert.ok(imported.request_id, 'audit rows carry the request id');
  const filtered = await req('GET', '/api/audit?action=products_imported');
  assert.equal(filtered.data.entries.every(e => e.action === 'products_imported'), true);
  const searched = await req('GET', '/api/audit?q=admin');
  assert.ok(searched.data.entries.length >= 1);
});

test('failed sign-ins are recorded without leaking the password', async () => {
  const before = (await req('GET', '/api/audit?action=login_failed')).data.entries.length;
  cookie = '';
  await req('POST', '/api/login', { username: 'admin', password: 'definitely-wrong-password' }, false);
  await req('POST', '/api/login', { username: 'admin', password: 'store-manager-password-2026!' }, false);
  const entries = (await req('GET', '/api/audit?action=login_failed')).data.entries;
  assert.ok(entries.length > before);
  assert.equal(JSON.stringify(entries).includes('definitely-wrong-password'), false);
});

// ---------- backups ----------
test('backups run at startup, are listed and are pruned to the retention limit', async () => {
  const list = await req('GET', '/api/backups');
  assert.equal(list.status, 200);
  assert.equal(list.data.enabled, true);
  assert.equal(list.data.keep, 2);
  assert.ok(list.data.files.length >= 1, 'a startup backup exists');

  const first = list.data.files[0];
  const file = path.join(backupDir, first.file);
  assert.ok(fs.existsSync(file), 'the backup file is on disk');
  const dump = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(file)).toString('utf8'));
  assert.ok(dump.products.length >= 30);
  assert.ok(Array.isArray(dump.audit_log));
  assert.ok(dump.settings.receipt_footer);

  await new Promise(r => setTimeout(r, 1100)); // distinct second-resolution timestamps
  const run = await req('POST', '/api/backups/run', {});
  assert.equal(run.status, 200);
  assert.match(run.data.file, /^backup-\d{8}-\d{6}\.json\.gz$/);

  await new Promise(r => setTimeout(r, 1100));
  await req('POST', '/api/backups/run', {});
  const after = await req('GET', '/api/backups');
  assert.equal(after.data.files.length, 2, 'retention keeps only the newest 2');
  const audited = await req('GET', '/api/audit?action=backup_created');
  assert.ok(audited.data.entries.length >= 2);
});

// ---------- suppliers, purchases, stocktake ----------
test('suppliers are validated, deduplicated, editable and deactivated', async () => {
  const created = await req('POST', '/api/suppliers', { name: 'شركة الدلتا للتوزيع', phone: '01000000000' });
  assert.equal(created.status, 201);
  assert.equal(created.data.name, 'شركة الدلتا للتوزيع');
  assert.equal(created.data.active, 1);

  const duplicate = await req('POST', '/api/suppliers', { name: 'شركة الدلتا للتوزيع' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'SUPPLIER_EXISTS');
  assert.equal((await req('POST', '/api/suppliers', { name: '   ' })).status, 400);

  const updated = await req('PUT', `/api/suppliers/${created.data.id}`, { name: 'شركة الدلتا للتوزيع', email: 'ap@delta.example' });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.email, 'ap@delta.example');

  const removed = await req('DELETE', `/api/suppliers/${created.data.id}`);
  assert.equal(removed.status, 200);
  const list = await req('GET', '/api/suppliers');
  const row = list.data.find(s => s.id === created.data.id);
  assert.equal(row.active, 0, 'deleting only deactivates the supplier');

  const audited = await req('GET', '/api/audit?action=supplier_created');
  assert.ok(audited.data.entries.length >= 1);
});

test('a purchase invoice restocks products, averages the cost and reverses cleanly', async () => {
  const supplier = await req('POST', '/api/suppliers', { name: 'مورد المشتريات' });
  assert.equal(supplier.status, 201);
  const products = (await req('GET', '/api/products')).data;
  const a = products[0];
  const b = products[1];

  const created = await req('POST', '/api/purchases', {
    supplierId: supplier.data.id,
    invoiceNo: 'INV-77',
    items: [
      { productId: a.id, qty: 10, unitCost: 15 },
      { productId: b.id, qty: 5, unitCost: 18.5 },
    ],
    paid: 100,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.subtotal, 242.5);
  assert.equal(created.data.tax, 19.4);
  assert.equal(created.data.total, 261.9);
  assert.equal(created.data.payment_status, 'partial');
  assert.equal(created.data.supplier_name, 'مورد المشتريات');

  const restocked = (await req('GET', '/api/products')).data;
  const after = restocked.find(p => p.id === a.id);
  assert.equal(after.stock, a.stock + 10);
  assert.equal(after.cost_price, 15, 'first purchase sets the unit cost');

  const detail = await req('GET', `/api/purchases/${created.data.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.items.length, 2);

  const reversed = await req('POST', `/api/purchases/${created.data.id}/reverse`, {});
  assert.equal(reversed.status, 200);
  const back = (await req('GET', '/api/products')).data.find(p => p.id === a.id);
  assert.equal(back.stock, a.stock);
  assert.equal((await req('POST', `/api/purchases/${created.data.id}/reverse`, {})).status, 409);
  assert.equal((await req('GET', `/api/purchases/${created.data.id}`)).data.status, 'reversed');
});

test('a stocktake snapshots the stock, takes counts and applies them', async () => {
  const started = await req('POST', '/api/stocktakes', {});
  assert.equal(started.status, 201);
  const draft = await req('GET', `/api/stocktakes/${started.data.id}`);
  assert.equal(draft.data.status, 'draft');
  assert.ok(draft.data.items.length >= 30, 'every active product is snapshotted');
  assert.equal((await req('POST', '/api/stocktakes', {})).status, 409, 'only one open stocktake');

  const first = draft.data.items[0];
  const saved = await req('PUT', `/api/stocktakes/${started.data.id}/items`, {
    items: [{ productId: first.product_id, counted: first.expected + 3 }],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.saved, 1);

  const applied = await req('POST', `/api/stocktakes/${started.data.id}/apply`, {});
  assert.equal(typeof applied.data.counted, 'number');
  assert.equal(applied.status, 200);
  assert.equal(applied.data.counted, 1);
  assert.equal(applied.data.gains, 1);
  assert.equal(applied.data.unitsIn, 3);

  const product = (await req('GET', '/api/products')).data.find(p => p.id === first.product_id);
  assert.equal(product.stock, first.expected + 3);
  assert.equal((await req('POST', `/api/stocktakes/${started.data.id}/apply`, {})).status, 409);
  const list = await req('GET', '/api/stocktakes');
  assert.equal(list.data.find(s => s.id === started.data.id).status, 'applied');
});

test('off-site upload is refused until it is configured', async () => {
  const status = await req('GET', '/api/backups');
  assert.equal(status.data.offsite.configured, false);
  assert.equal(status.data.offsite.key_configured, false);
  const upload = await req('POST', '/api/backups/upload', {});
  assert.equal(upload.status, 409);
  assert.equal(upload.data.code, 'OFFSITE_NOT_CONFIGURED');
});

test('the encrypted container round-trips and the restore CLI reads it back', async () => {
  const { encrypt, decrypt, isEncrypted } = require('../lib/backup-crypto');
  const { uploadOffsite } = require('../lib/backup');
  const http = require('http');

  const key = 'test-offsite-passphrase-2026';
  const payload = Buffer.from(JSON.stringify({ products: [{ id: 1 }], audit_log: [] }), 'utf8');
  const container = encrypt(payload, key);
  assert.ok(isEncrypted(container));
  assert.deepEqual(JSON.parse(decrypt(container, key).toString('utf8')), JSON.parse(payload.toString('utf8')));
  assert.throws(() => decrypt(container, 'another-passphrase'), /WRONG_KEY_OR_CORRUPT/);

  let received = null;
  let authHeader = '';
  const receiver = http.createServer((request, response) => {
    const chunks = [];
    authHeader = request.headers.authorization || '';
    request.on('data', c => chunks.push(c));
    request.on('end', () => {
      received = Buffer.concat(chunks);
      response.writeHead(201);
      response.end('ok');
    });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${receiver.address().port}/upload`;

  const schema = require('../db');
  const offsiteDb = schema.openDb(path.join(os.tmpdir(), `pos-offsite-${Date.now()}.db`));
  schema.seed(offsiteDb, () => 'hash', 'off-site-test-admin-secret-2026');
  const result = await uploadOffsite({
    db: offsiteDb,
    getSettings: () => ({ receipt_footer: 'off-site test' }),
    passphrase: key,
    url,
    token: 'secret-token',
  });
  receiver.close();
  assert.equal(result.ok, true);
  assert.match(result.file, /^backup-\d{8}-\d{6}\.posbak$/);
  assert.equal(authHeader, 'Bearer secret-token');
  assert.ok(received.length > 500, 'the compressed container was uploaded');

  const file = path.join(os.tmpdir(), result.file);
  fs.writeFileSync(file, received);
  const out = path.join(os.tmpdir(), `restore-${Date.now()}.json`);
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'restore-backup.js'), '--file', file, '--key', key, '--out', out], { stdio: 'pipe' });
  const restored = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(restored.products.length >= 30);
  assert.equal(restored.settings.receipt_footer, 'off-site test');
  fs.unlinkSync(file);
  fs.unlinkSync(out);
  offsiteDb.close();
});

// ---------- logging ----------
test('every response carries a request id and requests are logged as JSON', async () => {
  const res = await fetch(BASE + '/healthz');
  assert.ok(res.headers.get('x-request-id'));
  const custom = await fetch(BASE + '/healthz', { headers: { 'X-Request-Id': 'test-request-1234' } });
  assert.equal(custom.headers.get('x-request-id'), 'test-request-1234');
  await new Promise(r => setTimeout(r, 200));
  const lines = stdout.split('\n').filter(l => l.startsWith('{'));
  assert.ok(lines.length > 3, 'structured log lines are emitted');
  const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  assert.ok(parsed.every(entry => entry.ts && entry.level && entry.msg));
  const requestLine = parsed.find(entry => entry.msg === 'request' && entry.reqId === 'test-request-1234');
  assert.ok(requestLine, 'the request id appears in the access log');
  assert.equal(requestLine.path, '/healthz');
  assert.equal(requestLine.status, 200);
  assert.ok(JSON.stringify(parsed).includes('store-manager-password-2026!') === false, 'logs never contain passwords');
});

// ---------- end to end till flow ----------
test('end to end: shift, sale, void and audit trail', async () => {
  const shift = await req('POST', '/api/shifts/open', { openingFloat: 200 });
  assert.equal(shift.status, 201);
  const milk = (await req('GET', '/api/products')).data.find(p => p.barcode === '200001');
  const stockBefore = milk.stock;

  const sale = await req('POST', '/api/sales', {
    items: [{ id: milk.id, qty: 2 }],
    tendered: 100,
    idempotencyKey: 'e2e-sale-key-0000001',
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.data.items.length, 1);
  assert.ok(sale.data.total > 0);

  const afterSale = (await req('GET', '/api/products')).data.find(p => p.id === milk.id);
  assert.equal(afterSale.stock, stockBefore - 2);

  const voided = await req('POST', `/api/sales/${sale.data.id}/void`, {});
  assert.equal(voided.status, 200);
  assert.equal(voided.data.status, 'voided');
  const afterVoid = (await req('GET', '/api/products')).data.find(p => p.id === milk.id);
  assert.equal(afterVoid.stock, stockBefore, 'voiding restores stock');

  const closed = await req('POST', '/api/shifts/close', { closingAmount: 200 + sale.data.total });
  assert.equal(closed.status, 200);
  assert.ok(closed.data.shift.status === 'closed');

  const actions = (await req('GET', '/api/audit?limit=30')).data.entries.map(e => e.action);
  for (const expected of ['shift_opened', 'sale_voided', 'shift_closed']) {
    assert.ok(actions.includes(expected), `audit should contain ${expected}`);
  }
});

// ---------- session cookies ----------
test('session cookies are HttpOnly, Secure and SameSite=Lax by default', async () => {
  const login = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'store-manager-password-2026!' }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /^pos_session=[^;]+; HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /Max-Age=43200/);
});

// ---------- supplier statement ----------
test('the supplier statement sums invoices, payments and what is still due', async () => {
  const supplier = await req('POST', '/api/suppliers', { name: 'مورد كشف الحساب', phone: '01001112223' });
  assert.equal(supplier.status, 201);
  const products = (await req('GET', '/api/products')).data;
  const item = products[0];

  const first = await req('POST', '/api/purchases', {
    supplierId: supplier.data.id, invoiceNo: 'STM-1', items: [{ productId: item.id, qty: 2, unitCost: 10 }], paid: 5,
  });
  const second = await req('POST', '/api/purchases', {
    supplierId: supplier.data.id, invoiceNo: 'STM-2', items: [{ productId: item.id, qty: 1, unitCost: 20 }], paid: 0,
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const partlyPaid = first.data; // paid 5 of its total
  const unpaid = second.data;

  const statement = await req('GET', `/api/suppliers/${supplier.data.id}/statement?days=30`);
  assert.equal(statement.status, 200);
  assert.equal(statement.data.supplier.name, 'مورد كشف الحساب');
  assert.equal(statement.data.window.days, 30);
  assert.equal(statement.data.purchases.length, 2);
  assert.equal(statement.data.totals.invoices, 2);
  assert.equal(statement.data.totals.total, round2(partlyPaid.total + unpaid.total));
  assert.equal(statement.data.totals.paid, 5);
  assert.equal(statement.data.totals.outstanding, round2(partlyPaid.total + unpaid.total - 5));
  assert.equal(statement.data.lifetime.invoices, 2);

  // A reversed invoice is listed but does not count towards what is owed.
  await req('POST', `/api/purchases/${unpaid.id}/reverse`, {});
  const afterReverse = await req('GET', `/api/suppliers/${supplier.data.id}/statement?days=30`);
  assert.equal(afterReverse.data.purchases.length, 2);
  assert.ok(afterReverse.data.purchases.some(row => row.status === 'reversed'));
  assert.equal(afterReverse.data.totals.invoices, 1);
  assert.equal(afterReverse.data.totals.total, partlyPaid.total);
  assert.equal(afterReverse.data.totals.outstanding, round2(partlyPaid.total - 5));

  assert.equal((await req('GET', '/api/suppliers/999999/statement')).status, 404);
  assert.equal((await req('GET', `/api/suppliers/${supplier.data.id}/statement`, null, false)).status, 401);
});

// ---------- profit report ----------
test('the profit report prices sales against the recorded cost and is admin-only', async () => {
  await req('POST', '/api/shifts/open', { openingFloat: 0 });
  const product = (await req('GET', '/api/products')).data.find(p => p.barcode === '200001');
  const priced = await req('PUT', `/api/products/${product.id}`, { costPrice: 10 });
  assert.equal(priced.status, 200);
  assert.equal(priced.data.cost_price, 10);

  const sale = await req('POST', '/api/sales', {
    items: [{ id: product.id, qty: 4 }],
    tendered: 1000,
    idempotencyKey: 'profit-report-sale-0001',
  });
  assert.equal(sale.status, 201);

  const report = await req('GET', '/api/reports/profit?days=7');
  assert.equal(report.status, 200);
  assert.equal(report.data.window.days, 7);
  assert.equal(report.data.cost_source, 'current');
  assert.ok(report.data.totals.sales >= 1);

  const row = report.data.products.find(p => p.id === product.id);
  assert.ok(row, 'the sold product appears in the report');
  assert.equal(row.qty, 4);
  assert.equal(row.revenue, 90, 'revenue is tax-exclusive (4 x 22.50)');
  assert.equal(row.cost, 40, 'cost uses the recorded unit cost');
  assert.equal(row.profit, 50);
  assert.equal(row.margin, 55.56);

  const today = report.data.days.find(d => d.sales >= 1);
  assert.ok(today, 'the day bucket exists');
  assert.ok(today.revenue >= 90 && today.cost >= 40);

  const limited = await req('GET', '/api/reports/profit?days=500');
  assert.equal(limited.data.window.days, 90, 'the window is capped at 90 days');

  assert.equal((await req('GET', '/api/reports/profit', null, false)).status, 401);

  // A cashier may sell, but not read margins.
  await req('POST', '/api/users', { username: 'profit-cashier', password: 'profit-cashier-pass-2026', role: 'cashier', name: 'Profit Cashier' });
  const login = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'profit-cashier', password: 'profit-cashier-pass-2026' }),
  });
  let cashierCookie = (login.headers.get('set-cookie') || '').split(';')[0];
  await fetch(BASE + '/api/me/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cashierCookie },
    body: JSON.stringify({ current: 'profit-cashier-pass-2026', next: 'profit-cashier-pass-2026-v2' }),
  });
  const denied = await fetch(BASE + '/api/reports/profit', { headers: { Cookie: cashierCookie } });
  assert.equal(denied.status, 403);
});

// ---------- PWA icons ----------
test('the manifest advertises real PNG icons that exist on disk', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.webmanifest'), 'utf8'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4);
  const sizes = manifest.icons.map(i => i.sizes);
  assert.ok(sizes.includes('192x192'));
  assert.ok(sizes.includes('512x512'));
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'), 'maskable icon for Android');
  for (const icon of manifest.icons) {
    const file = path.join(ROOT, 'public', icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `missing icon ${icon.src}`);
    const buf = fs.readFileSync(file);
    assert.equal(buf.slice(1, 4).toString('ascii'), 'PNG');
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.equal(buf.readUInt32BE(16), w);
    assert.equal(buf.readUInt32BE(20), h);
  }
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  assert.match(sw, /\/icons\/icon-192\.png/);
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /rel="apple-touch-icon"/);
});
