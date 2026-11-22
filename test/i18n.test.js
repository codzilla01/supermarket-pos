'use strict';
/**
 * Localization tests — run with: npm test
 *
 * These guard the Arabic/English UI layer without a browser:
 *  - every translation key referenced by app.js / index.html exists in both languages
 *  - both languages expose exactly the same key set (no half-translated UI)
 *  - placeholders such as {id} / {n} survive in both languages
 *  - RTL/LTR direction, number format and store-data (category/unit) mapping work
 *  - the Arabic API error envelope is present on the server
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const read = file => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

/** Load i18n.js into an isolated sandbox with a minimal DOM stub. */
function loadI18n(initialLang) {
  const listeners = [];
  const storage = new Map();
  if (initialLang) storage.set('pos_lang', initialLang);
  const listenersByEvent = new Map();
  const documentStub = {
    readyState: 'complete',
    documentElement: {},
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { listenersByEvent.set(type, fn); },
    dispatchEvent: () => {},
  };
  const sandbox = {
    window: {},
    document: documentStub,
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    console,
  };
  sandbox.window = { ...sandbox.window, localStorage: sandbox.localStorage, document: documentStub };
  vm.createContext(sandbox);
  vm.runInContext(read('i18n.js'), sandbox, { filename: 'i18n.js' });
  const i18n = sandbox.window.I18N;
  return { i18n, sandbox, listeners, storage };
}

/** Collect every translation key referenced by the UI source files. */
function referencedKeys() {
  const app = read('app.js');
  const html = read('index.html');
  const keys = new Set();
  for (const m of app.matchAll(/\bt\(\s*'([A-Za-z][\w]*\.[\w.]+)'/g)) keys.add(m[1]);
  for (const m of app.matchAll(/'([a-z]+\.[a-z_]+\.[a-z_]+)'/g)) keys.add(m[1]);
  for (const m of html.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria-label)?="([A-Za-z][\w]*\.[\w.]+)"/g)) keys.add(m[1]);
  return keys;
}

function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
}

test('i18n defaults to Arabic and right-to-left', () => {
  const { i18n, sandbox } = loadI18n();
  assert.equal(i18n.lang, 'ar');
  assert.equal(i18n.dir(), 'rtl');
  assert.equal(sandbox.document.documentElement.lang, 'ar');
  assert.equal(sandbox.document.documentElement.dir, 'rtl');
  i18n.setLang('en');
  assert.equal(sandbox.document.documentElement.dir, 'ltr');
  assert.equal(i18n.lang, 'en');
});

test('language choice is persisted per terminal', () => {
  const { i18n, storage } = loadI18n();
  i18n.setLang('en');
  assert.equal(storage.get('pos_lang'), 'en');
  const restored = loadI18n(storage.get('pos_lang'));
  assert.equal(restored.i18n.lang, 'en');
});

test('every translation key used by the UI exists in both Arabic and English', () => {
  const { i18n } = loadI18n();
  const keys = referencedKeys();
  assert.ok(keys.size > 200, `expected a substantial UI vocabulary, found ${keys.size} keys`);
  const missing = [];
  for (const key of keys) {
    for (const code of ['ar', 'en']) {
      i18n.setLang(code);
      if (i18n.t(key) === key) missing.push(`${code}:${key}`);
    }
  }
  assert.deepEqual(missing, [], `missing translations: ${missing.join(', ')}`);
});

test('Arabic and English expose the same keys and the same placeholders', () => {
  const { i18n } = loadI18n();
  const keys = [...referencedKeys()];
  for (const key of keys) {
    i18n.setLang('ar');
    const ar = i18n.t(key);
    i18n.setLang('en');
    const en = i18n.t(key);
    assert.deepEqual(placeholders(ar), placeholders(en), `placeholder mismatch for ${key}`);
    // The Arabic bundle must really be Arabic (the language picker keeps "English" on purpose).
    if (key !== 'set.english' && (key.startsWith('nav.') || key.startsWith('cart.') || key.startsWith('set.'))) {
      assert.match(ar, /[\u0600-\u06FF]/, `expected Arabic text for ${key}`);
    }
  }
});

