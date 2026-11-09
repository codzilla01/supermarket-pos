'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let me = null;               // {id, username, role, name}
let settings = { store_name: 'FreshMart', tax_rate: '0.08', currency: '$', currency_code: 'USD', low_stock_threshold: '10', register_name: 'Register 1', points_per_dollar: '1', points_value: '0.01' };
let products = [];
let customers = [];
let cart = {};               // productId -> qty
let activeCategory = 'All';
let searchTerm = '';
let payMethod = 'cash';
let shift = null;            // open shift or null
let stripeConfigured = false;
let stripePublishableKey = '';
let stripe = null, stripeCard = null;
let lastSale = null;

const money = n => settings.currency + Number(n || 0).toFixed(2);
const taxRate = () => Math.min(1, Math.max(0, parseFloat(settings.tax_rate) || 0));
const pointsValue = () => Math.max(0, parseFloat(settings.points_value) || 0);

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  } catch (e) {
    throw Object.assign(new Error('Network error'), { offline: true });
  }
  if (res.status === 401) { showLogin(); throw new Error('Session expired'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.json();
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), 3000);
}

// ---------- Clock ----------
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);
$('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ---------- Auth / login ----------
function showLogin() {
  me = null;
  $('#app').hidden = true;
  $('#login-screen').hidden = false;
}
function showApp() {
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  const admin = me.role === 'admin';
  $$('.admin-only').forEach(el => { el.style.display = admin ? '' : 'none'; });
  $('#user-chip').textContent = `${me.name || me.username} (${me.role})`;
  $('#brand-name').textContent = settings.store_name;
  $('#login-store').textContent = settings.store_name;
  document.title = `${settings.store_name} — Supermarket POS`;
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#login-user').value, password: $('#login-pass').value }) });
    me = data.user;
    if (me.mustChangePassword) {
      $('#login-screen').hidden = true;
      $('#force-password-modal').hidden = false;
      $('#force-pw-current').focus();
      return;
    }
    await loadConfig();
    showApp();
    await refreshAll();
    await ensureShift();
    await syncQueue();
  } catch (e2) {
    err.textContent = '⚠️ ' + e2.message;
    err.hidden = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  showLogin();
});

async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    settings = { ...settings, ...cfg.settings };
    stripeConfigured = cfg.stripe;
    stripePublishableKey = cfg.stripePublishableKey;
  } catch { /* keep defaults */ }
}

// ---------- Tabs ----------
$$('.tab').forEach(btn => btn.addEventListener('click', () => {
  $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + btn.dataset.view));
  if (btn.dataset.view === 'inventory') renderInventory();
  if (btn.dataset.view === 'sales') renderSales();
  if (btn.dataset.view === 'customers') renderCustomers();
  if (btn.dataset.view === 'settings') renderSettings();
}));

// ---------- Shifts ----------
async function refreshShift() {
  try { shift = (await api('/api/shifts/current')).shift; } catch { shift = null; }
  const badge = $('#shift-badge');
  if (shift) {
    badge.textContent = `🟢 Shift #${shift.id} · ${shift.register}`;
    badge.classList.add('open');
  } else {
    badge.textContent = '⚪ No shift';
    badge.classList.remove('open');
  }
}

async function ensureShift() {
  await refreshShift();
  if (!shift) openShiftModal('open');
}

function openShiftModal(mode) {
  $('#shift-modal-title').textContent = mode === 'open' ? '🟢 Open shift' : '🔴 Close shift';
  $('#shift-open-fields').hidden = mode !== 'open';
  $('#shift-close-fields').hidden = mode !== 'close';
  $('#shift-confirm').textContent = mode === 'open' ? 'Open shift' : 'Close shift';
  $('#shift-confirm').dataset.mode = mode;
  if (mode === 'close' && shift) {
    // Expected cash is computed server-side on close; show estimate from sales
    $('#expected-cash').textContent = '—';
    $('#closing-amount').value = '';
    $('#variance').textContent = '$0.00';
  }
  $('#shift-modal').hidden = false;
}

