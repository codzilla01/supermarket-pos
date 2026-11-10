'use strict';
/**
 * FreshMart Supermarket POS — production server.
 * Zero-dependency Node.js: SQLite (node:sqlite), scrypt auth, sessions,
 * shifts, loyalty, returns, settings, backups, optional Stripe payments.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { openDb, seed, getSettings, setSettings } = require('./db');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const MIN_PASSWORD_LENGTH = 12;

const db = openDb();
seed(db, auth.hashPassword);

// ---------- helpers ----------
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.stripe.com; frame-src https://js.stripe.com");
}

// Login rate limiting: 8 attempts / 15 min / IP
const loginAttempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (loginAttempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  if (arr.length >= 8) return true;
  arr.push(now);
  loginAttempts.set(ip, arr);
  return false;
}

function sessionCookie(token) {
  const secure = process.env.POS_COOKIE_SECURE === 'false' ? '' : '; Secure';
  return `pos_session=${token}; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=${12 * 3600}`;
}

function requireAuth(req, res) {
  const token = auth.parseCookies(req).pos_session;
  const user = auth.getSessionUser(db, token);
  if (!user) { sendJson(res, 401, { error: 'Not authenticated' }); return null; }
  return user;
}

function requireAdmin(user, res) {
  if (user.role !== 'admin') { sendJson(res, 403, { error: 'Admin access required' }); return false; }
  return true;
}

const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const registerFor = req => str(req.headers['x-pos-register'], 60) || getSettings(db).register_name;
const round2 = n => Math.round(n * 100) / 100;

// ---------- Stripe (optional) ----------
async function stripeRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-06-20',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Stripe error');
  return data;
}

async function stripeCreatePaymentIntent(amountCents, currency = 'usd') {
  const params = new URLSearchParams({
    amount: String(amountCents),
    currency,
    'automatic_payment_methods[enabled]': 'true',
    'automatic_payment_methods[allow_redirects]': 'never',
  });
  return stripeRequest('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

async function stripeCreateRefund(paymentIntentId, saleId) {
  const body = new URLSearchParams({ payment_intent: paymentIntentId });
  return stripeRequest('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `pos-sale-refund-${saleId}`,
    },
    body: body.toString(),
  });
}

async function stripeGetPaymentIntent(id) {
  if (!/^pi_[A-Za-z0-9]+$/.test(String(id || ''))) throw new Error('Invalid payment reference');
  return stripeRequest(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(id)}`);
}

// ---------- API handlers ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // Public: login
  if (p === '/api/login' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many login attempts. Try again later.' });
    const b = await readBody(req);
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(str(b.username, 50));
    if (!user || !user.active || !auth.verifyPassword(b.password || '', user.password_hash)) {
      return sendJson(res, 401, { error: 'Invalid username or password' });
    }
    const token = auth.createSession(db, user.id);
    return sendJson(res, 200, { user: { id: user.id, username: user.username, role: user.role, name: user.name, mustChangePassword: !!user.must_change_password } },
      { 'Set-Cookie': sessionCookie(token) });
  }

  // Everything below requires auth
  const user = requireAuth(req, res);
  if (!user) return;
  if (user.must_change_password && !((p === '/api/me/password' && method === 'POST') || (p === '/api/logout' && method === 'POST') || (p === '/api/me' && method === 'GET'))) {
    return sendJson(res, 403, { error: 'Change your password before using the POS', code: 'PASSWORD_CHANGE_REQUIRED' });
  }

  if (p === '/api/logout' && method === 'POST') {
    auth.deleteSession(db, auth.parseCookies(req).pos_session);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `pos_session=; HttpOnly; Path=/; SameSite=Lax${process.env.POS_COOKIE_SECURE === 'false' ? '' : '; Secure'}; Max-Age=0` });
  }
  if (p === '/api/me' && method === 'GET') return sendJson(res, 200, { user });
  if (p === '/api/config' && method === 'GET') {
    return sendJson(res, 200, { stripe: !!STRIPE_SECRET_KEY, stripePublishableKey: STRIPE_PUBLISHABLE_KEY, settings: getSettings(db) });
  }

  // ----- Products -----
  if (p === '/api/products' && method === 'GET') {
    return sendJson(res, 200, db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY category, name').all());
  }
  if (p === '/api/products' && method === 'POST') {
    if (!requireAdmin(user, res)) return;
    const b = await readBody(req);
    const name = str(b.name, 120);
    if (!name) return sendJson(res, 400, { error: 'Product name is required' });
    const barcode = str(b.barcode, 30) || `9${Date.now().toString().slice(-8)}`;
    const productTax = b.taxRate == null || b.taxRate === '' ? null : num(b.taxRate, -1);
    if (productTax !== null && (productTax < 0 || productTax > 1)) return sendJson(res, 400, { error: 'Product tax rate must be between 0 and 1' });
    try {
      const info = db.prepare('INSERT INTO products(name, category, price, unit, stock, barcode, emoji, tax_rate) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name, str(b.category, 60) || 'General', Math.max(0, num(b.price)), str(b.unit, 20) || 'each', Math.max(0, int(b.stock)), barcode, str(b.emoji, 8) || '📦', productTax);
      return sendJson(res, 201, db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return sendJson(res, 409, { error: 'Barcode already exists' });
      throw e;
    }
  }
  const prodMatch = p.match(/^\/api\/products\/(\d+)$/);
  if (prodMatch) {
    const id = +prodMatch[1];
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) return sendJson(res, 404, { error: 'Product not found' });
    if (method === 'PUT') {
      if (!requireAdmin(user, res)) return;
      const b = await readBody(req);
      const next = {
        name: b.name !== undefined ? str(b.name, 120) || existing.name : existing.name,
        category: b.category !== undefined ? str(b.category, 60) || existing.category : existing.category,
        price: b.price !== undefined ? Math.max(0, num(b.price)) : existing.price,
        unit: b.unit !== undefined ? str(b.unit, 20) || existing.unit : existing.unit,
        stock: b.stock !== undefined ? Math.max(0, int(b.stock)) : existing.stock,
        barcode: b.barcode !== undefined ? str(b.barcode, 30) || existing.barcode : existing.barcode,
        emoji: b.emoji !== undefined ? str(b.emoji, 8) || '📦' : existing.emoji,
        tax_rate: b.taxRate === undefined ? existing.tax_rate : (b.taxRate === '' || b.taxRate === null ? null : num(b.taxRate, -1)),
      };
      if (next.tax_rate !== null && (next.tax_rate < 0 || next.tax_rate > 1)) return sendJson(res, 400, { error: 'Product tax rate must be between 0 and 1' });
      try {
        db.prepare('UPDATE products SET name=?, category=?, price=?, unit=?, stock=?, barcode=?, emoji=?, tax_rate=? WHERE id=?')
          .run(next.name, next.category, next.price, next.unit, next.stock, next.barcode, next.emoji, next.tax_rate, id);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return sendJson(res, 409, { error: 'Barcode already exists' });
        throw e;
      }
      return sendJson(res, 200, db.prepare('SELECT * FROM products WHERE id = ?').get(id));
    }
    if (method === 'DELETE') {
      if (!requireAdmin(user, res)) return;
      db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ----- Customers -----
  if (p === '/api/customers' && method === 'GET') {
    return sendJson(res, 200, db.prepare('SELECT * FROM customers ORDER BY name').all());
  }
  if (p === '/api/customers' && method === 'POST') {
    const b = await readBody(req);
    const name = str(b.name, 120);
    if (!name) return sendJson(res, 400, { error: 'Customer name is required' });
    const phone = str(b.phone, 30) || null;
    try {
      const info = db.prepare('INSERT INTO customers(name, phone, email) VALUES(?, ?, ?)').run(name, phone, str(b.email, 120));
      return sendJson(res, 201, db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return sendJson(res, 409, { error: 'Phone number already registered' });
      throw e;
    }
  }
  const custMatch = p.match(/^\/api\/customers\/(\d+)$/);
  if (custMatch && method === 'PUT') {
    if (!requireAdmin(user, res)) return;
    const b = await readBody(req);
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(+custMatch[1]);
    if (!c) return sendJson(res, 404, { error: 'Customer not found' });
    db.prepare('UPDATE customers SET name=?, phone=?, email=?, points=? WHERE id=?')
      .run(str(b.name, 120) || c.name, str(b.phone, 30) || c.phone, str(b.email, 120), Math.max(0, int(b.points, c.points)), c.id);
    return sendJson(res, 200, db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id));
  }

  // ----- Shifts -----
  if (p === '/api/shifts/current' && method === 'GET') {
    const shift = db.prepare("SELECT * FROM shifts WHERE status = 'open' AND register = ? ORDER BY id DESC LIMIT 1").get(registerFor(req));
    return sendJson(res, 200, { shift: shift || null });
  }
  if (p === '/api/shifts' && method === 'GET') {
    return sendJson(res, 200, db.prepare('SELECT s.*, u.name AS cashier_name FROM shifts s LEFT JOIN users u ON u.id = s.cashier_id ORDER BY s.id DESC LIMIT 100').all());
  }
  if (p === '/api/shifts/open' && method === 'POST') {
    const register = registerFor(req);
    const open = db.prepare("SELECT id FROM shifts WHERE status = 'open' AND register = ?").get(register);
    if (open) return sendJson(res, 409, { error: `A shift is already open on ${register}` });
    const b = await readBody(req);
    const info = db.prepare('INSERT INTO shifts(cashier_id, register, opening_float) VALUES(?, ?, ?)')
      .run(user.id, register, Math.max(0, num(b.openingFloat)));
    return sendJson(res, 201, db.prepare('SELECT * FROM shifts WHERE id = ?').get(info.lastInsertRowid));
  }
  if (p === '/api/shifts/close' && method === 'POST') {
    const shift = db.prepare("SELECT * FROM shifts WHERE status = 'open' AND register = ? ORDER BY id DESC LIMIT 1").get(registerFor(req));
    if (!shift) return sendJson(res, 404, { error: 'No open shift' });
    const b = await readBody(req);
    const closing = Math.max(0, num(b.closingAmount));
    const cashSales = db.prepare("SELECT COALESCE(SUM(total),0) AS s FROM sales WHERE shift_id = ? AND payment = 'cash' AND status = 'completed'").get(shift.id).s;
    const expected = round2(shift.opening_float + cashSales);
    db.prepare("UPDATE shifts SET status='closed', closed_at=datetime('now'), closing_amount=?, expected_cash=? WHERE id=?").run(closing, expected, shift.id);
    return sendJson(res, 200, { shift: db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id), variance: round2(closing - expected) });
  }

  // ----- Sales -----
  if (p === '/api/sales' && method === 'GET') {
    const sales = db.prepare(`
      SELECT s.*, u.name AS cashier_name, c.name AS customer_name
      FROM sales s LEFT JOIN users u ON u.id = s.cashier_id LEFT JOIN customers c ON c.id = s.customer_id
      ORDER BY s.id DESC LIMIT 200`).all();
    for (const s of sales) s.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(s.id);
    return sendJson(res, 200, sales);
  }
  if (p === '/api/sales' && method === 'POST') {
    const b = await readBody(req);
    const idempotencyKey = str(b.idempotencyKey, 100);
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'A unique idempotency key is required for each sale' });
    const prior = db.prepare('SELECT * FROM sales WHERE idempotency_key = ?').get(idempotencyKey);
    if (prior) {
      prior.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(prior.id);
      return sendJson(res, 200, prior);
    }
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return sendJson(res, 400, { error: 'Cart is empty' });

    const shift = db.prepare("SELECT * FROM shifts WHERE status = 'open' AND register = ? ORDER BY id DESC LIMIT 1").get(registerFor(req));
    if (!shift) return sendJson(res, 409, { error: 'No open shift for this register. Open a shift before selling.' });

    const settings = getSettings(db);
    const taxRate = Math.min(1, Math.max(0, num(settings.tax_rate, 0.08)));
    const pointsPerDollar = Math.max(0, num(settings.points_per_dollar, 1));
    const pointsValue = Math.max(0, num(settings.points_value, 0.01));

    // Validate stock first
    for (const it of items) {
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 10000) return sendJson(res, 400, { error: 'Each quantity must be a positive integer' });
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(int(it.id));
      if (!prod || !prod.active) return sendJson(res, 400, { error: `Product ${it.id} not found` });
      if (prod.stock < qty) return sendJson(res, 400, { error: `Insufficient stock for ${prod.name}` });
    }

    const saleItems = items.map(it => {
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(int(it.id));
      return {
        product_id: prod.id, name: prod.name, emoji: prod.emoji, price: prod.price,
        qty: int(it.qty), line_total: round2(prod.price * int(it.qty)),
        tax_rate: prod.tax_rate == null ? taxRate : Number(prod.tax_rate),
      };
    });
    const subtotal = round2(saleItems.reduce((s, i) => s + i.line_total, 0));
    const discountPct = Math.min(100, Math.max(0, num(b.discountPct)));
    const discount = round2(subtotal * discountPct / 100);
    const afterDiscount = Math.max(0, round2(subtotal - discount));

    // Loyalty redemption cannot discount beyond the remaining basket amount.
    let customer = null;
    let pointsRedeemed = 0;
    let pointsDiscount = 0;
    if (b.customerId) {
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(int(b.customerId));
      if (!customer) return sendJson(res, 400, { error: 'Customer not found' });
      const maxRedeem = pointsValue > 0 ? Math.floor(afterDiscount / pointsValue) : 0;
      pointsRedeemed = Math.min(customer.points, Math.max(0, int(b.redeemPoints)), maxRedeem);
      pointsDiscount = round2(pointsRedeemed * pointsValue);
    }

    // Apply discounts proportionally, then tax each product using its own rate.
    let allocatedPoints = 0;
    let taxable = 0;
    let tax = 0;
    saleItems.forEach((i, idx) => {
      const lineAfterDiscount = round2(i.line_total * (1 - discountPct / 100));
      const pointsShare = idx === saleItems.length - 1
        ? round2(pointsDiscount - allocatedPoints)
        : round2(afterDiscount > 0 ? pointsDiscount * lineAfterDiscount / afterDiscount : 0);
      allocatedPoints = round2(allocatedPoints + pointsShare);
      i.taxable = round2(Math.max(0, lineAfterDiscount - pointsShare));
      i.tax = round2(i.taxable * i.tax_rate);
      taxable += i.taxable;
      tax += i.tax;
    });
    taxable = round2(taxable);
    tax = round2(tax);
    const total = round2(taxable + tax);
    const payment = b.payment === 'card' ? 'card' : 'cash';
    const tendered = payment === 'cash' ? num(b.tendered) : null;
    if (payment === 'cash' && tendered < total) return sendJson(res, 400, { error: 'Tendered amount is less than the total' });
    const change = payment === 'cash' ? round2(tendered - total) : null;
    // When live Stripe is configured, never record a card sale based only on a
    // browser-side success response: retrieve the intent and verify settlement + amount.
    if (payment === 'card' && STRIPE_SECRET_KEY) {
      if (!b.paymentIntentId) return sendJson(res, 402, { error: 'A verified Stripe payment is required' });
      try {
        const currency = String(settings.currency_code || 'USD').toLowerCase();
        if (!['usd', 'eur', 'gbp'].includes(currency)) return sendJson(res, 400, { error: 'Stripe supports USD, EUR, or GBP in this POS configuration' });
        const intent = await stripeGetPaymentIntent(b.paymentIntentId);
        if (intent.status !== 'succeeded' || intent.amount !== Math.round(total * 100) || intent.currency !== currency) {
          return sendJson(res, 402, { error: 'Stripe payment is not settled for this sale total and currency' });
        }
      } catch (e) {
        return sendJson(res, 502, { error: 'Could not verify card payment: ' + e.message });
      }
    }
    const pointsEarned = customer ? Math.floor(total * pointsPerDollar) : 0;

    let saleId;
    db.exec('BEGIN');
    try {
      const info = db.prepare(`INSERT INTO sales(cashier_id, register, shift_id, subtotal, discount_pct, discount, tax, total, payment, tendered, change, customer_id, points_earned, points_redeemed, payment_intent_id, idempotency_key)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(user.id, shift.register, shift.id, subtotal, discountPct, discount, tax, total, payment, tendered, change, customer?.id ?? null, pointsEarned, pointsRedeemed, payment === 'card' && STRIPE_SECRET_KEY ? b.paymentIntentId : null, idempotencyKey);
      saleId = info.lastInsertRowid;
      const insItem = db.prepare('INSERT INTO sale_items(sale_id, product_id, name, emoji, price, qty, line_total, tax_rate, tax) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
      for (const i of saleItems) {
        insItem.run(saleId, i.product_id, i.name, i.emoji, i.price, i.qty, i.line_total, i.tax_rate, i.tax);
        const update = decStock.run(i.qty, i.product_id, i.qty);
        if (update.changes !== 1) throw new Error(`Stock changed during sale for ${i.name}`);
      }
      if (customer) {
        db.prepare('UPDATE customers SET points = points + ? WHERE id = ?').run(pointsEarned - pointsRedeemed, customer.id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      if (String(e.message).includes('UNIQUE')) {
        const duplicate = db.prepare('SELECT * FROM sales WHERE idempotency_key = ?').get(idempotencyKey);
        if (duplicate) {
          duplicate.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(duplicate.id);
          return sendJson(res, 200, duplicate);
        }
      }
      throw e;
    }
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
    return sendJson(res, 201, sale);
  }
  const saleAction = p.match(/^\/api\/sales\/(\d+)\/(void|refund)$/);
  if (saleAction && method === 'POST') {
    if (!requireAdmin(user, res)) return;
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(+saleAction[1]);
    if (!sale) return sendJson(res, 404, { error: 'Sale not found' });
    if (sale.status !== 'completed') return sendJson(res, 409, { error: `Sale is already ${sale.status}` });
    let stripeRefund = null;
    if (sale.payment === 'card' && STRIPE_SECRET_KEY) {
      if (!sale.payment_intent_id) return sendJson(res, 409, { error: 'This card sale has no provider payment reference; reconcile it manually' });
      try {
        stripeRefund = await stripeCreateRefund(sale.payment_intent_id, sale.id);
        if (stripeRefund.status === 'failed' || stripeRefund.status === 'canceled') {
          return sendJson(res, 502, { error: `Provider refund is ${stripeRefund.status}; stock and sale records were not changed` });
        }
      } catch (e) {
        return sendJson(res, 502, { error: 'Payment provider refund failed: ' + e.message });
      }
    }
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
    db.exec('BEGIN');
    try {
      const restock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
      for (const i of items) if (i.product_id) restock.run(i.qty, i.product_id);
      if (sale.customer_id) {
        db.prepare('UPDATE customers SET points = MAX(0, points - ?) WHERE id = ?').run(sale.points_earned - sale.points_redeemed, sale.customer_id);
      }
      const finalStatus = stripeRefund && stripeRefund.status !== 'succeeded' ? 'refund_pending' : (saleAction[2] === 'void' ? 'voided' : 'refunded');
      db.prepare('UPDATE sales SET status = ?, stripe_refund_id = ? WHERE id = ?').run(finalStatus, stripeRefund?.id ?? null, sale.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return sendJson(res, 200, { ok: true, status: stripeRefund && stripeRefund.status !== 'succeeded' ? 'refund_pending' : (saleAction[2] === 'void' ? 'voided' : 'refunded'), providerRefundId: stripeRefund?.id ?? null });
  }

  // ----- Stats -----
  if (p === '/api/stats' && method === 'GET') {
    const today = new Date().toISOString().slice(0, 10);
    const todays = db.prepare("SELECT * FROM sales WHERE date(date) = date(?) AND status = 'completed'").all(today);
    const revenue = round2(todays.reduce((s, x) => s + x.total, 0));
    const byProduct = {};
    for (const s of db.prepare("SELECT * FROM sales WHERE status = 'completed'").all()) {
      for (const i of db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(s.id)) {
        byProduct[i.name] = byProduct[i.name] || { name: i.name, emoji: i.emoji, qty: 0, revenue: 0 };
        byProduct[i.name].qty += i.qty;
        byProduct[i.name].revenue += i.line_total;
      }
    }
    const top = Object.values(byProduct).sort((a, b) => b.revenue - a.revenue).slice(0, 8);
    const threshold = int(getSettings(db).low_stock_threshold, 10);
    const byCashier = db.prepare(`
      SELECT u.name AS cashier, COUNT(*) AS transactions, COALESCE(SUM(s.total),0) AS revenue
      FROM sales s JOIN users u ON u.id = s.cashier_id
      WHERE s.status = 'completed' GROUP BY u.id ORDER BY revenue DESC`).all();
    return sendJson(res, 200, {
      today: { transactions: todays.length, revenue, items: todays.reduce((s, x) => s + db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM sale_items WHERE sale_id = ?').get(x.id).q, 0) },
      total: { transactions: db.prepare("SELECT COUNT(*) AS c FROM sales WHERE status = 'completed'").get().c, revenue: round2(db.prepare("SELECT COALESCE(SUM(total),0) AS s FROM sales WHERE status = 'completed'").get().s) },
      lowStock: db.prepare('SELECT * FROM products WHERE active = 1 AND stock <= ? ORDER BY stock').all(threshold),
      top, byCashier,
    });
  }

  // ----- Users (admin) -----
  if (p === '/api/users' && method === 'GET') {
    if (!requireAdmin(user, res)) return;
    return sendJson(res, 200, db.prepare('SELECT id, username, role, name, active, created_at FROM users ORDER BY id').all());
  }
  if (p === '/api/users' && method === 'POST') {
    if (!requireAdmin(user, res)) return;
    const b = await readBody(req);
    const username = str(b.username, 50).toLowerCase();
    const password = String(b.password || '');
    if (!username || password.length < MIN_PASSWORD_LENGTH) return sendJson(res, 400, { error: `Username required, password min. ${MIN_PASSWORD_LENGTH} characters` });
    try {
      const info = db.prepare('INSERT INTO users(username, password_hash, role, name, must_change_password) VALUES(?, ?, ?, ?, 1)')
        .run(username, auth.hashPassword(password), b.role === 'admin' ? 'admin' : 'cashier', str(b.name, 120) || username);
      return sendJson(res, 201, db.prepare('SELECT id, username, role, name, active FROM users WHERE id = ?').get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return sendJson(res, 409, { error: 'Username already exists' });
      throw e;
    }
  }
  const userMatch = p.match(/^\/api\/users\/(\d+)$/);
  if (userMatch) {
    if (!requireAdmin(user, res)) return;
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(+userMatch[1]);
    if (!target) return sendJson(res, 404, { error: 'User not found' });
    if (method === 'PUT') {
      const b = await readBody(req);
      const next = {
        role: b.role !== undefined ? (b.role === 'admin' ? 'admin' : 'cashier') : target.role,
        name: b.name !== undefined ? str(b.name, 120) || target.name : target.name,
        active: b.active !== undefined ? (b.active ? 1 : 0) : target.active,
      };
      if (target.id === user.id && next.active === 0) return sendJson(res, 400, { error: 'You cannot deactivate yourself' });
      if (b.password) {
        if (String(b.password).length < MIN_PASSWORD_LENGTH) return sendJson(res, 400, { error: `Password min. ${MIN_PASSWORD_LENGTH} characters` });
        db.prepare('UPDATE users SET role=?, name=?, active=?, password_hash=?, must_change_password=1 WHERE id=?')
          .run(next.role, next.name, next.active, auth.hashPassword(b.password), target.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?')
          .run(target.id, auth.parseCookies(req).pos_session || '');
      } else {
        db.prepare('UPDATE users SET role=?, name=?, active=? WHERE id=?').run(next.role, next.name, next.active, target.id);
      }
      return sendJson(res, 200, db.prepare('SELECT id, username, role, name, active FROM users WHERE id = ?').get(target.id));
    }
    if (method === 'DELETE') {
      if (target.id === user.id) return sendJson(res, 400, { error: 'You cannot delete yourself' });
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(target.id);
      return sendJson(res, 200, { ok: true });
    }
  }
  if (p === '/api/me/password' && method === 'POST') {
    const b = await readBody(req);
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!auth.verifyPassword(b.current || '', me.password_hash)) return sendJson(res, 401, { error: 'Current password is incorrect' });
    if (String(b.next || '').length < MIN_PASSWORD_LENGTH) return sendJson(res, 400, { error: `New password min. ${MIN_PASSWORD_LENGTH} characters` });
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(auth.hashPassword(b.next), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(user.id, auth.parseCookies(req).pos_session || '');
    return sendJson(res, 200, { ok: true });
  }

  // ----- Settings (admin write) -----
  if (p === '/api/settings' && method === 'GET') return sendJson(res, 200, getSettings(db));
  if (p === '/api/settings' && method === 'PUT') {
    if (!requireAdmin(user, res)) return;
    const b = await readBody(req);
    const allowed = ['store_name', 'store_address', 'store_phone', 'vat_number', 'receipt_footer', 'tax_rate', 'currency', 'currency_code', 'low_stock_threshold', 'register_name', 'points_per_dollar', 'points_value'];
    const limits = { store_address: 200, store_phone: 40, vat_number: 40, receipt_footer: 200 };
    const obj = {};
    for (const k of allowed) if (b[k] !== undefined) obj[k] = str(b[k], limits[k] || 60);
    if (obj.tax_rate !== undefined) {
      const t = num(obj.tax_rate, -1);
      if (t < 0 || t > 1) return sendJson(res, 400, { error: 'Tax rate must be between 0 and 1 (e.g. 0.09)' });
    }
    if (obj.currency_code !== undefined && !['USD', 'EUR', 'GBP'].includes(obj.currency_code.toUpperCase())) {
      return sendJson(res, 400, { error: 'Currency code must be USD, EUR, or GBP' });
    }
    setSettings(db, obj);
    return sendJson(res, 200, getSettings(db));
  }

  // ----- Payments (Stripe-ready) -----
  if (p === '/api/payments/intent' && method === 'POST') {
    const b = await readBody(req);
    const amount = Math.round(num(b.amount) * 100);
    if (amount <= 0) return sendJson(res, 400, { error: 'Invalid amount' });
    if (!STRIPE_SECRET_KEY) return sendJson(res, 200, { simulated: true, message: 'Stripe not configured — card payment simulated.' });
    try {
      const currency = String(getSettings(db).currency_code || 'USD').toLowerCase();
      if (!['usd', 'eur', 'gbp'].includes(currency)) return sendJson(res, 400, { error: 'Stripe supports USD, EUR, or GBP in this POS configuration' });
      const intent = await stripeCreatePaymentIntent(amount, currency);
      return sendJson(res, 200, { id: intent.id, clientSecret: intent.client_secret, simulated: false });
    } catch (e) {
      return sendJson(res, 502, { error: 'Payment gateway error: ' + e.message });
    }
  }

  // ----- Backup -----
  if (p === '/api/backup' && method === 'GET') {
    if (!requireAdmin(user, res)) return;
    const dump = {
      exported_at: new Date().toISOString(),
      users: db.prepare('SELECT id, username, role, name, active FROM users').all(),
      products: db.prepare('SELECT * FROM products').all(),
      customers: db.prepare('SELECT * FROM customers').all(),
      sales: db.prepare('SELECT * FROM sales').all(),
      sale_items: db.prepare('SELECT * FROM sale_items').all(),
      shifts: db.prepare('SELECT * FROM shifts').all(),
      settings: getSettings(db),
    };
    return sendJson(res, 200, dump);
  }
  if (p === '/api/backup/import' && method === 'POST') {
    if (!requireAdmin(user, res)) return;
    const b = await readBody(req);
    if (!Array.isArray(b.products) || !Array.isArray(b.sales)) return sendJson(res, 400, { error: 'Invalid backup file' });
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM sale_items; DELETE FROM sales; DELETE FROM shifts; DELETE FROM customers; DELETE FROM products;');
      const insP = db.prepare('INSERT INTO products(id, name, category, price, unit, stock, barcode, emoji, active, tax_rate) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const x of b.products) insP.run(x.id, x.name, x.category, x.price, x.unit, x.stock, x.barcode, x.emoji, x.active ?? 1, x.tax_rate ?? null);
      const insC = db.prepare('INSERT INTO customers(id, name, phone, email, points) VALUES(?, ?, ?, ?, ?)');
      for (const x of (b.customers || [])) insC.run(x.id, x.name, x.phone, x.email, x.points);
      const insShift = db.prepare('INSERT INTO shifts(id, cashier_id, register, opening_float, expected_cash, closing_amount, opened_at, closed_at, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const x of (b.shifts || [])) insShift.run(x.id, x.cashier_id, x.register, x.opening_float, x.expected_cash, x.closing_amount, x.opened_at, x.closed_at, x.status);
      const insS = db.prepare('INSERT INTO sales(id, date, cashier_id, register, shift_id, subtotal, discount_pct, discount, tax, total, payment, tendered, change, status, customer_id, points_earned, points_redeemed, payment_intent_id, stripe_refund_id, idempotency_key) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const x of b.sales) insS.run(x.id, x.date, x.cashier_id, x.register, x.shift_id, x.subtotal, x.discount_pct, x.discount, x.tax, x.total, x.payment, x.tendered, x.change, x.status, x.customer_id, x.points_earned, x.points_redeemed, x.payment_intent_id ?? null, x.stripe_refund_id ?? null, x.idempotency_key ?? null);
      const insI = db.prepare('INSERT INTO sale_items(id, sale_id, product_id, name, emoji, price, qty, line_total, tax_rate, tax) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const x of (b.sale_items || [])) insI.run(x.id, x.sale_id, x.product_id, x.name, x.emoji, x.price, x.qty, x.line_total, x.tax_rate ?? null, x.tax ?? null);
      if (b.settings) setSettings(db, b.settings);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'API route not found' });
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/healthz' && req.method === 'GET') {
      db.prepare('SELECT 1').get();
      return sendJson(res, 200, { status: 'ok' });
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
      }
      return await handleApi(req, res, url);
    }
    // Static files (app shell is public; data stays behind auth)
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join(PUBLIC_DIR, filePath);
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error('Request error:', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`🛒 FreshMart POS (production) running at http://${HOST}:${PORT}`);
    console.log(`   Default admin login: admin / admin123  (password rotation required at first login)`);
    console.log(`   Stripe payments: ${STRIPE_SECRET_KEY ? 'ENABLED' : 'not configured (card payments simulated)'}`);
  });
}

module.exports = { server, db };