test('interpolation and number formatting keep Latin digits for cashier speed', () => {
  const { i18n } = loadI18n();
  i18n.setLang('ar');
  assert.equal(i18n.t('pos.inStock', { n: 12 }), 'متوفر 12');
  assert.match(i18n.t('shift.opened', { id: 7 }), /7/);
  const formatted = new Intl.NumberFormat(i18n.locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.5);
  assert.equal(formatted.replace(/[^0-9.]/g, ''), '1234.50');
  assert.doesNotMatch(formatted, /[٠-٩]/, 'Arabic-Indic digits must not be used at the till');
});

test('store categories and units are displayed in Arabic but saved in canonical English', () => {
  const { i18n } = loadI18n();
  i18n.setLang('ar');
  assert.equal(i18n.categoryLabel('Dairy & Eggs'), 'ألبان وبيض');
  assert.equal(i18n.categoryLabel('All'), 'الكل');
  assert.equal(i18n.unitLabel('kg'), 'كجم');
  assert.equal(i18n.categoryCanonical('ألبان وبيض'), 'Dairy & Eggs');
  assert.equal(i18n.categoryCanonical('Produce'), 'Produce');
  assert.equal(i18n.unitCanonical('قطعة'), 'each');
  assert.equal(i18n.unitCanonical('each'), 'each');
  i18n.setLang('en');
  assert.equal(i18n.categoryLabel('Dairy & Eggs'), 'Dairy & Eggs');
  // Values typed by staff that are not in the dictionary must survive untouched.
  assert.equal(i18n.categoryCanonical('مخبوزات الحيّ'), 'مخبوزات الحيّ');
  assert.equal(i18n.unitCanonical('كرتونة كبيرة'), 'كرتونة كبيرة');
});

test('the app shell is Arabic, RTL and loads the i18n layer before app.js', () => {
  const html = read('index.html');
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /<script src="i18n\.js"><\/script>/);
  assert.ok(html.indexOf('i18n.js') < html.indexOf('app.js'), 'i18n.js must load before app.js');
  assert.match(html, /data-lang-toggle/, 'a language switch must be reachable from the UI');
  // the cart placeholder must live outside #cart-items so renderCart() cannot wipe it
  assert.match(html, /<p class="cart-empty" id="cart-empty"[\s\S]*?<\/p>\s*<div class="cart-items" id="cart-items">/);
});

test('the service worker caches the i18n bundle and versions its cache', () => {
  const sw = read('sw.js');
  assert.match(sw, /'\/i18n\.js'/);
  assert.match(sw, /const CACHE = 'freshmart-pos-v\d+-/);
});

test('an unreachable API is explained instead of a bare status code', () => {
  const html = read('index.html');
  const app = read('app.js');
  const i18n = read('i18n.js');
  // a visible diagnostics card the cashier can act on
  assert.match(html, /id="diagnostics-card"/);
  assert.match(html, /id="diag-retry"/);
  assert.match(html, /data-i18n="diag\.fix1"/);
  // HTML replies (static hosting / stopped server) are detected, not rendered as "failed (404)"
  assert.match(app, /API_NOT_SERVED/);
  assert.match(app, /get\('content-type'\)/);
  assert.match(app, /err\.apiMissing/);
  for (const key of ['err.apiMissing', 'err.apiRoute', 'err.serverDown', 'diag.title', 'diag.retry', 'diag.copy']) {
    assert.match(i18n, new RegExp(`'${key.replace(/\./g, '\\.')}'`), `missing i18n key ${key}`);
  }
});

test('the server ships an Arabic message for every user-facing error', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const errorResponses = [...server.matchAll(/error:\s*(?:'[^']*'|`[^`]*`)/g)];
  const arabic = [...server.matchAll(/messageAr:/g)];
  assert.ok(errorResponses.length > 30, 'expected a meaningful number of API errors');
  assert.ok(arabic.length >= errorResponses.length, `expected messageAr on every error (${arabic.length}/${errorResponses.length})`);
});
