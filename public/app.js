'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = (key, vars) => I18N.t(key, vars);
const lang = () => I18N.lang;

let me = null;               // {id, username, role, name}
let settings = { store_name: 'FreshMart', store_address: '', store_phone: '', vat_number: '', receipt_footer: '', tax_rate: '0.08', currency: 'ج.م', currency_code: 'EGP', low_stock_threshold: '10', register_name: 'Register 1', points_per_dollar: '1', points_value: '0.01' };
let products = [];
let customers = [];
let cart = {};               // productId -> qty
let activeCategory = 'All';
let searchTerm = '';
let payMethod = 'cash';
let shift = null;            // open shift or null
let lastSale = null;

const nf = (n, digits = 2) => new Intl.NumberFormat(I18N.locale(), {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
}).format(Number(n || 0));
const money = n => (lang() === 'ar' ? `${nf(n)} ${settings.currency}` : `${settings.currency}${nf(n)}`);
const fmtDate = value => (value ? new Date(value).toLocaleString(I18N.locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDateShort = value => (value ? new Date(value).toLocaleDateString(I18N.locale()) : '—');
const taxRate = () => Math.min(1, Math.max(0, parseFloat(settings.tax_rate) || 0));
const pointsValue = () => Math.max(0, parseFloat(settings.points_value) || 0);
const REGISTER_KEY = 'pos_terminal_register';
const terminalRegister = () => localStorage.getItem(REGISTER_KEY) || settings.register_name || 'Register 1';

// Store data (units) is saved in canonical English; only the display is localized.
const unitLabel = unit => I18N.unitLabel(unit);
const unitCanonical = unit => I18N.unitCanonical(unit);
const statusLabel = status => t(`status.${status}`);
const roleLabel = role => t(`role.${role}`);

/** Turn an API failure into an error the cashier can act on. */
function apiError(status, err, contentType) {
  const isJson = String(contentType || '').includes('application/json');
  if (!isJson) {
    // A host that answers /api/* with an HTML page (static hosting, missing Node
    // process, proxy timeout, wrong base URL) is never a POS server reply.
    return Object.assign(new Error(t(status === 404 ? 'err.apiMissing' : 'err.apiHtml', { status })), {
      code: 'API_NOT_SERVED', status, html: true, retryable: true,
    });
  }
  if (status === 404) return Object.assign(new Error(t('err.apiRoute')), { code: 'API_NOT_FOUND', status, retryable: true });
  if (status >= 500) return Object.assign(new Error(t('err.serverDown', { status })), { code: 'SERVER_ERROR', status, retryable: true });
  // Server sends an English `error` plus an Arabic `messageAr`; show the one that matches the UI language.
  return new Error((lang() === 'ar' ? (err.messageAr || err.error) : err.error) || t('err.request', { status }));
}

async function api(path, opts = {}) {
  let res;
  try {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-POS-Register': terminalRegister(), ...(opts.headers || {}) };
    res = await fetch(path, { ...opts, headers });
  } catch (e) {
    throw Object.assign(new Error(t('err.network')), { offline: true });
  }
  if (res.status === 401) { showLogin(); throw new Error(t('err.session')); }
  if (!res.ok) {
    const contentType = res.headers.get('content-type');
    const err = await res.json().catch(() => ({}));
    if (res.status === 402 && me) { me.subscriptionStatus = err.subscription?.status || 'expired'; showApp(); }
    throw apiError(res.status, err, contentType);
  }
  return res.json();
}

/** Show a blocking, described error instead of a bare HTTP code. */
function reportApiProblem(err) {
  if (err && err.code === 'API_NOT_SERVED') {
    $('#login-error').textContent = '⚠️ ' + err.message;
    $('#login-error').hidden = false;
    $('#diagnostics-card').hidden = false;
    runDiagnostics();
    return true;
  }
  return false;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => (el.hidden = true), 3000);
}

// ---------- Notifications (persistent visual center + optional sound/browser alerts) ----------
const NOTIFICATION_KEY = 'pos_notifications_v1';
const SOUND_KEY = 'pos_notification_sound';
let notificationAudio = null;
let stockSnapshot = new Map();
function readNotifications() {
  try { return JSON.parse(localStorage.getItem(NOTIFICATION_KEY) || '[]'); } catch { return []; }
}
function notificationSoundEnabled() { return localStorage.getItem(SOUND_KEY) !== 'off'; }
function playNotificationSound(level = 'info') {
  if (!notificationSoundEnabled()) return;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    notificationAudio ||= new Audio();
    notificationAudio.resume().catch(() => {});
    const tones = level === 'critical' ? [[880, 0], [660, 0.17]] : level === 'warning' ? [[740, 0]] : [[660, 0]];
    for (const [frequency, delay] of tones) {
      const oscillator = notificationAudio.createOscillator();
      const gain = notificationAudio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.001, notificationAudio.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.12, notificationAudio.currentTime + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, notificationAudio.currentTime + delay + 0.18);
      oscillator.connect(gain); gain.connect(notificationAudio.destination);
      oscillator.start(notificationAudio.currentTime + delay);
      oscillator.stop(notificationAudio.currentTime + delay + 0.2);
    }
  } catch { /* Audio may be blocked until the cashier interacts with the page. */ }
}
function renderNotifications() {
  const items = readNotifications();
  const unread = items.filter(n => !n.read).length;
  const count = $('#notifications-count');
  count.hidden = unread === 0;
  count.textContent = unread > 99 ? '99+' : String(unread);
  $('#notification-sound').textContent = notificationSoundEnabled() ? t('notif.soundOn') : t('notif.soundOff');
  $('#notification-permission').textContent = typeof Notification === 'undefined'
    ? t('notif.alertsUnavailable')
    : (Notification.permission === 'granted' ? t('notif.alertsEnabled') : t('notif.enableAlerts'));
  $('#notification-list').innerHTML = items.length ? items.map(n => `
    <article class="notification-item ${esc(n.level)} ${n.read ? '' : 'unread'}" data-notification-id="${esc(n.id)}">
      <div class="notification-title">${esc(n.title)}</div>
      <div class="notification-message">${esc(n.message)}</div>
      <time>${fmtDate(n.createdAt)}</time>
    </article>`).join('') : `<div class="notification-empty">${esc(t('notif.empty'))}</div>`;
}
function notifyUser(title, message, { level = 'info', key = '', sound = true } = {}) {
  const items = readNotifications();
  const now = Date.now();
  if (key && items.some(n => n.key === key && now - new Date(n.createdAt).getTime() < 5 * 60 * 1000)) return;
  const item = { id: (crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random()}`), key, title, message, level, createdAt: new Date(now).toISOString(), read: false };
  items.unshift(item);
  localStorage.setItem(NOTIFICATION_KEY, JSON.stringify(items.slice(0, 80)));
  renderNotifications();
  if (sound) playNotificationSound(level);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
    try { new Notification(title, { body: message, tag: key || item.id }); } catch { /* Browser notification unsupported */ }
  }
}
function scanStockAlerts(list) {
  const threshold = Math.max(0, Number(settings.low_stock_threshold) || 0);
  for (const p of list) {
    const previous = stockSnapshot.get(p.id);
    if (Number(p.stock) <= threshold) {
      if (Number(p.stock) === 0 && previous && previous.stock > 0) {
        notifyUser(t('notify.stockOut'), t('notify.stockOutNote', { name: p.name }), { level: 'critical', key: `stock-out-${p.id}` });
      } else if (!previous || previous.stock > threshold) {
        const out = Number(p.stock) === 0;
        notifyUser(out ? t('notify.stockOut') : t('notify.stockLow'), t('notify.stockLowNote', { name: p.name, n: p.stock }), { level: out ? 'critical' : 'warning', key: `stock-low-${p.id}` });
      }
    }
    stockSnapshot.set(p.id, { stock: Number(p.stock) });
  }
}
$('#notifications-btn').addEventListener('click', () => {
  const panel = $('#notifications-panel');
  panel.hidden = !panel.hidden;
  $('#notifications-btn').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) renderNotifications();
});
$('#notification-close').addEventListener('click', () => { $('#notifications-panel').hidden = true; $('#notifications-btn').setAttribute('aria-expanded', 'false'); });
$('#notification-sound').addEventListener('click', () => {
  localStorage.setItem(SOUND_KEY, notificationSoundEnabled() ? 'off' : 'on');
  renderNotifications();
  playNotificationSound('success');
});
$('#notification-permission').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') return toast(t('notif.unsupported'));
  const result = await Notification.requestPermission();
  renderNotifications();
  toast(result === 'granted' ? t('notif.granted') : t('notif.notGranted'));
});
$('#notification-read-all').addEventListener('click', () => {
  localStorage.setItem(NOTIFICATION_KEY, JSON.stringify(readNotifications().map(n => ({ ...n, read: true }))));
  renderNotifications();
});
$('#notification-clear').addEventListener('click', () => { localStorage.removeItem(NOTIFICATION_KEY); renderNotifications(); });
$('#notification-list').addEventListener('click', e => {
  const row = e.target.closest('[data-notification-id]');
  if (!row) return;
  const id = row.dataset.notificationId;
  localStorage.setItem(NOTIFICATION_KEY, JSON.stringify(readNotifications().map(n => n.id === id ? { ...n, read: true } : n)));
  renderNotifications();
});
renderNotifications();

// ---------- Clock ----------
function renderClock() {
  $('#clock').textContent = new Date().toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit' });
}
setInterval(renderClock, 1000);
renderClock();

// ---------- Language ----------
$$('[data-lang-toggle]').forEach(btn => btn.addEventListener('click', () => {
  I18N.toggle();
}));
function syncLangControls() {
  $$('input[name="lang-choice"]').forEach(input => { input.checked = input.value === lang(); });
  $$('[data-lang-toggle]').forEach(btn => {
    btn.textContent = t('app.langSwitch');
    btn.title = t('app.langSwitchTitle');
  });
}
$$('input[name="lang-choice"]').forEach(input => input.addEventListener('change', () => {
  if (input.checked) I18N.setLang(input.value);
}));

function relocalize() {
  I18N.apply(document);
  syncLangControls();
  document.title = t('app.title', { store: settings.store_name });
  runDiagnostics();
  renderClock();
  renderNotifications();
  if (!me) return;
  renderUserChip();
  renderCategories(); renderGrid(); renderCart(); renderCustomerSelect();
  updateQueueBadge();
  renderShiftBadge();
  if ($('#view-inventory').classList.contains('active')) renderInventory();
  if ($('#view-sales').classList.contains('active')) safeRender(renderSales);
  if ($('#view-customers').classList.contains('active')) renderCustomers();
  if ($('#view-settings').classList.contains('active')) safeRender(renderSettings);
  if ($('#view-audit').classList.contains('active')) safeRender(renderAudit);
  if ($('#view-purchases').classList.contains('active')) safeRender(renderPurchases);
  if ($('#view-sales').classList.contains('active')) safeRender(renderProfit);
  if ($('#view-stocktake').classList.contains('active')) safeRender(renderStocktake);
  if (importPlan) renderImportPreview(importPlan);
  if ($('#view-subscription').classList.contains('active')) renderSubscriptionStatus();
  if ($('#view-developer').classList.contains('active')) renderDeveloperDashboard();
  if (!$('#checkout-modal').hidden) { $('#due').textContent = money(totals().total); updateChange(); }
  if (!$('#shift-modal').hidden) syncShiftModalCurrency();
  if (lastSale && !$('#receipt-modal').hidden) showReceipt(lastSale);
}
I18N.onChange(relocalize);

// ---------- Server diagnostics (the "request failed (404)" case) ----------
let diagBusy = false;
function diagReport() {
  return [
    `URL: ${location.href}`,
    `State: ${$('#diag-state').textContent}`,
    `GET /api/me: ${$('#diag-api').textContent}`,
    `Network: ${navigator.onLine ? 'online' : 'offline'}`,
    `Lang: ${lang()}`,
    `UA: ${navigator.userAgent}`,
  ].join('\n');
}

/** Probe the API and fill the diagnostics card so the failure is self-explanatory. */
async function runDiagnostics() {
  const card = $('#diagnostics-card');
  if (!card || card.hidden) return;
  if (diagBusy) return;
  diagBusy = true;
  $('#diag-url').textContent = location.href;
  $('#diag-online').textContent = navigator.onLine ? t('diag.onlineYes') : t('diag.onlineNo');
  $('#diag-api').textContent = t('diag.checking');
  $('#diag-state').textContent = t('diag.checking');
  let healthy = false;
  try {
    // /api/config answers 401 JSON when the server is alive — perfect liveness probe.
    const r = await fetch('/api/config', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const type = r.headers.get('content-type') || '';
    healthy = /json/i.test(type) && r.status < 500;
    $('#diag-api').textContent = healthy
      ? `HTTP ${r.status} · JSON ✅`
      : `HTTP ${r.status} · ${type.split(';')[0] || 'HTML'} ❌`;
  } catch {
    $('#diag-api').textContent = t('err.network');
  }
  $('#diag-state').textContent = healthy ? t('diag.stateOk') : t('diag.stateUp');
  diagBusy = false;
}

$('#diag-retry').addEventListener('click', async () => {
  const status = $('#diag-status');
  status.textContent = t('diag.retrying');
  try {
    const r = await fetch('/api/config', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const type = r.headers.get('content-type') || '';
    if (!/json/i.test(type)) throw new Error(t('err.apiMissing', { status: r.status }));
    status.textContent = t('diag.retryOk');
    $('#diagnostics-card').hidden = true;
    location.reload();
  } catch (e) {
    status.textContent = `${t('diag.retryFail')} — ${e.message}`;
    runDiagnostics();
  }
});

$('#diag-copy').addEventListener('click', async () => {
  const status = $('#diag-status');
  const text = diagReport();
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = t('diag.copied');
  } catch {
    // Fallback for non-secure contexts (plain http on a LAN IP).
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    status.textContent = ok ? t('diag.copied') : t('diag.copyFailed');
  }
});

window.addEventListener('online', () => runDiagnostics());
window.addEventListener('offline', () => runDiagnostics());

// ---------- Auth / login ----------
function showLogin() {
  me = null;
  $('#app').hidden = true;
  $('#login-screen').hidden = false;
}
function renderUserChip() {
  if (!me) return;
  const developer = me.role === 'developer';
  $('#user-chip').textContent = `${me.name || me.username} (${developer ? t('role.developer') : (me.role === 'admin' ? t('role.admin') : t('role.cashier'))})`;
}
function showApp() {
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  const admin = me.role === 'admin';
  const developer = me.role === 'developer';
  const blocked = !developer && !['trial', 'active'].includes(me.subscriptionStatus || 'trial');
  $$('.admin-only').forEach(el => { el.style.display = admin ? '' : 'none'; });
  $$('.developer-only').forEach(el => { el.style.display = developer ? '' : 'none'; });
  $$('.subscription-tab').forEach(el => { el.style.display = developer ? 'none' : ''; });
  $$('.tab[data-view="pos"], .tab[data-view="inventory"], .tab[data-view="sales"], .tab[data-view="customers"]').forEach(el => { el.style.display = blocked || developer ? 'none' : ''; });
  $('#shift-badge').style.display = blocked || developer ? 'none' : '';
  $('#notifications-btn').style.display = developer ? 'none' : '';
  $('#queue-badge').style.display = developer ? 'none' : '';
  renderUserChip();
  $('#brand-name').textContent = settings.store_name;
  $('#login-store').textContent = settings.store_name;
  $$('.currency-unit').forEach(el => { el.textContent = settings.currency_code || 'EGP'; });
  document.title = t('app.title', { store: settings.store_name });
  syncLangControls();
  const view = developer ? 'developer' : (blocked ? 'subscription' : 'pos');
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  if (developer) renderDeveloperDashboard();
  if (view === 'subscription') renderSubscriptionStatus();
}

function subscriptionLabel(status) {
  return status === 'active' ? t('status.active')
    : status === 'trial' ? t('sub.trialTitle')
    : status === 'suspended' ? statusLabel('suspended') && t('sub.pausedTitle')
    : statusLabel(status);
}
async function renderSubscriptionStatus() {
  try {
    const sub = await api('/api/subscription');
    $('#subscription-title').textContent = sub.status === 'active' ? t('sub.activeTitle') : (sub.status === 'trial' ? t('sub.trialTitle') : t('sub.pausedTitle'));
    $('#subscription-summary').textContent = sub.status === 'trial'
      ? t(sub.days_remaining === 1 ? 'sub.trialSummaryOne' : 'sub.trialSummary', { n: sub.days_remaining })
      : (sub.status === 'active' ? t('sub.activeSummary', { n: sub.days_remaining, plan: sub.plan }) : t('sub.pausedSummary', { status: subscriptionLabel(sub.status) }));
    $('#subscription-facts').innerHTML = `<span class="license-pill ${esc(sub.status)}">${esc(subscriptionLabel(sub.status))}</span><div><small>${esc(t('sub.plan'))}</small><strong>${esc(sub.plan)}</strong></div><div><small>${esc(t('sub.validThrough'))}</small><strong>${esc(fmtDate(sub.expires_at))}</strong></div><div><small>${esc(t('sub.store'))}</small><strong>${esc(sub.store_name)}</strong></div>`;
  } catch (err) { $('#subscription-summary').textContent = err.message; }
}
async function renderDeveloperDashboard() {
  if (me?.role !== 'developer') return;
  try {
    const data = await api('/api/developer/dashboard');
    const metrics = [
      [t('dev.metricSalesToday'), data.metrics.sales_today],
      [t('dev.metricRevenueToday'), money(data.metrics.revenue_today)],
      [t('dev.metricTeam'), data.metrics.users_active],
      [t('dev.metricProducts'), data.metrics.product_count],
      [t('dev.metricLifetime'), data.metrics.sales_total],
    ];
    $('#dev-metrics').innerHTML = metrics.map(([label, value]) => `<article class="dev-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join('');
    $('#dev-store-name').textContent = data.store_name;
    $('#dev-license-status').textContent = subscriptionLabel(data.status);
    $('#dev-license-status').className = `license-pill ${esc(data.status)}`;
    $('#dev-license-details').innerHTML = `
      <div><small>${esc(t('dev.plan'))}</small><strong>${esc(data.plan)}</strong></div>
      <div><small>${esc(t('dev.started'))}</small><strong>${esc(fmtDate(data.started_at))}</strong></div>
      <div><small>${esc(t('dev.expires'))}</small><strong>${esc(fmtDate(data.expires_at))}</strong></div>
      <div><small>${esc(t('dev.daysRemaining'))}</small><strong>${esc(data.days_remaining)}</strong></div>
      <div><small>${esc(t('dev.activated'))}</small><strong>${esc(fmtDate(data.activated_at))}</strong></div>
      <div><small>${esc(t('dev.lastActivity'))}</small><strong>${esc(fmtDate(data.last_activity_at))}</strong></div>`;
    const eventLabel = action => t(`event.${action}`) === `event.${action}` ? action.replaceAll('_', ' ') : t(`event.${action}`);
    $('#dev-events').innerHTML = data.events.length ? data.events.map(event => `<article class="dev-event"><span class="event-dot ${event.action === 'suspended' ? 'warning' : ''}"></span><div><strong>${esc(eventLabel(event.action))}</strong><p>${esc(event.details)}</p><small>${esc(event.actor)} · ${esc(fmtDate(event.created_at))}</small></div></article>`).join('') : `<p class="muted">${esc(t('dev.noEvents'))}</p>`;
    $('#dev-suspend').disabled = data.status === 'suspended';
    $('#dev-restore').disabled = data.status !== 'suspended';
  } catch (err) { toast(t('dev.consoleError', { error: err.message })); }
}
$('#dev-refresh').addEventListener('click', renderDeveloperDashboard);
$('#dev-renew-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const data = await api('/api/developer/subscription/renew', { method: 'POST', body: JSON.stringify({ paymentReference: $('#dev-payment-ref').value.trim() }) });
    $('#dev-payment-ref').value = '';
    me.subscriptionStatus = data.status;
    renderDeveloperDashboard();
    toast(t('dev.renewed'));
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
});
$('#dev-suspend').addEventListener('click', async () => {
  const reason = prompt(t('dev.suspendPrompt'));
  if (!reason?.trim()) return;
  try { await api('/api/developer/subscription/suspend', { method: 'POST', body: JSON.stringify({ reason }) }); renderDeveloperDashboard(); toast(t('dev.suspended')); }
  catch (err) { toast(t('err.prefix', { message: err.message })); }
});
$('#dev-restore').addEventListener('click', async () => {
  try { await api('/api/developer/subscription/restore', { method: 'POST', body: '{}' }); renderDeveloperDashboard(); toast(t('dev.restored')); }
  catch (err) { toast(t('err.prefix', { message: err.message })); }
});

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
    if (me.role !== 'developer' && ['trial', 'active'].includes(me.subscriptionStatus || 'trial')) {
      await refreshAll();
      await ensureShift();
      await syncQueue();
    }
  } catch (e2) {
    if (!reportApiProblem(e2)) {
      err.textContent = t('err.prefix', { message: e2.message });
      err.hidden = false;
    }
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
  } catch { /* keep defaults */ }
}

