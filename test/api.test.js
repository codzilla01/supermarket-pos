'use strict';
/** API smoke tests — run with: npm test */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3107;
const BASE = `http://localhost:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `pos-test-${Date.now()}.db`);

let server;
let cookie = '';
let cookieHeader = '';

async function req(method, p, body, useCookie = true) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(useCookie && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) { cookieHeader = setCookie; cookie = setCookie.split(';')[0]; }
  return { status: res.status, data };
}

before(async () => {
  server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), POS_DB_PATH: tmpDb },
    stdio: 'pipe',
  });
  // wait for readiness
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Server did not start');
});

after(() => {
  server.kill();
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
});

test('unauthenticated API access is rejected', async () => {
  const r = await req('GET', '/api/products', null, false);
  assert.equal(r.status, 401);
});

test('default admin must rotate its starter password before using the API', async () => {
  const r = await req('POST', '/api/login', { username: 'admin', password: 'admin123' }, false);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'admin');
  assert.equal(r.data.user.mustChangePassword, true);
  assert.ok(cookie.includes('pos_session'));
  assert.match(cookieHeader, /; Secure(?:;|$)/);
  const blocked = await req('GET', '/api/products');
  assert.equal(blocked.status, 403);
  const changed = await req('POST', '/api/me/password', { current: 'admin123', next: 'freshmart-admin-test-2026' });
  assert.equal(changed.status, 200);
  const products = await req('GET', '/api/products');
  assert.equal(products.status, 200);
});

test('wrong password is rejected', async () => {
  const r = await req('POST', '/api/login', { username: 'admin', password: 'wrong' }, false);
  assert.equal(r.status, 401);
});

test('products are seeded', async () => {
  const r = await req('GET', '/api/products');
  assert.equal(r.status, 200);
  assert.ok(r.data.length >= 30);
});

test('sale requires an open shift', async () => {
  const r = await req('POST', '/api/sales', { idempotencyKey: 'test-shift-closed-sale', items: [{ id: 1, qty: 1 }], payment: 'cash', tendered: 10 });
  assert.equal(r.status, 409);
});

test('open shift, complete a sale, stock decrements', async () => {
  const s = await req('POST', '/api/shifts/open', { openingFloat: 100 });
  assert.equal(s.status, 201);
  const before = (await req('GET', '/api/products')).data.find(p => p.id === 1);
  const invalidQty = await req('POST', '/api/sales', { idempotencyKey: 'test-negative-quantity', items: [{ id: 1, qty: -2 }], payment: 'cash', tendered: 20 });
  assert.equal(invalidQty.status, 400);
  const payload = { idempotencyKey: 'test-idempotent-sale-001', items: [{ id: 1, qty: 2 }], discountPct: 10, payment: 'cash', tendered: 20 };
  const r = await req('POST', '/api/sales', payload);
  assert.equal(r.status, 201);
  assert.equal(r.data.items[0].qty, 2);
  assert.ok(r.data.total > 0);
  const retry = await req('POST', '/api/sales', payload);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.id, r.data.id);
  const afterP = (await req('GET', '/api/products')).data.find(p => p.id === 1);
  assert.equal(afterP.stock, before.stock - 2);
  // refund restores stock
  const refund = await req('POST', `/api/sales/${r.data.id}/refund`);
  assert.equal(refund.status, 200);
  const restored = (await req('GET', '/api/products')).data.find(p => p.id === 1);
  assert.equal(restored.stock, before.stock);
});

test('product tax override is applied by the server', async () => {
  const created = await req('POST', '/api/products', { name: 'Tax test item', category: 'Test', price: 10, stock: 5, taxRate: 0.21 });
  assert.equal(created.status, 201);
  assert.equal(created.data.tax_rate, 0.21);
  const sale = await req('POST', '/api/sales', { idempotencyKey: 'test-product-tax-sale-01', items: [{ id: created.data.id, qty: 1 }], payment: 'cash', tendered: 20 });
  assert.equal(sale.status, 201);
  assert.equal(sale.data.tax, 2.1);
  assert.equal(sale.data.total, 12.1);
  assert.equal(sale.data.items[0].tax_rate, 0.21);
});

test('cashier cannot manage users (admin only)', async () => {
  const starterPassword = 'cashier-test-password-2026';
  await req('POST', '/api/users', { username: 'cashier1', password: starterPassword, role: 'cashier', name: 'Test Cashier' });
  const login = await req('POST', '/api/login', { username: 'cashier1', password: starterPassword }, false);
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, true);
  await req('POST', '/api/me/password', { current: starterPassword, next: 'cashier-updated-password-2026' });
  const savedCookie = cookie;
  const r = await req('GET', '/api/users');
  assert.equal(r.status, 403);
  cookie = savedCookie; // back to cashier session
});

test('close shift reports variance', async () => {
  const r = await req('POST', '/api/shifts/close', { closingAmount: 100 });
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.variance, 'number');
});

test('settings update persists', async () => {
await req('POST', '/api/login', { username: 'admin', password: 'freshmart-admin-test-2026' }, false);
  const r = await req('PUT', '/api/settings', { tax_rate: '0.21', currency_code: 'EUR' });
  assert.equal(r.status, 200);
  assert.equal(r.data.tax_rate, '0.21');
  assert.equal(r.data.currency_code, 'EUR');
  const unsupported = await req('PUT', '/api/settings', { currency_code: 'XYZ' });
  assert.equal(unsupported.status, 400);
});

test('backup export contains data', async () => {
  const r = await req('GET', '/api/backup');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.products));
  assert.ok(Array.isArray(r.data.sales));
});