$('#shift-badge').addEventListener('click', () => openShiftModal(shift ? 'close' : 'open'));
$('#shift-confirm').addEventListener('click', async () => {
  const mode = $('#shift-confirm').dataset.mode;
  try {
    if (mode === 'open') {
      shift = await api('/api/shifts/open', { method: 'POST', body: JSON.stringify({ openingFloat: parseFloat($('#opening-float').value) || 0 }) });
      toast(`🟢 Shift #${shift.id} opened`);
    } else {
      const result = await api('/api/shifts/close', { method: 'POST', body: JSON.stringify({ closingAmount: parseFloat($('#closing-amount').value) || 0 }) });
      shift = null;
      toast(`🔴 Shift closed. Variance: ${money(result.variance)}`);
    }
    $('#shift-modal').hidden = true;
    await refreshShift();
  } catch (e) { toast('⚠️ ' + e.message); }
});

// ---------- POS ----------
function categories() { return ['All', ...new Set(products.map(p => p.category))]; }

function renderCategories() {
  $('#categories').innerHTML = categories().map(c =>
    `<button class="cat-btn ${c === activeCategory ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  $$('.cat-btn').forEach(b => b.addEventListener('click', () => { activeCategory = b.dataset.cat; renderCategories(); renderGrid(); }));
}

function visibleProducts() {
  const q = searchTerm.trim().toLowerCase();
  return products.filter(p =>
    (activeCategory === 'All' || p.category === activeCategory) &&
    (!q || p.name.toLowerCase().includes(q) || String(p.barcode).includes(q)));
}

function renderGrid() {
  const list = visibleProducts();
  $('#grid-empty').hidden = list.length > 0;
  $('#grid').innerHTML = list.map(p => {
    const out = p.stock <= 0;
    const low = p.stock > 0 && p.stock <= +settings.low_stock_threshold;
    return `<div class="product ${out ? 'out' : ''}" data-id="${p.id}" title="${out ? 'Out of stock' : 'Add to cart'}">
      <span class="emoji">${p.emoji || '📦'}</span>
      <div class="name">${esc(p.name)}</div>
      <div class="price">${money(p.price)}<small style="font-size:11px;color:var(--muted);font-weight:400"> /${esc(p.unit)}</small></div>
      <div class="stock ${low ? 'low' : ''}">${out ? 'Out of stock' : p.stock + ' in stock'}</div>
    </div>`;
  }).join('');
  $$('.product').forEach(el => el.addEventListener('click', () => addToCart(+el.dataset.id)));
}

function addToCart(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const qty = cart[id] || 0;
  if (qty >= p.stock) { toast(`⚠️ Only ${p.stock} × ${p.name} in stock`); return; }
  cart[id] = qty + 1;
  renderCart();
}

function setQty(id, qty) {
  const p = products.find(x => x.id === id);
  if (qty <= 0) delete cart[id];
  else if (qty > p.stock) { toast(`⚠️ Only ${p.stock} in stock`); return; }
  else cart[id] = qty;
  renderCart();
}

function cartEntries() {
  return Object.entries(cart).map(([id, qty]) => ({ product: products.find(p => p.id === +id), qty })).filter(e => e.product);
}

function selectedCustomer() {
  const id = +$('#customer-select').value;
  return customers.find(c => c.id === id) || null;
}

function totals() {
  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const entries = cartEntries();
  const subtotal = r2(entries.reduce((s, e) => s + e.product.price * e.qty, 0));
  const discountPct = Math.min(100, Math.max(0, parseFloat($('#discount').value) || 0));
  const discount = r2(subtotal * discountPct / 100);
  const afterDiscount = Math.max(0, r2(subtotal - discount));
  const cust = selectedCustomer();
  const redeemLimit = pointsValue() > 0 ? Math.floor(afterDiscount / pointsValue()) : 0;
  const redeem = cust && $('#redeem-points').checked ? Math.min(cust.points, redeemLimit) : 0;
  const pointsDiscount = r2(redeem * pointsValue());
  let allocated = 0, taxable = 0, tax = 0;
  entries.forEach(({ product: p, qty }, idx) => {
    const line = r2(p.price * qty);
    const netBeforePoints = r2(line * (1 - discountPct / 100));
    const pointsShare = idx === entries.length - 1
      ? r2(pointsDiscount - allocated)
      : r2(afterDiscount > 0 ? pointsDiscount * netBeforePoints / afterDiscount : 0);
    allocated = r2(allocated + pointsShare);
    const lineTaxable = r2(Math.max(0, netBeforePoints - pointsShare));
    const rate = p.tax_rate == null ? taxRate() : Math.max(0, Math.min(1, Number(p.tax_rate)));
    taxable += lineTaxable;
    tax += r2(lineTaxable * rate);
  });
  taxable = r2(taxable);
  tax = r2(tax);
  return { subtotal, discountPct, discount, redeem, pointsDiscount, tax, total: r2(taxable + tax) };
}

function renderCart() {
  const entries = cartEntries();
  $('#cart-empty').hidden = entries.length > 0;
  $('#cart-items').innerHTML = entries.map(({ product: p, qty }) => `
    <div class="cart-item">
      <span class="emoji">${p.emoji || '📦'}</span>
      <div class="info"><div class="n">${esc(p.name)}</div><div class="p">${money(p.price)} / ${esc(p.unit)}</div></div>
      <div class="qty"><button data-act="dec" data-id="${p.id}">−</button><span>${qty}</span><button data-act="inc" data-id="${p.id}">+</button></div>
      <div class="line-total">${money(p.price * qty)}</div>
      <button class="remove" data-act="del" data-id="${p.id}" title="Remove">🗑</button>
    </div>`).join('');
  $$('#cart-items [data-act]').forEach(b => b.addEventListener('click', () => {
    const id = +b.dataset.id;
    if (b.dataset.act === 'inc') setQty(id, (cart[id] || 0) + 1);
    if (b.dataset.act === 'dec') setQty(id, (cart[id] || 0) - 1);
    if (b.dataset.act === 'del') setQty(id, 0);
  }));
  const t = totals();
  $('#sum-subtotal').textContent = money(t.subtotal);
  $('#sum-discount').textContent = '−' + money(t.discount);
  $('#sum-points').textContent = '−' + money(t.pointsDiscount);
  $('#sum-tax').textContent = money(t.tax);
  $('#sum-total').textContent = money(t.total);
  $('#checkout-btn').disabled = entries.length === 0;
  const cust = selectedCustomer();
  $('#points-row').hidden = !cust;
  if (cust) {
    const earn = Math.floor(t.total * (parseFloat(settings.points_per_dollar) || 0));
    $('#points-info').textContent = `⭐ ${cust.points} pts · earns ${earn} this sale`;
    $('#redeem-points').disabled = cust.points <= 0;
  }
}

function renderCustomerSelect() {
  const current = $('#customer-select').value;
  $('#customer-select').innerHTML = '<option value="">👤 Walk-in customer</option>' +
    customers.map(c => `<option value="${c.id}">${esc(c.name)} (${c.points} pts)</option>`).join('');
  $('#customer-select').value = current;
}
$('#customer-select').addEventListener('change', renderCart);
$('#redeem-points').addEventListener('change', renderCart);

$('#search').addEventListener('input', e => { searchTerm = e.target.value; renderGrid(); });
$('#discount').addEventListener('input', renderCart);
$('#clear-cart').addEventListener('click', () => { cart = {}; $('#discount').value = 0; $('#redeem-points').checked = false; renderCart(); });

$('#barcode').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const code = e.target.value.trim();
  e.target.value = '';
  if (!code) return;
  const p = products.find(x => String(x.barcode) === code);
  if (p) { addToCart(p.id); toast(`✅ ${p.name} added`); }
  else toast(`❌ No product with barcode ${code}`);
});

// ---------- Checkout ----------
function openModal(id) { $(id).hidden = false; }
$$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('.modal-backdrop').hidden = true));
$$('.modal-backdrop').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.hidden = true; }));

$('#checkout-btn').addEventListener('click', async () => {
  if (!shift) { toast('⚠️ Open a shift first (click the shift badge)'); openShiftModal('open'); return; }
  payMethod = 'cash';
  $$('.pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'cash'));
  $('#cash-fields').style.display = '';
  $('#card-fields').hidden = true;
  $('#tendered').value = '';
  $('#change').textContent = money(0);
  $('#checkout-error').hidden = true;
  $('#due').textContent = money(totals().total);
  openModal('#checkout-modal');
  if (stripeConfigured && !stripe) await initStripe();
  setTimeout(() => $('#tendered').focus(), 50);
});

$$('.pay-btn').forEach(b => b.addEventListener('click', () => {
  payMethod = b.dataset.pay;
  $$('.pay-btn').forEach(x => x.classList.toggle('active', x === b));
  $('#cash-fields').style.display = payMethod === 'cash' ? '' : 'none';
  $('#card-fields').hidden = payMethod !== 'card';
  if (payMethod === 'card') {
    $('#card-note').textContent = stripeConfigured
      ? 'Enter card details below (processed by Stripe).'
      : 'Stripe is not configured on this server — the card payment will be simulated.';
  }
}));

async function initStripe() {
  try {
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    document.head.appendChild(s);
    await new Promise((res, rej) => { s.onload = res; s.onerror = rej; });
    stripe = window.Stripe(stripePublishableKey);
    stripeCard = stripe.elements().create('card');
    stripeCard.mount('#stripe-card-element');
  } catch { stripe = null; }
}

function updateChange() {
  const tendered = parseFloat($('#tendered').value) || 0;
  $('#change').textContent = money(Math.max(0, tendered - totals().total));
}
$('#tendered').addEventListener('input', updateChange);
$$('.quick button').forEach(b => b.addEventListener('click', () => {
  const total = totals().total;
  $('#tendered').value = (b.dataset.amt === 'exact' ? total : parseFloat(b.dataset.amt)).toFixed(2);
  updateChange();
}));

$('#complete-sale').addEventListener('click', async () => {
  const t = totals();
  const err = $('#checkout-error');
  err.hidden = true;
  const cust = selectedCustomer();
  const payload = {
    items: cartEntries().map(e => ({ id: e.product.id, qty: e.qty })),
    discountPct: t.discountPct,
    payment: payMethod,
    tendered: payMethod === 'cash' ? parseFloat($('#tendered').value) || 0 : null,
    customerId: cust?.id ?? null,
    redeemPoints: t.redeem,
    idempotencyKey: (crypto.randomUUID ? crypto.randomUUID() : `pos-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  };
  if (payMethod === 'cash' && payload.tendered < t.total) {
    err.textContent = `⚠️ Tendered amount is less than the total (${money(t.total)}).`;
    err.hidden = false;
    return;
  }
  if (payMethod === 'card' && stripeConfigured && stripe) {
    try {
      const { clientSecret } = await api('/api/payments/intent', { method: 'POST', body: JSON.stringify({ amount: t.total }) });
      const result = await stripe.confirmCardPayment(clientSecret, { payment_method: { card: stripeCard } });
      if (result.error) { err.textContent = '⚠️ ' + result.error.message; err.hidden = false; return; }
      payload.paymentIntentId = result.paymentIntent.id;
    } catch (e) { err.textContent = '⚠️ ' + e.message; err.hidden = false; return; }
  }
  try {
    lastSale = await api('/api/sales', { method: 'POST', body: JSON.stringify(payload) });
    afterSale();
  } catch (e) {
    if (e.offline) {
      queueSale(payload);
      toast('📶 Offline — sale queued and will sync automatically');
      cart = {}; $('#discount').value = 0; $('#redeem-points').checked = false;
      renderCart();
      $('#checkout-modal').hidden = true;
      return;
    }
    err.textContent = '⚠️ ' + e.message;
    err.hidden = false;
  }
});