// ---------- Tabs ----------
// View renderers are async and may hit an expired session; never let a rejected
// promise bubble up as an unhandled error in the console.
function safeRender(fn) {
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') {
      result.catch(err => { if (err?.message && !document.querySelector('#login-screen:not([hidden])')) toast(t('err.prefix', { message: err.message })); });
    }
  } catch (err) {
    toast(t('err.prefix', { message: err.message }));
  }
}
$$('.tab').forEach(btn => btn.addEventListener('click', () => {
  $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + btn.dataset.view));
  if (btn.dataset.view === 'inventory') safeRender(renderInventory);
  if (btn.dataset.view === 'sales') safeRender(renderSales);
  if (btn.dataset.view === 'customers') safeRender(renderCustomers);
  if (btn.dataset.view === 'settings') safeRender(renderSettings);
  if (btn.dataset.view === 'subscription') safeRender(renderSubscriptionStatus);
  if (btn.dataset.view === 'developer') safeRender(renderDeveloperDashboard);
  if (btn.dataset.view === 'audit') safeRender(renderAudit);
  if (btn.dataset.view === 'purchases') safeRender(renderPurchases);
  if (btn.dataset.view === 'stocktake') safeRender(renderStocktake);
}));

// ---------- Shifts ----------
function renderShiftBadge() {
  const badge = $('#shift-badge');
  if (shift) {
    badge.textContent = t('top.shiftBadge', { id: shift.id, register: shift.register });
    badge.classList.add('open');
  } else {
    badge.textContent = t('top.noShiftBadge');
    badge.classList.remove('open');
  }
}
async function refreshShift() {
  try { shift = (await api('/api/shifts/current')).shift; } catch { shift = null; }
  renderShiftBadge();
}

async function ensureShift() {
  await refreshShift();
  if (!shift) openShiftModal('open');
}

function syncShiftModalCurrency() {
  $('#shift-float-label').textContent = t('shift.openingFloat', { currency: settings.currency });
  $('#shift-counted-label').textContent = t('shift.counted', { currency: settings.currency });
  $('#expected-cash').textContent = money(0);
  $('#variance').textContent = money(0);
}
function openShiftModal(mode) {
  $('#shift-modal-title').textContent = mode === 'open' ? t('shift.openTitle') : t('shift.closeTitle');
  $('#shift-open-fields').hidden = mode !== 'open';
  $('#shift-close-fields').hidden = mode !== 'close';
  $('#shift-confirm').textContent = mode === 'open' ? t('shift.openBtn') : t('shift.closeBtn');
  $('#shift-confirm').dataset.mode = mode;
  syncShiftModalCurrency();
  if (mode === 'close' && shift) {
    // Expected cash is computed server-side on close; show estimate from sales
    $('#expected-cash').textContent = '—';
    $('#closing-amount').value = '';
    $('#variance').textContent = money(0);
  }
  $('#shift-modal').hidden = false;
}

$('#shift-badge').addEventListener('click', () => openShiftModal(shift ? 'close' : 'open'));
$('#shift-confirm').addEventListener('click', async () => {
  const mode = $('#shift-confirm').dataset.mode;
  try {
    if (mode === 'open') {
      shift = await api('/api/shifts/open', { method: 'POST', body: JSON.stringify({ openingFloat: parseFloat($('#opening-float').value) || 0 }) });
      toast(t('shift.opened', { id: shift.id }));
      notifyUser(t('notify.shiftOpened'), t('shift.openedNote', { register: shift.register }), { level: 'success', key: `shift-open-${shift.id}` });
    } else {
      const result = await api('/api/shifts/close', { method: 'POST', body: JSON.stringify({ closingAmount: parseFloat($('#closing-amount').value) || 0 }) });
      const closedId = shift?.id;
      const closedRegister = shift?.register || terminalRegister();
      shift = null;
      toast(t('shift.closed', { variance: money(result.variance) }));
      notifyUser(t('notify.shiftClosed'), t('shift.closedNote', { register: closedRegister, variance: money(result.variance) }), { level: 'warning', key: `shift-close-${closedId}` });
    }
    $('#shift-modal').hidden = true;
    await refreshShift();
  } catch (e) { toast(t('err.prefix', { message: e.message })); }
});

// ---------- POS ----------
function categories() { return ['All', ...new Set(products.map(p => p.category))]; }
const categoryLabel = c => I18N.categoryLabel(c);

function renderCategories() {
  $('#categories').innerHTML = categories().map(c =>
    `<button class="cat-btn ${c === activeCategory ? 'active' : ''}" data-cat="${esc(c)}" dir="auto">${esc(categoryLabel(c))}</button>`).join('');
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
    return `<div class="product ${out ? 'out' : ''}" data-id="${p.id}" title="${esc(out ? t('pos.outOfStock') : t('pos.addToCart'))}">
      <span class="emoji">${p.emoji || '📦'}</span>
      <div class="name" dir="auto">${esc(p.name)}</div>
      <div class="price">${money(p.price)}<small style="font-size:11px;color:var(--muted);font-weight:400"> / ${esc(unitLabel(p.unit))}</small></div>
      <div class="stock ${low ? 'low' : ''}">${out ? esc(t('pos.outOfStock')) : esc(t('pos.inStock', { n: p.stock }))}</div>
    </div>`;
  }).join('');
  $$('.product').forEach(el => el.addEventListener('click', () => addToCart(+el.dataset.id)));
}

function addToCart(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const qty = cart[id] || 0;
  if (qty >= p.stock) { toast(t('pos.onlyInStock', { n: p.stock, name: p.name })); return; }
  cart[id] = qty + 1;
  renderCart();
}

function setQty(id, qty) {
  const p = products.find(x => x.id === id);
  if (qty <= 0) delete cart[id];
  else if (qty > p.stock) { toast(t('pos.onlyStock', { n: p.stock })); return; }
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
      <div class="info"><div class="n" dir="auto">${esc(p.name)}</div><div class="p">${money(p.price)} / ${esc(unitLabel(p.unit))}</div></div>
      <div class="qty"><button data-act="dec" data-id="${p.id}">−</button><span>${qty}</span><button data-act="inc" data-id="${p.id}">+</button></div>
      <div class="line-total">${money(p.price * qty)}</div>
      <button class="remove" data-act="del" data-id="${p.id}" title="${esc(t('cart.remove'))}">🗑</button>
    </div>`).join('');
  $$('#cart-items [data-act]').forEach(b => b.addEventListener('click', () => {
    const id = +b.dataset.id;
    if (b.dataset.act === 'inc') setQty(id, (cart[id] || 0) + 1);
    if (b.dataset.act === 'dec') setQty(id, (cart[id] || 0) - 1);
    if (b.dataset.act === 'del') setQty(id, 0);
  }));
  const t2 = totals();
  $('#sum-subtotal').textContent = money(t2.subtotal);
  $('#sum-discount').textContent = '−' + money(t2.discount);
  $('#sum-points').textContent = '−' + money(t2.pointsDiscount);
  $('#sum-tax').textContent = money(t2.tax);
  $('#sum-total').textContent = money(t2.total);
  $('#checkout-btn').disabled = entries.length === 0;
  const cust = selectedCustomer();
  $('#points-row').hidden = !cust;
  if (cust) {
    const earn = Math.floor(t2.total * (parseFloat(settings.points_per_dollar) || 0));
    $('#points-info').textContent = t('cart.pointsInfo', { points: cust.points, earn });
    $('#redeem-points').disabled = cust.points <= 0;
  }
}

function renderCustomerSelect() {
  const current = $('#customer-select').value;
  $('#customer-select').innerHTML = `<option value="">${esc(t('cart.walkIn'))}</option>` +
    customers.map(c => `<option value="${c.id}">${esc(t('cart.option', { name: c.name, points: c.points }))}</option>`).join('');
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
  if (p) { addToCart(p.id); toast(t('pos.added', { name: p.name })); }
  else toast(t('pos.noBarcode', { code }));
});

// ---------- Checkout ----------
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { const el = $(id); if (el) el.hidden = true; }
$$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('.modal-backdrop').hidden = true));
$$('.modal-backdrop').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.hidden = true; }));

$('#checkout-btn').addEventListener('click', async () => {
  if (!shift) { toast(t('shift.openFirst')); openShiftModal('open'); return; }
  payMethod = 'cash';
  $$('.pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'cash'));
  $('#cash-fields').style.display = '';
  $('#tendered').value = '';
  $('#change').textContent = money(0);
  $('#checkout-error').hidden = true;
  $('#due').textContent = money(totals().total);
  openModal('#checkout-modal');
  setTimeout(() => $('#tendered').focus(), 50);
});

$$('.pay-btn').forEach(b => b.addEventListener('click', () => {
  payMethod = 'cash';
  b.classList.add('active');
  $('#cash-fields').style.display = '';
}));

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
  const tot = totals();
  const err = $('#checkout-error');
  err.hidden = true;
  const cust = selectedCustomer();
  const payload = {
    items: cartEntries().map(e => ({ id: e.product.id, qty: e.qty })),
    discountPct: tot.discountPct,
    payment: 'cash',
    tendered: parseFloat($('#tendered').value) || 0,
    customerId: cust?.id ?? null,
    redeemPoints: tot.redeem,
    idempotencyKey: (crypto.randomUUID ? crypto.randomUUID() : `pos-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  };
  if (payMethod === 'cash' && payload.tendered < tot.total) {
    err.textContent = t('checkout.lessThanTotal', { total: money(tot.total) });
    err.hidden = false;
    return;
  }
  try {
    lastSale = await api('/api/sales', { method: 'POST', body: JSON.stringify(payload) });
    notifyUser(t('checkout.saleDone'), t('checkout.saleDoneNote', { id: lastSale.id, total: money(lastSale.total) }), { level: 'success', key: `sale-${lastSale.id}` });
    afterSale();
  } catch (e) {
    if (e.offline) {
      queueSale(payload);
      toast(t('checkout.offlineQueued'));
      notifyUser(t('checkout.queuedTitle'), t('checkout.queuedNote'), { level: 'warning', key: `queued-${payload.idempotencyKey}` });
      cart = {}; $('#discount').value = 0; $('#redeem-points').checked = false;
      renderCart();
      $('#checkout-modal').hidden = true;
      return;
    }
    err.textContent = t('err.prefix', { message: e.message });
    err.hidden = false;
  }
});

async function afterSale() {
  products = await api('/api/products');
  scanStockAlerts(products);
  customers = await api('/api/customers');
  cart = {};
  $('#discount').value = 0;
  $('#redeem-points').checked = false;
  renderCategories(); renderGrid(); renderCart(); renderCustomerSelect();
  $('#checkout-modal').hidden = true;
  showReceipt(lastSale);
}