async function afterSale() {
  products = await api('/api/products');
  customers = await api('/api/customers');
  cart = {};
  $('#discount').value = 0;
  $('#redeem-points').checked = false;
  renderCategories(); renderGrid(); renderCart(); renderCustomerSelect();
  $('#checkout-modal').hidden = true;
  showReceipt(lastSale);
}

function showReceipt(sale) {
  const rows = sale.items.map(i =>
    `<div class="r-row"><span>${i.emoji} ${esc(i.name)} ×${i.qty}</span><span>${money(i.line_total)}</span></div>`).join('');
  const taxRows = sale.items.length && sale.items.every(i => i.tax_rate != null && i.tax != null)
    ? Object.entries(sale.items.reduce((groups, i) => {
        const key = Number(i.tax_rate);
        groups[key] = (groups[key] || 0) + Number(i.tax);
        return groups;
      }, {})).map(([rate, amount]) => `<div class="r-row"><span>Tax (${(Number(rate) * 100).toFixed(0)}%)</span><span>${money(amount)}</span></div>`).join('')
    : `<div class="r-row"><span>Tax</span><span>${money(sale.tax)}</span></div>`;
  $('#receipt-body').innerHTML = `
    <div class="r-head"><h2>🛒 ${esc(settings.store_name)}</h2><div>${esc(settings.register_name)}</div>
    <div>Sale #${sale.id} · ${new Date(sale.date).toLocaleString()}</div>
    <div>Cashier: ${esc(me.name || me.username)}</div></div>
    ${rows}
    <div class="r-row"><span>Subtotal</span><span>${money(sale.subtotal)}</span></div>
    ${sale.discount ? `<div class="r-row"><span>Discount (${sale.discount_pct}%)</span><span>−${money(sale.discount)}</span></div>` : ''}
    ${sale.points_redeemed ? `<div class="r-row"><span>Points redeemed (${sale.points_redeemed})</span><span>−${money(sale.points_redeemed * pointsValue())}</span></div>` : ''}
    ${taxRows}
    <div class="r-row r-total"><span>TOTAL</span><span>${money(sale.total)}</span></div>
    <div class="r-row"><span>Payment</span><span>${sale.payment === 'card' ? '💳 Card' : '💵 Cash'}</span></div>
    ${sale.tendered != null ? `<div class="r-row"><span>Tendered</span><span>${money(sale.tendered)}</span></div><div class="r-row"><span>Change</span><span>${money(sale.change)}</span></div>` : ''}
    ${sale.points_earned ? `<div class="r-row"><span>⭐ Points earned</span><span>+${sale.points_earned}</span></div>` : ''}
    <div class="r-foot">Thank you for shopping with us! 🥦</div>`;
  openModal('#receipt-modal');
}
$('#print-receipt').addEventListener('click', () => window.print());