function showReceipt(sale) {
  const receiptModal = $('#receipt-modal .modal');
  if (receiptModal) receiptModal.dir = I18N.dir();
  const rows = sale.items.map(i =>
    `<div class="r-row"><span dir="auto">${i.emoji} ${esc(i.name)} <bdi>×${i.qty}</bdi></span><span class="amount">${money(i.line_total)}</span></div>`).join('');
  const taxRows = sale.items.length && sale.items.every(i => i.tax_rate != null && i.tax != null)
    ? Object.entries(sale.items.reduce((groups, i) => {
        const key = Number(i.tax_rate);
        groups[key] = (groups[key] || 0) + Number(i.tax);
        return groups;
      }, {})).map(([rate, amount]) => `<div class="r-row"><span>${esc(t('receipt.taxRate', { rate: (Number(rate) * 100).toFixed(0) }))}</span><span class="amount">${money(amount)}</span></div>`).join('')
    : `<div class="r-row"><span>${esc(t('receipt.tax'))}</span><span class="amount">${money(sale.tax)}</span></div>`;
  $('#receipt-body').innerHTML = `
    <div class="r-head"><h2>🛒 ${esc(settings.store_name)}</h2><div>${esc(terminalRegister())}</div>
    ${settings.store_address ? `<div>${esc(settings.store_address)}</div>` : ''}
    ${settings.store_phone ? `<div>${esc(settings.store_phone)}</div>` : ''}
    ${settings.vat_number ? `<div>${esc(t('receipt.vat', { vat: settings.vat_number }))}</div>` : ''}
    <div>${esc(t('receipt.saleNo', { id: sale.id, date: fmtDate(sale.date) }))}</div>
    <div>${esc(t('receipt.cashier', { name: me.name || me.username }))}</div></div>
    ${rows}
    <div class="r-row"><span>${esc(t('receipt.subtotal'))}</span><span class="amount">${money(sale.subtotal)}</span></div>
    ${sale.discount ? `<div class="r-row"><span>${esc(t('receipt.discount', { pct: sale.discount_pct }))}</span><span class="amount">−${money(sale.discount)}</span></div>` : ''}
    ${sale.points_redeemed ? `<div class="r-row"><span>${esc(t('receipt.pointsRedeemed', { points: sale.points_redeemed }))}</span><span class="amount">−${money(sale.points_redeemed * pointsValue())}</span></div>` : ''}
    ${taxRows}
    <div class="r-row r-total"><span>${esc(t('receipt.totalLabel'))}</span><span class="amount">${money(sale.total)}</span></div>
    <div class="r-row"><span>${esc(t('receipt.payment'))}</span><span>${sale.payment === 'card' ? esc(t('sales.payCard')) : esc(t('sales.payCash'))}</span></div>
    ${sale.tendered != null ? `<div class="r-row"><span>${esc(t('receipt.tendered'))}</span><span class="amount">${money(sale.tendered)}</span></div><div class="r-row"><span>${esc(t('receipt.change'))}</span><span class="amount">${money(sale.change)}</span></div>` : ''}
    ${sale.points_earned ? `<div class="r-row"><span>${esc(t('receipt.pointsEarned'))}</span><span>+${sale.points_earned}</span></div>` : ''}
    <div class="r-foot">${esc(settings.receipt_footer || t('receipt.footerDefault'))}</div>`;
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
  badge.textContent = t('queue.badge', { n });
  const issues = getQueue().map(x => x.lastError).filter(Boolean);
  badge.title = issues.length ? t('queue.syncError', { error: issues[0] }) : t('queue.syncTitle');
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
    scanStockAlerts(products);
    renderGrid();
    toast(t('queue.synced', { n: q.length - remaining.length }));
  }
  if (remaining.length) {
    toast(t('queue.review', { n: remaining.length }));
    notifyUser(t('notify.queueAttention'), t('notify.queueAttentionNote', { n: remaining.length }), { level: 'critical', key: 'queue-sync-failed' });
  }
}
window.addEventListener('offline', () => notifyUser(t('notify.connectionLost'), t('notify.connectionLostNote'), { level: 'critical', key: 'network-offline' }));
window.addEventListener('online', () => {
  notifyUser(t('notify.connectionBack'), t('notify.connectionBackNote'), { level: 'success', key: `network-online-${Math.floor(Date.now() / 60000)}` });
  syncQueue();
});
setInterval(async () => {
  if (!me || !navigator.onLine) return;
  try {
    products = await api('/api/products');
    scanStockAlerts(products);
    if ($('#view-pos').classList.contains('active')) renderGrid();
    if ($('#view-inventory').classList.contains('active')) renderInventory();
  } catch { /* next poll will retry */ }
}, 60000);

// ---------- Inventory ----------
function renderInventory() {
  $('#inv-count').textContent = t('inv.count', { n: products.length });
  const admin = me.role === 'admin';
  $('#inv-body').innerHTML = products.map(p => {
    const badge = p.stock <= 0 ? `<span class="stock-badge out">${esc(t('inv.out'))}</span>` : p.stock <= +settings.low_stock_threshold ? `<span class="stock-badge low">${p.stock}</span>` : `<span class="stock-badge">${p.stock}</span>`;
    return `<tr>
      <td style="font-size:22px">${p.emoji || '📦'}</td>
      <td><strong dir="auto">${esc(p.name)}</strong></td><td dir="auto">${esc(p.category)}</td><td>${esc(p.barcode)}</td>
      <td>${money(p.price)}</td><td>${esc(unitLabel(p.unit))}</td><td>${badge}</td>
      ${admin ? `<td><button class="icon-btn" data-edit="${p.id}" title="${esc(t('inv.edit'))}">✏️</button><button class="icon-btn" data-del="${p.id}" title="${esc(t('inv.delete'))}">🗑</button></td>` : '<td></td>'}</tr>`;
  }).join('');
  $$('#inv-body [data-edit]').forEach(b => b.addEventListener('click', () => openProductForm(products.find(p => p.id === +b.dataset.edit))));
  $$('#inv-body [data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(t('inv.removeConfirm'))) return;
    await api(`/api/products/${b.dataset.del}`, { method: 'DELETE' });
    products = await api('/api/products');
    scanStockAlerts(products);
    renderCategories(); renderGrid(); renderInventory();
    toast(t('inv.removed'));
  }));
}

// ---------- Suppliers & purchases ----------
let supplierRows = [];
let purchaseRows = [];

const purchasePaymentLabel = status => t(`pur.pay.${status}`);
const paymentBadgeClass = status => ({ paid: '', partial: 'low', unpaid: 'out' })[status] || '';
const paymentStatusFor = (total, paid) => (total === 0 || paid >= total - 0.009 ? 'paid' : paid > 0 ? 'partial' : 'unpaid');

async function renderPurchases() {
  if (me?.role !== 'admin') return;
  const [suppliers, purchases] = await Promise.all([api('/api/suppliers'), api('/api/purchases')]);
  supplierRows = suppliers;
  purchaseRows = purchases;

  $('#suppliers-body').innerHTML = suppliers.length ? suppliers.map(s => `<tr class="${s.active ? '' : 'row-muted'}">
    <td dir="auto"><strong>${esc(s.name)}</strong>${s.active ? '' : ` <span class="stock-badge out">${esc(t('sup.inactive'))}</span>`}</td>
    <td dir="ltr">${esc(s.phone || '—')}</td>
    <td><bdi>${s.purchase_count}</bdi></td>
    <td>${money(s.balance)}</td>
    <td><button class="icon-btn" data-sup-statement="${s.id}" title="${esc(t('stm.open'))}">📄</button><button class="icon-btn" data-sup-edit="${s.id}" title="${esc(t('sup.edit'))}">✏️</button>${s.active ? `<button class="icon-btn" data-sup-off="${s.id}" title="${esc(t('sup.deactivate'))}">🚫</button>` : ''}</td>
  </tr>`).join('') : `<tr><td colspan="5" class="muted">${esc(t('sup.empty'))}</td></tr>`;

  const posted = purchases.filter(p => p.status === 'posted');
  const totalSpent = posted.reduce((sum, p) => sum + p.total, 0);
  const outstanding = posted.reduce((sum, p) => sum + Math.max(0, p.total - p.paid), 0);
  $('#purchase-stats').innerHTML = `
    <div class="stat"><span class="muted small">${esc(t('pur.statInvoices'))}</span><strong><bdi>${posted.length}</bdi></strong></div>
    <div class="stat"><span class="muted small">${esc(t('pur.statSpent'))}</span><strong>${money(totalSpent)}</strong></div>
    <div class="stat"><span class="muted small">${esc(t('pur.statDue'))}</span><strong>${money(outstanding)}</strong></div>`;

  $('#purchases-body').innerHTML = purchases.length ? purchases.map(p => `<tr class="${p.status === 'reversed' ? 'row-muted' : ''}">
    <td class="nowrap"><bdi>${esc(fmtDateTime(p.date))}</bdi></td>
    <td dir="auto">${esc(p.supplier_name || '—')}</td>
    <td dir="auto">${esc(p.invoice_no || '—')}</td>
    <td><bdi>${p.item_count}</bdi></td>
    <td>${money(p.total)}</td>
    <td>${money(p.paid)}</td>
    <td><span class="status-badge ${p.status === 'reversed' ? 'voided' : paymentBadgeClass(p.payment_status)}">${esc(p.status === 'reversed' ? t('pur.status.reversed') : purchasePaymentLabel(p.payment_status))}</span></td>
    <td><button class="icon-btn" data-pur-view="${p.id}" title="${esc(t('pur.detailTitle'))}">👁</button></td>
  </tr>`).join('') : `<tr><td colspan="8" class="muted">${esc(t('pur.empty'))}</td></tr>`;

  $$('#suppliers-body [data-sup-edit]').forEach(b => b.addEventListener('click', () => openSupplierModal(supplierRows.find(x => x.id === +b.dataset.supEdit))));
  $$('#suppliers-body [data-sup-statement]').forEach(b => b.addEventListener('click', () => openSupplierStatement(+b.dataset.supStatement)));
  $$('#suppliers-body [data-sup-off]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(t('sup.deactivateConfirm'))) return;
    try {
      await api(`/api/suppliers/${b.dataset.supOff}`, { method: 'DELETE' });
      toast(t('sup.deactivated'));
      await renderPurchases();
    } catch (err) { toast(t('err.prefix', { message: err.message })); }
  }));
  $$('#purchases-body [data-pur-view]').forEach(b => b.addEventListener('click', () => openPurchaseDetail(+b.dataset.purView)));
}

function openSupplierModal(supplier = null) {
  $('#supplier-form-title').textContent = supplier ? t('sup.edit') : t('sup.add');
  $('#sup-id').value = supplier ? supplier.id : '';
  $('#sup-name').value = supplier ? supplier.name : '';
  $('#sup-phone').value = supplier ? (supplier.phone || '') : '';
  $('#sup-email').value = supplier ? supplier.email : '';
  $('#sup-note').value = supplier ? supplier.note : '';
  openModal('#supplier-modal');
  setTimeout(() => $('#sup-name').focus(), 50);
}

$('#add-supplier-btn').addEventListener('click', () => openSupplierModal());
$('#supplier-form').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('#sup-id').value;
  const body = { name: $('#sup-name').value.trim(), phone: $('#sup-phone').value.trim(), email: $('#sup-email').value.trim(), note: $('#sup-note').value.trim() };
  try {
    if (id) await api(`/api/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/suppliers', { method: 'POST', body: JSON.stringify(body) });
    closeModal('#supplier-modal');
    toast(t('sup.saved'));
    await renderPurchases();
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
});

// ---------- Supplier statement ----------
let statementSupplierId = null;
let statementData = null;

async function openSupplierStatement(supplierId) {
  statementSupplierId = supplierId;
  $('#stm-days').value = '90';
  openModal('#statement-modal');
  await loadSupplierStatement();
}

async function loadSupplierStatement() {
  if (!statementSupplierId) return;
  const days = Number($('#stm-days').value) || 90;
  const data = await api(`/api/suppliers/${statementSupplierId}/statement?days=${days}`);
  statementData = data;
  $('#stm-title').textContent = t('stm.titleNamed', { name: data.supplier.name });
  $('#stm-stats').innerHTML = `
    <div class="stat"><span class="muted small">${esc(t('stm.invoices'))}</span><strong><bdi>${data.totals.invoices}</bdi></strong></div>
    <div class="stat"><span class="muted small">${esc(t('stm.total'))}</span><strong>${money(data.totals.total)}</strong></div>
    <div class="stat"><span class="muted small">${esc(t('stm.paid'))}</span><strong>${money(data.totals.paid)}</strong></div>
    <div class="stat"><span class="muted small">${esc(t('stm.outstanding'))}</span><strong class="${data.totals.outstanding > 0 ? 'negative' : ''}">${money(data.totals.outstanding)}</strong></div>`;
  const contact = [data.supplier.phone, data.supplier.email].filter(Boolean).join(' · ');
  $('#stm-note').textContent = [
    contact,
    t('stm.lifetime', { total: money(data.lifetime.total), due: money(data.lifetime.outstanding) }),
    t('stm.reversedNote'),
  ].filter(Boolean).join(' — ');
  $('#stm-body').innerHTML = data.purchases.length ? data.purchases.map(row => {
    const due = Math.max(0, row.total - row.paid);
    return `<tr class="${row.status === 'reversed' ? 'row-muted' : ''}">
      <td class="nowrap"><bdi>${esc(fmtDateTime(row.date))}</bdi></td>
      <td dir="auto">${esc(row.invoice_no || `#${row.id}`)}</td>
      <td>${money(row.total)}</td>
      <td>${money(row.paid)}</td>
      <td class="${due > 0 && row.status === 'posted' ? 'negative' : ''}">${money(due)}</td>
      <td><span class="status-badge ${row.status === 'reversed' ? 'voided' : paymentBadgeClass(paymentStatusFor(row.total, row.paid))}">${esc(row.status === 'reversed' ? t('pur.status.reversed') : purchasePaymentLabel(paymentStatusFor(row.total, row.paid)))}</span></td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" class="muted">${esc(t('stm.noInvoices'))}</td></tr>`;
}

$('#stm-days').addEventListener('change', () => safeRender(loadSupplierStatement));

$('#stm-export').addEventListener('click', () => {
  const data = statementData;
  if (!data) return;
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [
    [t('stm.title'), data.supplier.name],
    [t('pur.colSupplier'), data.supplier.name],
    [t('stm.period'), `${data.window.from} → ${data.window.to}`],
    [],
    [t('pur.colDate'), t('pur.colInvoice'), t('pur.colTotal'), t('pur.colPaid'), t('stm.due'), t('pur.colStatus')],
    ...data.purchases.map(row => [
      row.date, row.invoice_no || `#${row.id}`, row.total, row.paid,
      Math.max(0, row.total - row.paid),
      row.status === 'reversed' ? t('pur.status.reversed') : purchasePaymentLabel(paymentStatusFor(row.total, row.paid)),
    ]),
    [],
    [t('stm.total'), data.totals.total],
    [t('stm.paid'), data.totals.paid],
    [t('stm.outstanding'), data.totals.outstanding],
  ];
  const csv = '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `supplier-statement-${data.supplier.id}.csv`;
  a.click();
});

function purchaseProductOptions(selected) {
  return `<option value="">${esc(t('pur.pickProduct'))}</option>` +
    products.map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)} · ${esc(unitLabel(p.unit))}</option>`).join('');
}

function addPurchaseLine(preset = {}) {
  const row = document.createElement('div');
  row.className = 'purchase-line';
  row.innerHTML = `
    <select class="pl-product">${purchaseProductOptions(preset.productId)}</select>
    <input class="pl-qty" type="number" min="1" step="1" value="${preset.qty || 1}" aria-label="${esc(t('pur.qty'))}" />
    <input class="pl-cost" type="number" min="0" step="0.01" value="${preset.unitCost ?? ''}" placeholder="${esc(t('pur.unitCost'))}" aria-label="${esc(t('pur.unitCost'))}" />
    <button type="button" class="icon-btn pl-remove" title="${esc(t('pur.removeLine'))}">🗑</button>`;
  $('#pur-lines').appendChild(row);
  const select = row.querySelector('.pl-product');
  const qty = row.querySelector('.pl-qty');
  const cost = row.querySelector('.pl-cost');
  select.addEventListener('change', () => {
    const product = products.find(p => p.id === +select.value);
    if (product && product.cost_price != null && !cost.value) cost.value = product.cost_price;
    if (!select.value) cost.value = '';
    updatePurchaseTotals();
  });
  [qty, cost].forEach(input => input.addEventListener('input', updatePurchaseTotals));
  row.querySelector('.pl-remove').addEventListener('click', () => {
    if ($$('#pur-lines .purchase-line').length === 1) return;
    row.remove();
    updatePurchaseTotals();
  });
  updatePurchaseTotals();
}

function purchaseLines() {
  return $$('#pur-lines .purchase-line').map(row => ({
    productId: +row.querySelector('.pl-product').value,
    qty: parseInt(row.querySelector('.pl-qty').value, 10) || 0,
    unitCost: parseFloat(row.querySelector('.pl-cost').value) || 0,
  }));
}

function updatePurchaseTotals() {
  const lines = purchaseLines().filter(l => l.productId);
  const subtotal = lines.reduce((sum, l) => sum + l.qty * l.unitCost, 0);
  const rate = Math.min(1, Math.max(0, parseFloat($('#pur-tax').value) || 0));
  const tax = subtotal * rate;
  const total = subtotal + tax;
  const paid = Math.min(total, Math.max(0, parseFloat($('#pur-paid').value) || 0));
  const status = total === 0 || paid >= total - 0.009 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  $('#pur-totals').innerHTML = `
    <span>${esc(t('cart.subtotal'))}: <strong>${money(subtotal)}</strong></span>
    <span>${esc(t('cart.tax'))}: <strong>${money(tax)}</strong></span>
    <span>${esc(t('cart.total'))}: <strong>${money(total)}</strong></span>
    <span class="status-badge ${paymentBadgeClass(status)}">${esc(purchasePaymentLabel(status))}</span>`;
}

function openPurchaseModal() {
  const active = supplierRows.filter(s => s.active);
  $('#pur-supplier').innerHTML = `<option value="">${esc(t('pur.noSupplier'))}</option>` +
    active.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('#pur-invoice').value = '';
  $('#pur-paid').value = '0';
  $('#pur-tax').value = taxRate();
  $('#pur-note').value = '';
  $('#pur-lines').innerHTML = '';
  addPurchaseLine();
  addPurchaseLine();
  openModal('#purchase-modal');
  setTimeout(() => $('#pur-invoice').focus(), 50);
  updatePurchaseTotals();
}

$('#add-purchase-btn').addEventListener('click', async () => {
  try {
    if (!supplierRows.length) supplierRows = await api('/api/suppliers');
    openPurchaseModal();
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
});
$('#pur-add-line').addEventListener('click', () => addPurchaseLine());
$('#pur-paid').addEventListener('input', updatePurchaseTotals);
$('#pur-tax').addEventListener('input', updatePurchaseTotals);

$('#purchase-form').addEventListener('submit', async e => {
  e.preventDefault();
  const items = purchaseLines().filter(line => line.productId && line.qty > 0);
  if (!items.length) { toast(t('pur.needLines')); return; }
  try {
    const created = await api('/api/purchases', {
      method: 'POST',
      body: JSON.stringify({
        supplierId: $('#pur-supplier').value || null,
        invoiceNo: $('#pur-invoice').value.trim(),
        items,
        paid: parseFloat($('#pur-paid').value) || 0,
        taxRate: $('#pur-tax').value === '' ? undefined : parseFloat($('#pur-tax').value),
        note: $('#pur-note').value.trim(),
      }),
    });
    closeModal('#purchase-modal');
    products = await api('/api/products');
    scanStockAlerts(products);
    renderCategories(); renderGrid(); renderInventory();
    toast(t('pur.created', { id: created.id, total: money(created.total) }));
    await renderPurchases();
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
});

async function openPurchaseDetail(id) {
  try {
    const purchase = await api(`/api/purchases/${id}`);
    $('#pur-detail-title').textContent = t('pur.detailTitleId', { id: purchase.id, invoice: purchase.invoice_no || '—' });
    $('#pur-detail-body').innerHTML = `
      <p class="muted small" dir="auto">${esc(purchase.supplier?.name || t('pur.noSupplier'))} · <bdi>${esc(fmtDateTime(purchase.date))}</bdi> · ${esc(t(`pur.pay.${purchase.payment_status}`))}</p>
      <div class="table-wrap"><table>
        <thead><tr><th data-i18n="col.product">${esc(t('col.product'))}</th><th>${esc(t('pur.qty'))}</th><th>${esc(t('pur.unitCost'))}</th><th>${esc(t('cart.total'))}</th></tr></thead>
        <tbody>${purchase.items.map(item => `<tr><td dir="auto">${esc(item.name)}</td><td><bdi>${item.qty}</bdi></td><td>${money(item.unit_cost)}</td><td>${money(item.line_total)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="purchase-totals">
        <span>${esc(t('cart.subtotal'))}: <strong>${money(purchase.subtotal)}</strong></span>
        <span>${esc(t('cart.tax'))}: <strong>${money(purchase.tax)}</strong></span>
        <span>${esc(t('cart.total'))}: <strong>${money(purchase.total)}</strong></span>
        <span>${esc(t('pur.colPaid'))}: <strong>${money(purchase.paid)}</strong></span>
      </div>`;
    $('#pur-reverse').hidden = purchase.status !== 'posted';
    $('#pur-reverse').onclick = async () => {
      if (!confirm(t('pur.reverseConfirm', { id: purchase.id }))) return;
      try {
        await api(`/api/purchases/${purchase.id}/reverse`, { method: 'POST', body: '{}' });
        closeModal('#purchase-detail-modal');
        products = await api('/api/products');
        scanStockAlerts(products);
        renderCategories(); renderGrid(); renderInventory();
        toast(t('pur.reversed'));
        await renderPurchases();
      } catch (err) { toast(t('err.prefix', { message: err.message })); }
    };
    openModal('#purchase-detail-modal');
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
}

// ---------- Stocktake ----------
let stocktake = null;

function stocktakeCountedValue(item) {
  return item.counted === null || item.counted === undefined ? '' : String(item.counted);
}

function collectStocktakeCounts() {
  if (!stocktake) return;
  $$('#stk-body .stk-counted').forEach(input => {
    const productId = +input.dataset.pid;
    const item = stocktake.items.find(x => x.product_id === productId);
    if (!item) return;
    const raw = input.value.trim();
    item.counted = raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0);
  });
}