// ---------- Offline queue ----------
const QUEUE_KEY = 'pos_offline_queue';
function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
function queueSale(payload) {
  const q = getQueue();
  q.push({ payload, queuedAt: new Date().toISOString() });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  updateQueueBadge();
}
function updateQueueBadge() {
  const n = getQueue().length;
  const badge = $('#queue-badge');
  badge.hidden = n === 0;
  badge.textContent = `📶 ${n} queued`;
  const issues = getQueue().map(x => x.lastError).filter(Boolean);
  badge.title = issues.length ? `Tap to retry. Last error: ${issues[0]}` : 'Tap to sync queued sales';
}
$('#queue-badge').addEventListener('click', syncQueue);
async function syncQueue() {
  const q = getQueue();
  if (!q.length) return;
  const remaining = [];
  for (const entry of q) {
    try {
      await api('/api/sales', { method: 'POST', body: JSON.stringify(entry.payload) });
    } catch (e) {
      // Preserve failed entries for cashier review; never silently discard a sale.
      entry.lastError = e.message;
      remaining.push(entry);
    }
  }
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  updateQueueBadge();
  if (remaining.length < q.length) {
    products = await api('/api/products').catch(() => products);
    renderGrid();
    toast(`✅ Synced ${q.length - remaining.length} offline sale(s)`);
  }
  if (remaining.length) toast(`⚠️ ${remaining.length} queued sale(s) need review or retry`);
}
window.addEventListener('online', syncQueue);