function renderStocktakeRows() {
  if (!stocktake) return;
  const search = ($('#stk-search').value || '').trim().toLowerCase();
  const onlyDiff = $('#stk-only-diff').checked;
  const rows = stocktake.items.filter(item => {
    if (search && !`${item.name} ${item.category || ''}`.toLowerCase().includes(search)) return false;
    if (onlyDiff && (item.counted === null || item.counted === undefined || item.counted === item.expected)) return false;
    return true;
  });
  $('#stk-body').innerHTML = rows.map(item => {
    const counted = item.counted;
    const diff = counted === null || counted === undefined ? null : counted - item.expected;
    const diffClass = diff === null || diff === 0 ? '' : diff > 0 ? 'stock-badge' : 'stock-badge out';
    return `<tr>
      <td dir="auto">${item.emoji || '📦'} <strong>${esc(item.name)}</strong> <span class="muted small">${esc(categoryLabel(item.category || ''))}</span></td>
      <td><bdi>${item.expected}</bdi></td>
      <td><input class="stk-counted" type="number" min="0" step="1" inputmode="numeric" data-pid="${item.product_id}" value="${stocktakeCountedValue(item)}" /></td>
      <td>${diff === null ? '<span class="muted">—</span>' : `<span class="${diffClass}"><bdi>${diff > 0 ? '+' : ''}${diff}</bdi></span>`}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4" class="muted">${esc(t('stk.noRows'))}</td></tr>`;
  $$('#stk-body .stk-counted').forEach(input => input.addEventListener('input', () => {
    const item = stocktake.items.find(x => x.product_id === +input.dataset.pid);
    if (!item) return;
    const raw = input.value.trim();
    item.counted = raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0);
    const diff = item.counted === null ? null : item.counted - item.expected;
    input.closest('tr').children[3].innerHTML = diff === null
      ? '<span class="muted">—</span>'
      : `<span class="${diff === 0 ? '' : diff > 0 ? 'stock-badge' : 'stock-badge out'}"><bdi>${diff > 0 ? '+' : ''}${diff}</bdi></span>`;
    updateStocktakeSummary();
  }));
  updateStocktakeSummary();
}

function updateStocktakeSummary() {
  if (!stocktake) return;
  collectStocktakeCounts();
  const counted = stocktake.items.filter(i => i.counted !== null && i.counted !== undefined);
  const diffs = counted.filter(i => i.counted !== i.expected);
  const net = diffs.reduce((sum, i) => sum + (i.counted - i.expected), 0);
  $('#stk-summary').textContent = t('stk.summary', { counted: counted.length, total: stocktake.items.length, diffs: diffs.length, net: net > 0 ? `+${net}` : net });
}

function renderStocktakeActive() {
  const active = Boolean(stocktake && stocktake.status === 'draft');
  $('#stk-active').hidden = !active;
  $('#stk-apply').hidden = !active;
  $('#stk-cancel').hidden = !active;
  $('#stk-start').hidden = active;
  if (!active) return;
  $('#stk-status').textContent = t('stk.draftStatus', { id: stocktake.id });
  renderStocktakeRows();
}

async function renderStocktake() {
  if (me?.role !== 'admin') return;
  // Keep unsaved counts before refreshing the list.
  if (stocktake && stocktake.status === 'draft') collectStocktakeCounts();
  const list = await api('/api/stocktakes');
  $('#stk-history').innerHTML = list.length ? list.map(s => `<tr>
    <td class="nowrap"><bdi>${esc(fmtDateTime(s.date))}</bdi></td>
    <td><bdi>${s.item_count}</bdi></td>
    <td><bdi>${s.counted_count}</bdi></td>
    <td><bdi>${s.diff_count}</bdi></td>
    <td><bdi>${s.net_diff > 0 ? '+' : ''}${s.net_diff}</bdi></td>
    <td><span class="status-badge ${s.status === 'draft' ? 'low' : s.status === 'applied' ? '' : 'voided'}">${esc(t(`stk.status.${s.status}`))}</span></td>
  </tr>`).join('') : `<tr><td colspan="6" class="muted">${esc(t('stk.noHistory'))}</td></tr>`;

  const draft = list.find(s => s.status === 'draft');
  stocktake = draft ? await api(`/api/stocktakes/${draft.id}`) : null;
  renderStocktakeActive();
  if (!draft) $('#stk-status').textContent = '';
}

$('#stk-start').addEventListener('click', async () => {
  try {
    await api('/api/stocktakes', { method: 'POST', body: JSON.stringify({}) });
    toast(t('stk.started'));
    await renderStocktake();
  } catch (err) {
    toast(t('err.prefix', { message: err.message }));
    await renderStocktake();
  }
});

$('#stk-save').addEventListener('click', async () => {
  if (!stocktake) return;
  collectStocktakeCounts();
  try {
    const payload = stocktake.items.map(item => ({ productId: item.product_id, counted: item.counted }));
    const result = await api(`/api/stocktakes/${stocktake.id}/items`, { method: 'PUT', body: JSON.stringify({ items: payload }) });
    toast(t('stk.saved', { n: result.saved }));
    renderStocktakeRows();
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
});

$('#stk-apply').addEventListener('click', async () => {
  if (!stocktake) return;
  collectStocktakeCounts();
  if (!confirm(t('stk.applyConfirm', { id: stocktake.id }))) return;
  try {
    await api(`/api/stocktakes/${stocktake.id}/items`, {
      method: 'PUT',
      body: JSON.stringify({ items: stocktake.items.map(item => ({ productId: item.product_id, counted: item.counted })) }),
    });
    const result = await api(`/api/stocktakes/${stocktake.id}/apply`, { method: 'POST', body: '{}' });
    products = await api('/api/products');
    scanStockAlerts(products);
    renderCategories(); renderGrid(); renderInventory();
    toast(t('stk.appliedToast', { n: result.counted, gains: result.gains, losses: result.losses }));
    await renderStocktake();
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
});

$('#stk-cancel').addEventListener('click', async () => {
  if (!stocktake || !confirm(t('stk.cancelConfirm'))) return;
  try {
    await api(`/api/stocktakes/${stocktake.id}/cancel`, { method: 'POST', body: '{}' });
    toast(t('stk.cancelled'));
    await renderStocktake();
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
});

$('#stk-search').addEventListener('input', () => { collectStocktakeCounts(); renderStocktakeRows(); });
$('#stk-only-diff').addEventListener('change', () => { collectStocktakeCounts(); renderStocktakeRows(); });

// ---------- Inventory import (Excel / CSV) ----------
let importPlan = null;
const IMPORT_FIELD_LABELS = { name: 'col.product', price: 'col.price', stock: 'col.stock', category: 'col.category', unit: 'col.unit', tax_rate: 'receipt.tax' };
const IMPORT_NOTES = {
  NAME_REQUIRED: 'imp.err.nameRequired', BAD_PRICE: 'imp.err.badPrice', BAD_STOCK: 'imp.err.badStock',
  BAD_TAX: 'imp.err.badTax', DUPLICATE_BARCODE: 'imp.err.duplicate', EXISTS_KEPT: 'imp.err.existsKept',
  NO_CHANGES: 'imp.err.noChanges',
};

function importStatusLabel(status) {
  const keys = { create: 'imp.status.create', update: 'imp.status.update', skip: 'imp.status.skip', error: 'imp.status.error' };
  return t(keys[status] || status);
}

function importNote(entry) {
  if (entry.message) return t(IMPORT_NOTES[entry.message] || 'imp.err.other');
  if (!entry.changes?.length) return '';
  return entry.changes
    .map(c => `${t(IMPORT_FIELD_LABELS[c.field] || 'imp.colNote')}: <bdi>${esc(c.from ?? '—')}</bdi> → <bdi>${esc(c.to ?? '—')}</bdi>`)
    .join(' · ');
}

function renderImportPreview(data) {
  const summary = data.summary;
  $('#import-preview').hidden = false;
  $('#import-summary').textContent = t('imp.summary', {
    create: summary.create, update: summary.update, skip: summary.skip, error: summary.error,
  });
  $('#import-body').innerHTML = data.entries.map(entry => `<tr class="import-row ${esc(entry.status)}">
    <td>${entry.line}</td>
    <td><span class="status-badge ${esc(entry.status)}">${esc(importStatusLabel(entry.status))}</span></td>
    <td dir="auto"><strong>${esc(entry.name || '—')}</strong></td>
    <td>${entry.price == null ? '—' : money(entry.price)}</td>
    <td dir="auto">${esc(unitLabel(entry.unit || 'each'))}</td>
    <td><bdi>${entry.stock ?? 0}</bdi></td>
    <td dir="ltr">${esc(entry.barcode || '—')}</td>
    <td class="small" dir="auto">${importNote(entry)}</td>
  </tr>`).join('');
  const actionable = summary.create + summary.update;
  const apply = $('#import-apply');
  apply.hidden = actionable === 0;
  apply.textContent = t('imp.applyCount', { n: actionable });
  $('#import-status').textContent = [data.truncated ? t('imp.truncated') : '', actionable === 0 ? t('imp.nothingToDo') : ''].filter(Boolean).join(' ');
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

$('#import-file').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  const status = $('#import-status');
  status.textContent = t('imp.parsing', { name: file.name });
  $('#import-apply').hidden = true;
  try {
    const contentBase64 = await fileToBase64(file);
    const payload = { filename: file.name, contentBase64, updateExisting: $('#import-update').checked };
    const data = await api('/api/products/import/preview', { method: 'POST', body: JSON.stringify(payload) });
    importPlan = { payload, data };
    renderImportPreview(data);
  } catch (err) {
    importPlan = null;
    $('#import-preview').hidden = true;
    status.textContent = t('err.prefix', { message: err.message });
  }
});

$('#import-apply').addEventListener('click', async () => {
  if (!importPlan) return;
  const btn = $('#import-apply');
  btn.disabled = true;
  try {
    const result = await api('/api/products/import', { method: 'POST', body: JSON.stringify(importPlan.payload) });
    products = await api('/api/products');
    scanStockAlerts(products);
    renderCategories(); renderGrid(); renderInventory();
    toast(t('imp.done', { created: result.created, updated: result.updated, skipped: result.skipped, failed: result.failed }));
    importPlan = null;
    $('#import-file').value = '';
    $('#import-preview').hidden = true;
    $('#import-status').textContent = '';
  } catch (err) {
    toast(t('err.prefix', { message: err.message }));
  } finally {
    btn.disabled = false;
  }
});

// ---------- Audit trail ----------
const fmtDateTime = value => {
  if (!value) return '—';
  const iso = String(value).includes('T') ? value : String(value).replace(' ', 'T') + 'Z';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(I18N.locale(), { dateStyle: 'short', timeStyle: 'short' });
};
/** Render structured details ("{file:...}") as readable pairs instead of raw JSON. */
function formatAuditDetails(details) {
  const text = String(details ?? '').trim();
  if (!text) return '—';
  if (!text.startsWith('{')) return text;
  try {
    const obj = JSON.parse(text);
    return Object.entries(obj)
      .map(([key, value]) => `${key}: ${value !== null && typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join(' · ');
  } catch {
    return text;
  }
}

function auditActionLabel(action) {
  const key = `audit.action.${action}`;
  const label = t(key);
  return label === key ? action : label;
}
async function renderAudit() {
  if (me?.role !== 'admin') return;
  const params = new URLSearchParams({ limit: '200' });
  const action = $('#audit-action').value;
  const q = $('#audit-search').value.trim();
  if (action) params.set('action', action);
  if (q) params.set('q', q);
  const data = await api('/api/audit?' + params.toString());
  $('#audit-count').textContent = t('audit.count', { n: data.total });
  if ($('#audit-action').dataset.filled !== 'yes') {
    $('#audit-action').innerHTML = `<option value="">${esc(t('audit.allActions'))}</option>` +
      data.actions.map(a => `<option value="${esc(a.action)}">${esc(auditActionLabel(a.action))} (${a.c})</option>`).join('');
    $('#audit-action').dataset.filled = 'yes';
  }
  $('#audit-action').value = action;
  $('#audit-body').innerHTML = data.entries.map(entry => `<tr>
    <td class="nowrap"><bdi>${esc(fmtDateTime(entry.at))}</bdi></td>
    <td dir="auto">${esc(entry.actor || '—')}${entry.role ? ` <span class="muted small">(${esc(roleLabel(entry.role))})</span>` : ''}</td>
    <td>${esc(auditActionLabel(entry.action))}</td>
    <td class="small" dir="auto">${esc(formatAuditDetails(entry.details))}${entry.entity ? ` <span class="muted">${esc(entry.entity)}#${esc(entry.entity_id)}</span>` : ''}</td>
    <td class="small" dir="ltr">${esc(entry.ip || '—')}</td>
  </tr>`).join('');
  $('#audit-empty').hidden = data.entries.length > 0;
}
$('#audit-refresh').addEventListener('click', () => safeRender(renderAudit));
$('#audit-action').addEventListener('change', () => safeRender(renderAudit));
let auditSearchTimer = null;
$('#audit-search').addEventListener('input', () => {
  clearTimeout(auditSearchTimer);
  auditSearchTimer = setTimeout(() => safeRender(renderAudit), 300);
});

function openProductForm(p) {
  $('#product-form-title').textContent = p ? t('prod.titleEdit') : t('prod.titleAdd');
  $('#f-id').value = p ? p.id : '';
  $('#f-name').value = p ? p.name : '';
  $('#f-category').value = p ? categoryLabel(p.category) : '';
  $('#f-price').value = p ? p.price : '';
  $('#f-stock').value = p ? p.stock : '';
  $('#f-unit').value = p ? unitLabel(p.unit) : unitLabel('each');
  $('#f-emoji').value = p ? (p.emoji || '📦') : '📦';
  $('#f-barcode').value = p ? p.barcode : '';
  $('#f-tax-rate').value = p && p.tax_rate != null ? p.tax_rate : '';
  $('#f-cost').value = p && p.cost_price != null ? p.cost_price : '';
  $('#cat-list').innerHTML = categories().filter(c => c !== 'All').map(c => `<option value="${esc(categoryLabel(c))}">`).join('');
  openModal('#product-modal');
}
$('#restore-defaults-btn').addEventListener('click', async () => {
  if (!confirm(t('inv.starterConfirm'))) return;
  try {
    const result = await api('/api/products/defaults', { method: 'POST', body: '{}' });
    products = await api('/api/products');
    scanStockAlerts(products);
    renderCategories(); renderGrid(); renderInventory();
    toast(t('inv.starterDone', { added: result.added, reactivated: result.reactivated }));
  } catch (e) { toast(t('err.prefix', { message: e.message })); }
});
$('#add-product-btn').addEventListener('click', () => openProductForm(null));
$('#product-form').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('#f-id').value;
  // Submit canonical English values so category filters, reports and CSV exports stay consistent.
  const body = { name: $('#f-name').value, category: I18N.categoryCanonical($('#f-category').value), price: parseFloat($('#f-price').value), stock: parseInt($('#f-stock').value), unit: unitCanonical($('#f-unit').value), emoji: $('#f-emoji').value, barcode: $('#f-barcode').value, taxRate: $('#f-tax-rate').value, costPrice: $('#f-cost').value };
  try {
    if (id) await api(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/products', { method: 'POST', body: JSON.stringify(body) });
    products = await api('/api/products');
    scanStockAlerts(products);
    $('#product-modal').hidden = true;
    renderCategories(); renderGrid(); renderInventory();
    toast(t('inv.saved'));
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
});

// ---------- Customers ----------
function renderCustomers() {
  $('#cust-count').textContent = t('cust.count', { n: customers.length });
  const admin = me.role === 'admin';
  $('#cust-body').innerHTML = customers.map(c => `<tr>
    <td><strong dir="auto">${esc(c.name)}</strong></td><td dir="ltr">${esc(c.phone || '—')}</td><td dir="ltr">${esc(c.email || '—')}</td>
    <td>⭐ ${c.points}</td><td>${fmtDateShort(c.created_at)}</td>
    ${admin ? `<td><button class="icon-btn" data-edit="${c.id}" title="${esc(t('inv.edit'))}">✏️</button></td>` : '<td></td>'}</tr>`).join('')
    || `<tr><td colspan="6" style="text-align:center;color:var(--muted)">${esc(t('cust.none'))}</td></tr>`;
  $$('#cust-body [data-edit]').forEach(b => b.addEventListener('click', () => openCustomerForm(customers.find(c => c.id === +b.dataset.edit))));
}

function openCustomerForm(c) {
  $('#customer-form-title').textContent = c ? t('cust.editTitle') : t('cust.addTitle');
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
    toast(t('cust.saved'));
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
});

// ---------- Sales ----------
async function renderSales() {
  const [stats, sales, shifts] = await Promise.all([api('/api/stats'), api('/api/sales'), api('/api/shifts')]);
  await renderProfit();
  const today = stats.today;
  $('#stats').innerHTML = `
    <div class="stat"><div class="label">${esc(t('sales.revenueToday'))}</div><div class="value"><bdi>${money(today.revenue)}</bdi></div></div>
    <div class="stat"><div class="label">${esc(t('sales.txToday'))}</div><div class="value">${today.transactions}</div></div>
    <div class="stat"><div class="label">${esc(t('sales.itemsToday'))}</div><div class="value">${today.items}</div></div>
    <div class="stat"><div class="label">${esc(t('sales.allRevenue'))}</div><div class="value">${money(stats.total.revenue)}</div></div>
    <div class="stat"><div class="label">${esc(t('sales.allTx'))}</div><div class="value">${stats.total.transactions}</div></div>`;
  const maxRev = stats.top[0]?.revenue || 1;
  $('#top-products').innerHTML = stats.top.length ? stats.top.map(p => `
    <div class="top-row"><span>${p.emoji} <span dir="auto">${esc(p.name)}</span> <span class="muted">×${p.qty}</span></span><strong>${money(p.revenue)}</strong></div>
    <div class="bar"><div style="width:${(p.revenue / maxRev * 100).toFixed(1)}%"></div></div>`).join('')
    : `<p class="muted">${esc(t('sales.noSales'))}</p>`;
  $('#by-cashier').innerHTML = stats.byCashier.length ? stats.byCashier.map(c =>
    `<div class="top-row"><span>👤 ${esc(c.cashier)} <span class="muted">${esc(t('sales.nSales', { n: c.transactions }))}</span></span><strong>${money(c.revenue)}</strong></div>`).join('')
    : `<p class="muted">${esc(t('sales.noSales'))}</p>`;
  $('#low-stock').innerHTML = stats.lowStock.length ? stats.lowStock.map(p =>
    `<div class="top-row"><span>${p.emoji} <span dir="auto">${esc(p.name)}</span></span><span class="stock-badge ${p.stock <= 0 ? 'out' : 'low'}">${esc(t('sales.nLeft', { n: p.stock }))}</span></div>`).join('')
    : `<p class="muted">${esc(t('sales.allStocked'))}</p>`;

  const filter = $('#sales-filter').value;
  const visible = sales.filter(s => filter === 'all' || s.status === filter);
  const admin = me.role === 'admin';
  $('#sales-body').innerHTML = visible.length ? visible.map(s => `<tr>
    <td>#${s.id}</td><td>${fmtDate(s.date)}</td>
    <td>${esc(s.cashier_name || '—')}</td><td dir="auto">${esc(s.customer_name || '—')}</td>
    <td>${s.items.reduce((a, i) => a + i.qty, 0)}</td>
    <td>${s.payment === 'card' ? esc(t('sales.payCard')) : esc(t('sales.payCash'))}</td>
    <td><span class="status-badge ${s.status}">${esc(statusLabel(s.status))}</span></td>
    <td><strong>${money(s.total)}</strong></td>
    ${admin && s.status === 'completed' ? `<td><button class="icon-btn" data-void="${s.id}" title="${esc(t('sales.voidTitle'))}">🚫</button><button class="icon-btn" data-refund="${s.id}" title="${esc(t('sales.refundTitle'))}">↩️</button></td>` : '<td></td>'}</tr>`).join('')
    : `<tr><td colspan="9" style="text-align:center;color:var(--muted)">${esc(t('sales.noTransactions'))}</td></tr>`;
  $$('#sales-body [data-void]').forEach(b => b.addEventListener('click', () => saleAction(b.dataset.void, 'void')));
  $$('#sales-body [data-refund]').forEach(b => b.addEventListener('click', () => saleAction(b.dataset.refund, 'refund')));

  $('#shifts-body').innerHTML = shifts.map(s => `<tr>
    <td>#${s.id}</td><td>${esc(s.cashier_name || '—')}</td><td dir="auto">${esc(s.register)}</td>
    <td>${fmtDate(s.opened_at)}</td><td>${s.closed_at ? fmtDate(s.closed_at) : '—'}</td>
    <td>${money(s.opening_float)}</td><td>${s.expected_cash != null ? money(s.expected_cash) : '—'}</td>
    <td>${s.closing_amount != null ? money(s.closing_amount) : '—'}</td>
    <td>${s.expected_cash != null && s.closing_amount != null ? money(s.closing_amount - s.expected_cash) : '—'}</td>
    <td><span class="status-badge ${s.status === 'open' ? '' : 'refunded'}">${esc(statusLabel(s.status))}</span></td></tr>`).join('')
    || `<tr><td colspan="10" style="text-align:center;color:var(--muted)">${esc(t('sales.noShifts'))}</td></tr>`;

  $('#export-btn').onclick = () => {
    const rows = [[t('csv.saleId'), t('col.date'), t('col.cashier'), t('col.customer'), t('csv.item'), t('csv.qty'), t('csv.unitPrice'), t('csv.lineTotal'), t('csv.discount'), t('receipt.tax'), t('col.total'), t('col.payment'), t('col.status')]];
    for (const s of sales) for (const i of s.items)
      rows.push([s.id, s.date, s.cashier_name || '', s.customer_name || '', i.name, i.qty, i.price, i.line_total, s.discount_pct, s.tax, s.total, s.payment, statusLabel(s.status)]);
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'freshmart-sales.csv';
    a.click();
  };
}
$('#sales-filter').addEventListener('change', renderSales);

// ---------- Profit report (admin) ----------
let profitReport = null;

const marginLabel = value => (value === null || value === undefined ? '—' : `${value.toFixed(1)}%`);

async function renderProfit() {
  const card = $('#profit-card');
  if (!card) return;
  if (me?.role !== 'admin') { card.hidden = true; return; }
  card.hidden = false;
  const days = Number($('#profit-days').value) || 7;
  const data = await api(`/api/reports/profit?days=${days}`);
  profitReport = data;
  const totals = data.totals;
  $('#profit-stats').innerHTML = `
    <div class="stat"><span class="muted small">${esc(t('profit.revenue'))}</span><strong>${money(totals.revenue)}</strong></div>
    <div class="stat"><span class="muted small">${esc(t('profit.cost'))}</span><strong>${money(totals.cost)}</strong></div>
    <div class="stat"><span class="muted small">${esc(t('profit.profit'))}</span><strong class="${totals.profit < 0 ? 'negative' : ''}">${money(totals.profit)}</strong></div>
    <div class="stat"><span class="muted small">${esc(t('profit.margin'))}</span><strong>${marginLabel(totals.margin)}</strong></div>
    <div class="stat"><span class="muted small">${esc(t('profit.sales'))}</span><strong><bdi>${totals.sales}</bdi> · <bdi>${totals.qty}</bdi> ${esc(t('profit.units'))}</strong></div>`;
  const notes = [t('profit.note')];
  if (totals.unpriced_items) notes.push(t('profit.unpriced', { n: totals.unpriced_items }));
  $('#profit-note').textContent = notes.join(' ');

  $('#profit-days-body').innerHTML = data.days.length ? data.days.map(row => `<tr>
    <td class="nowrap"><bdi>${esc(row.day)}</bdi></td>
    <td>${money(row.revenue)}</td>
    <td>${money(row.cost)}</td>
    <td class="${row.profit < 0 ? 'negative' : ''}"><strong>${money(row.profit)}</strong></td>
    <td>${marginLabel(row.margin)}</td>
  </tr>`).join('') : `<tr><td colspan="5" class="muted">${esc(t('profit.noSales'))}</td></tr>`;

  $('#profit-products-body').innerHTML = data.products.length ? data.products.map(row => `<tr>
    <td dir="auto">${row.emoji || '📦'} ${esc(row.name)}</td>
    <td><bdi>${row.qty}</bdi></td>
    <td class="${row.profit < 0 ? 'negative' : ''}"><strong>${money(row.profit)}</strong></td>
    <td>${marginLabel(row.margin)}</td>
  </tr>`).join('') : `<tr><td colspan="4" class="muted">${esc(t('profit.noSales'))}</td></tr>`;
}

$('#profit-days').addEventListener('change', () => safeRender(renderProfit));

$('#profit-export').addEventListener('click', () => {
  const report = profitReport;
  if (!report) return;
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [
    [t('profit.colDay'), t('profit.colRevenue'), t('profit.colCost'), t('profit.colProfit'), t('profit.colMargin'), t('profit.colSales')],
    ...report.days.map(row => [row.day, row.revenue, row.cost, row.profit, row.margin ?? '', row.sales]),
    [],
    [t('profit.colProduct'), t('profit.colQty'), t('profit.colRevenue'), t('profit.colCost'), t('profit.colProfit'), t('profit.colMargin')],
    ...report.products.map(row => [row.name, row.qty, row.revenue, row.cost, row.profit, row.margin ?? '']),
    [],
    [t('cart.total'), report.totals.revenue, report.totals.cost, report.totals.profit, report.totals.margin ?? '', report.totals.sales],
  ];
  const csv = '\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `freshmart-profit-${report.window.days}-days.csv`;
  a.click();
});

async function saleAction(id, action) {
  if (!confirm(t(action === 'void' ? 'sales.voidConfirm' : 'sales.refundConfirm', { id }))) return;
  try {
    const result = await api(`/api/sales/${id}/${action}`, { method: 'POST' });
    products = await api('/api/products');
    scanStockAlerts(products);
    renderGrid(); renderSales();
    toast(result.status === 'refund_pending' ? t('sales.refundPending') : t(action === 'void' ? 'sales.voidDone' : 'sales.refundDone'));
  } catch (e) { toast(t('err.prefix', { message: e.message })); }
}

// ---------- Settings ----------
async function renderSettings() {
  if (me.role !== 'admin') return;
  for (const k of ['store_name', 'store_address', 'store_phone', 'vat_number', 'receipt_footer', 'tax_rate', 'currency', 'currency_code', 'low_stock_threshold', 'register_name', 'points_per_dollar', 'points_value']) {
    $('#s-' + k).value = settings[k];
  }
  $('#s-terminal_register').value = localStorage.getItem(REGISTER_KEY) || settings.register_name || 'Register 1';
  $('#payment-status').textContent = t('set.checkoutStatus');
  syncLangControls();
  const users = await api('/api/users');
  $('#users-body').innerHTML = users.map(u => `<tr>
    <td><strong>${esc(u.username)}</strong></td><td dir="auto">${esc(u.name)}</td>
    <td>${u.role === 'admin' ? esc(t('role.ownerBadge')) : esc(t('role.cashierBadge'))}</td>
    <td>${u.active ? `<span class="stock-badge">${esc(t('status.active'))}</span>` : `<span class="stock-badge out">${esc(t('status.disabled'))}</span>`}</td>
    <td>${u.id !== me.id ? `<button class="icon-btn" data-toggle="${u.id}" title="${esc(t('set.users'))}">${u.active ? '🚫' : '✅'}</button>` : ''}</td></tr>`).join('');
  await renderBackups();
  $$('#users-body [data-toggle]').forEach(b => b.addEventListener('click', async () => {
    const u = users.find(x => x.id === +b.dataset.toggle);
    await api(`/api/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ active: !u.active }) });
    renderSettings();
  }));
}

// ---------- Server-side automatic backups ----------
async function renderBackups() {
  const note = $('#backup-note');
  try {
    const data = await api('/api/backups');
    note.textContent = data.enabled
      ? t('set.autobackupNote', { hours: data.interval_hours, keep: data.keep, dir: data.dir })
      : t('set.backupsDisabled');
    renderOffsite(data.offsite);
    $('#backups-list').innerHTML = data.files.length
      ? data.files.map(f => `<li><bdi>${esc(f.file)}</bdi> <span class="muted small">${esc(fmtDateTime(f.created_at))} · <bdi>${(f.bytes / 1024).toFixed(1)} KB</bdi></span></li>`).join('')
      : `<li class="muted small">${esc(t('set.noBackups'))}</li>`;
  } catch (err) {
    note.textContent = t('err.prefix', { message: err.message });
  }
}

function renderOffsite(offsite) {
  const note = $('#offsite-note');
  const button = $('#offsite-upload');
  if (!offsite) { note.textContent = ''; button.hidden = true; return; }
  if (!offsite.configured) {
    note.textContent = t('set.offsiteOff');
    button.hidden = true;
    return;
  }
  button.hidden = !offsite.key_configured;
  const last = offsite.last_at
    ? t('set.offsiteLast', { time: fmtDateTime(offsite.last_at), result: offsite.last_result || '—' })
    : t('set.offsiteNever');
  note.textContent = offsite.key_configured
    ? `${t('set.offsiteOn', { target: offsite.target || '—' })} · ${last}`
    : t('set.offsiteKeyMissing');
}