// ---------- Inventory ----------
function renderInventory() {
  $('#inv-count').textContent = `(${products.length} products)`;
  const admin = me.role === 'admin';
  $('#inv-body').innerHTML = products.map(p => {
    const badge = p.stock <= 0 ? '<span class="stock-badge out">Out</span>' : p.stock <= +settings.low_stock_threshold ? `<span class="stock-badge low">${p.stock}</span>` : `<span class="stock-badge">${p.stock}</span>`;
    return `<tr>
      <td style="font-size:22px">${p.emoji || '📦'}</td>
      <td><strong>${esc(p.name)}</strong></td><td>${esc(p.category)}</td><td>${esc(p.barcode)}</td>
      <td>${money(p.price)}</td><td>${esc(p.unit)}</td><td>${badge}</td>
      ${admin ? `<td><button class="icon-btn" data-edit="${p.id}" title="Edit">✏️</button><button class="icon-btn" data-del="${p.id}" title="Delete">🗑</button></td>` : '<td></td>'}</tr>`;
  }).join('');
  $$('#inv-body [data-edit]').forEach(b => b.addEventListener('click', () => openProductForm(products.find(p => p.id === +b.dataset.edit))));
  $$('#inv-body [data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Remove this product from the catalogue?')) return;
    await api(`/api/products/${b.dataset.del}`, { method: 'DELETE' });
    products = await api('/api/products');
    renderCategories(); renderGrid(); renderInventory();
    toast('🗑 Product removed');
  }));
}