$('#offsite-upload').addEventListener('click', async () => {
  const button = $('#offsite-upload');
  button.disabled = true;
  const note = $('#offsite-note');
  const previous = note.textContent;
  note.textContent = t('set.offsiteUploading');
  try {
    const result = await api('/api/backups/upload', { method: 'POST', body: '{}' });
    toast(t('set.offsiteDone', { file: result.file, bytes: `${(result.bytes / 1024).toFixed(1)} KB` }));
  } catch (err) {
    toast(t('err.prefix', { message: err.message }));
    note.textContent = previous;
  } finally {
    button.disabled = false;
    await renderBackups();
  }
});

$('#backup-run').addEventListener('click', async () => {
  const btn = $('#backup-run');
  btn.disabled = true;
  try {
    $('#backup-note').textContent = t('set.backupRunning');
    const result = await api('/api/backups/run', { method: 'POST', body: '{}' });
    toast(t('set.backupCreated', { file: result.file }));
  } catch (err) {
    toast(t('err.prefix', { message: err.message }));
  } finally {
    btn.disabled = false;
    await renderBackups();
  }
});

$('#store-form').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {};
  for (const k of ['store_name', 'store_address', 'store_phone', 'vat_number', 'receipt_footer', 'tax_rate', 'currency', 'currency_code', 'low_stock_threshold', 'register_name', 'points_per_dollar', 'points_value']) body[k] = $('#s-' + k).value;
  const nextTerminal = $('#s-terminal_register').value.trim();
  const effectiveNext = nextTerminal || $('#s-register_name').value.trim() || 'Register 1';
  if (shift && effectiveNext !== terminalRegister()) {
    toast(t('set.closeShiftBeforeRegister'));
    return;
  }
  try {
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (nextTerminal) localStorage.setItem(REGISTER_KEY, nextTerminal);
    else localStorage.removeItem(REGISTER_KEY);
    await refreshShift();
    showApp();
    renderCart(); renderGrid();
    if (!shift) await ensureShift();
    toast(t('set.saved'));
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
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
    if (me.role !== 'developer' && ['trial', 'active'].includes(me.subscriptionStatus || 'trial')) {
      await refreshAll();
      await ensureShift();
      await syncQueue();
    }
  } catch (err) {
    error.textContent = t('err.prefix', { message: err.message });
    error.hidden = false;
  }
});

$('#password-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current: $('#pw-current').value, next: $('#pw-next').value }) });
    $('#pw-current').value = $('#pw-next').value = '';
    toast(t('set.pwChanged'));
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
});

$('#user-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ username: $('#u-username').value, name: $('#u-name').value, password: $('#u-password').value, role: $('#u-role').value }) });
    $('#u-username').value = $('#u-name').value = $('#u-password').value = '';
    renderSettings();
    toast(t('set.userCreated'));
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
});

$('#backup-export').addEventListener('click', async () => {
  const dump = await api('/api/backup');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }));
  a.download = `freshmart-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast(t('set.exported'));
});

$('#backup-import').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm(t('set.importConfirm'))) { e.target.value = ''; return; }
  try {
    const data = JSON.parse(await file.text());
    await api('/api/backup/import', { method: 'POST', body: JSON.stringify(data) });
    await refreshAll();
    toast(t('set.imported'));
  } catch (err) { toast(t('err.prefix', { message: err.message })); }
  e.target.value = '';
});

// ---------- Init ----------
async function refreshAll() {
  [products, customers] = await Promise.all([api('/api/products'), api('/api/customers')]);
  scanStockAlerts(products);
  renderCategories(); renderGrid(); renderCart(); renderCustomerSelect();
  updateQueueBadge();
}

(async () => {
  syncLangControls();
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
      if (me.role !== 'developer' && ['trial', 'active'].includes(me.subscriptionStatus || 'trial')) {
        await refreshAll();
        await ensureShift();
        await syncQueue();
      }
    }
  } catch (err) {
    showLogin();
    // A fresh visitor has no session (401) — that is normal. But if the API is not
    // served at all (404/HTML/5xx) the POS can never log in, so explain it loudly.
    if (err && err.code === 'API_NOT_SERVED') reportApiProblem(err);
  }
  // Offline support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