function openProductForm(p) {
  $('#product-form-title').textContent = p ? 'Edit product' : 'Add product';
  $('#f-id').value = p ? p.id : '';
  $('#f-name').value = p ? p.name : '';
  $('#f-category').value = p ? p.category : '';
  $('#f-price').value = p ? p.price : '';
  $('#f-stock').value = p ? p.stock : '';
  $('#f-unit').value = p ? p.unit : 'each';
  $('#f-emoji').value = p ? (p.emoji || '📦') : '📦';
  $('#f-barcode').value = p ? p.barcode : '';
  $('#f-tax-rate').value = p && p.tax_rate != null ? p.tax_rate : '';
  $('#cat-list').innerHTML = categories().filter(c => c !== 'All').map(c => `<option value="${esc(c)}">`).join('');
  openModal('#product-modal');
}
$('#add-product-btn').addEventListener('click', () => openProductForm(null));
$('#product-form').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('#f-id').value;
  const body = { name: $('#f-name').value, category: $('#f-category').value, price: parseFloat($('#f-price').value), stock: parseInt($('#f-stock').value), unit: $('#f-unit').value, emoji: $('#f-emoji').value, barcode: $('#f-barcode').value, taxRate: $('#f-tax-rate').value };
  try {
    if (id) await api(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/products', { method: 'POST', body: JSON.stringify(body) });
    products = await api('/api/products');
    $('#product-modal').hidden = true;
    renderCategories(); renderGrid(); renderInventory();
    toast('✅ Product saved');
  } catch (err) { toast('⚠️ ' + err.message); }
});

// ---------- Customers ----------
function renderCustomers() {
  $('#cust-count').textContent = `(${customers.length} registered)`;
  const admin = me.role === 'admin';
  $('#cust-body').innerHTML = customers.map(c => `<tr>
    <td><strong>${esc(c.name)}</strong></td><td>${esc(c.phone || '—')}</td><td>${esc(c.email || '—')}</td>
    <td>⭐ ${c.points}</td><td>${new Date(c.created_at).toLocaleDateString()}</td>
    ${admin ? `<td><button class="icon-btn" data-edit="${c.id}" title="Edit">✏️</button></td>` : '<td></td>'}</tr>`).join('')
    || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No customers yet.</td></tr>';
  $$('#cust-body [data-edit]').forEach(b => b.addEventListener('click', () => openCustomerForm(customers.find(c => c.id === +b.dataset.edit))));
}

function openCustomerForm(c) {
  $('#customer-form-title').textContent = c ? 'Edit customer' : 'Add customer';
  $('#c-id').value = c ? c.id : '';
  $('#c-name').value = c ? c.name : '';
  $('#c-phone').value = c ? (c.phone || '') : '';
  $('#c-email').value = c ? (c.email || '') : '';
  $('#c-points-wrap').hidden = !c;
  $('#c-points').value = c ? c.points : 0;
  openModal('#customer-modal');
}
$('#add-customer-btn').addEventListener('click', () => openCustomerForm(null));
$('#new-customer-btn').addEventListener('click', () => openCustomerForm(null));
$('#customer-form').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('#c-id').value;
  const body = { name: $('#c-name').value, phone: $('#c-phone').value, email: $('#c-email').value, points: parseInt($('#c-points').value) || 0 };
  try {
    if (id) await api(`/api/customers/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/customers', { method: 'POST', body: JSON.stringify(body) });
    customers = await api('/api/customers');
    $('#customer-modal').hidden = true;
    renderCustomerSelect(); renderCustomers(); renderCart();
    toast('✅ Customer saved');
  } catch (err) { toast('⚠️ ' + err.message); }
});

// ---------- Sales ----------
async function renderSales() {
  const [stats, sales, shifts] = await Promise.all([api('/api/stats'), api('/api/sales'), api('/api/shifts')]);
  const t = stats.today;
  $('#stats').innerHTML = `
    <div class="stat"><div class="label">💰 Revenue today</div><div class="value">${money(t.revenue)}</div></div>
    <div class="stat"><div class="label">🧾 Transactions today</div><div class="value">${t.transactions}</div></div>
    <div class="stat"><div class="label">📦 Items sold today</div><div class="value">${t.items}</div></div>
    <div class="stat"><div class="label">🏷 All-time revenue</div><div class="value">${money(stats.total.revenue)}</div></div>
    <div class="stat"><div class="label">🧾 All-time transactions</div><div class="value">${stats.total.transactions}</div></div>`;
  const maxRev = stats.top[0]?.revenue || 1;
  $('#top-products').innerHTML = stats.top.length ? stats.top.map(p => `
    <div class="top-row"><span>${p.emoji} ${esc(p.name)} <span class="muted">×${p.qty}</span></span><strong>${money(p.revenue)}</strong></div>
    <div class="bar"><div style="width:${(p.revenue / maxRev * 100).toFixed(1)}%"></div></div>`).join('')
    : '<p class="muted">No sales yet.</p>';
  $('#by-cashier').innerHTML = stats.byCashier.length ? stats.byCashier.map(c =>
    `<div class="top-row"><span>👤 ${esc(c.cashier)} <span class="muted">${c.transactions} sales</span></span><strong>${money(c.revenue)}</strong></div>`).join('')
    : '<p class="muted">No sales yet.</p>';
  $('#low-stock').innerHTML = stats.lowStock.length ? stats.lowStock.map(p =>
    `<div class="top-row"><span>${p.emoji} ${esc(p.name)}</span><span class="stock-badge ${p.stock <= 0 ? 'out' : 'low'}">${p.stock} left</span></div>`).join('')
    : '<p class="muted">✅ All products are well stocked.</p>';

  const filter = $('#sales-filter').value;
  const visible = sales.filter(s => filter === 'all' || s.status === filter);
  const admin = me.role === 'admin';
  $('#sales-body').innerHTML = visible.length ? visible.map(s => `<tr>
    <td>#${s.id}</td><td>${new Date(s.date).toLocaleString()}</td>
    <td>${esc(s.cashier_name || '—')}</td><td>${esc(s.customer_name || '—')}</td>
    <td>${s.items.reduce((a, i) => a + i.qty, 0)}</td>
    <td>${s.payment === 'card' ? '💳 Card' : '💵 Cash'}</td>
    <td><span class="status-badge ${s.status}">${s.status}</span></td>
    <td><strong>${money(s.total)}</strong></td>
    ${admin && s.status === 'completed' ? `<td><button class="icon-btn" data-void="${s.id}" title="Void sale">🚫</button><button class="icon-btn" data-refund="${s.id}" title="Refund sale">↩️</button></td>` : '<td></td>'}</tr>`).join('')
    : '<tr><td colspan="9" style="text-align:center;color:var(--muted)">No transactions.</td></tr>';
  $$('#sales-body [data-void]').forEach(b => b.addEventListener('click', () => saleAction(b.dataset.void, 'void')));
  $$('#sales-body [data-refund]').forEach(b => b.addEventListener('click', () => saleAction(b.dataset.refund, 'refund')));

  $('#shifts-body').innerHTML = shifts.map(s => `<tr>
    <td>#${s.id}</td><td>${esc(s.cashier_name || '—')}</td><td>${esc(s.register)}</td>
    <td>${new Date(s.opened_at).toLocaleString()}</td><td>${s.closed_at ? new Date(s.closed_at).toLocaleString() : '—'}</td>
    <td>${money(s.opening_float)}</td><td>${s.expected_cash != null ? money(s.expected_cash) : '—'}</td>
    <td>${s.closing_amount != null ? money(s.closing_amount) : '—'}</td>
    <td>${s.expected_cash != null && s.closing_amount != null ? money(s.closing_amount - s.expected_cash) : '—'}</td>
    <td><span class="status-badge ${s.status === 'open' ? '' : 'refunded'}">${s.status}</span></td></tr>`).join('')
    || '<tr><td colspan="10" style="text-align:center;color:var(--muted)">No shifts yet.</td></tr>';

  $('#export-btn').onclick = () => {
    const rows = [['Sale ID', 'Date', 'Cashier', 'Customer', 'Item', 'Qty', 'Unit price', 'Line total', 'Discount %', 'Tax', 'Total', 'Payment', 'Status']];
    for (const s of sales) for (const i of s.items)
      rows.push([s.id, s.date, s.cashier_name || '', s.customer_name || '', i.name, i.qty, i.price, i.line_total, s.discount_pct, s.tax, s.total, s.payment, s.status]);
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'freshmart-sales.csv';
    a.click();
  };
}
$('#sales-filter').addEventListener('change', renderSales);

async function saleAction(id, action) {
  if (!confirm(`${action === 'void' ? 'Void' : 'Refund'} sale #${id}? Stock will be restored.`)) return;
  try {
    const result = await api(`/api/sales/${id}/${action}`, { method: 'POST' });
    products = await api('/api/products');
    renderGrid(); renderSales();
    toast(result.status === 'refund_pending' ? '⚠️ Provider refund is pending' : `✅ Sale ${action === 'void' ? 'voided' : 'refunded'}`);
  } catch (e) { toast('⚠️ ' + e.message); }
}

// ---------- Settings ----------
async function renderSettings() {
  if (me.role !== 'admin') return;
  for (const k of ['store_name', 'tax_rate', 'currency', 'currency_code', 'low_stock_threshold', 'register_name', 'points_per_dollar', 'points_value']) {
    $('#s-' + k).value = settings[k];
  }
  $('#stripe-status').innerHTML = stripeConfigured
    ? '✅ Stripe is configured — card payments are processed live.'
    : '⚠️ Stripe is not configured (set <code>STRIPE_SECRET_KEY</code> &amp; <code>STRIPE_PUBLISHABLE_KEY</code> on the server). Card payments are simulated.';
  const users = await api('/api/users');
  $('#users-body').innerHTML = users.map(u => `<tr>
    <td><strong>${esc(u.username)}</strong></td><td>${esc(u.name)}</td>
    <td>${u.role === 'admin' ? '👑 Admin' : '🧑‍💼 Cashier'}</td>
    <td>${u.active ? '<span class="stock-badge">Active</span>' : '<span class="stock-badge out">Disabled</span>'}</td>
    <td>${u.id !== me.id ? `<button class="icon-btn" data-toggle="${u.id}" title="Enable/disable">${u.active ? '🚫' : '✅'}</button>` : ''}</td></tr>`).join('');
  $$('#users-body [data-toggle]').forEach(b => b.addEventListener('click', async () => {
    const u = users.find(x => x.id === +b.dataset.toggle);
    await api(`/api/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ active: !u.active }) });
    renderSettings();
  }));
}

$('#store-form').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {};
  for (const k of ['store_name', 'tax_rate', 'currency', 'currency_code', 'low_stock_threshold', 'register_name', 'points_per_dollar', 'points_value']) body[k] = $('#s-' + k).value;
  try {
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    showApp();
    renderCart(); renderGrid();
    toast('✅ Settings saved');
  } catch (err) { toast('⚠️ ' + err.message); }
});

$('#force-password-form').addEventListener('submit', async e => {
  e.preventDefault();
  const error = $('#force-pw-error');
  error.hidden = true;
  try {
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current: $('#force-pw-current').value, next: $('#force-pw-next').value }) });
    $('#force-password-modal').hidden = true;
    $('#force-pw-current').value = $('#force-pw-next').value = '';
    me.mustChangePassword = false;
    await loadConfig();
    showApp();
    await refreshAll();
    await ensureShift();
    await syncQueue();
  } catch (err) {
    error.textContent = '⚠️ ' + err.message;
    error.hidden = false;
  }
});

$('#password-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current: $('#pw-current').value, next: $('#pw-next').value }) });
    $('#pw-current').value = $('#pw-next').value = '';
    toast('✅ Password changed');
  } catch (err) { toast('⚠️ ' + err.message); }
});

$('#user-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ username: $('#u-username').value, name: $('#u-name').value, password: $('#u-password').value, role: $('#u-role').value }) });
    $('#u-username').value = $('#u-name').value = $('#u-password').value = '';
    renderSettings();
    toast('✅ User created');
  } catch (err) { toast('⚠️ ' + err.message); }
});

$('#backup-export').addEventListener('click', async () => {
  const dump = await api('/api/backup');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }));
  a.download = `freshmart-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast('✅ Backup exported');
});

$('#backup-import').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('Importing a backup replaces ALL current products, sales and customers. Continue?')) { e.target.value = ''; return; }
  try {
    const data = JSON.parse(await file.text());
    await api('/api/backup/import', { method: 'POST', body: JSON.stringify(data) });
    await refreshAll();
    toast('✅ Backup imported');
  } catch (err) { toast('⚠️ ' + err.message); }
  e.target.value = '';
});

// ---------- Init ----------
async function refreshAll() {
  [products, customers] = await Promise.all([api('/api/products'), api('/api/customers')]);
  renderCategories(); renderGrid(); renderCart(); renderCustomerSelect();
  updateQueueBadge();
}

(async () => {
  // Try to restore an existing session
  try {
    const data = await api('/api/me');
    me = data.user;
    if (me.must_change_password) {
      $('#login-screen').hidden = true;
      $('#force-password-modal').hidden = false;
      $('#force-pw-current').focus();
    } else {
      await loadConfig();
      showApp();
      await refreshAll();
      await ensureShift();
      await syncQueue();
    }
  } catch {
    showLogin();
  }
  // Offline support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
