'use strict';
/**
 * Browser-level smoke test for the POS UI.
 *
 *   npm install --no-save jsdom && npm run test:ui
 *
 * Runs the real app in a headless DOM against a throw-away server + database:
 * sign in → rotate password → open shift → import stock from CSV → audit log →
 * server backups → English toggle. jsdom is the only optional tool; it is NOT a
 * runtime dependency of the POS and is not required by `npm test`.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.UI_SMOKE_PORT || 3225);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'UiSmokeAdminPassword2026!';
const ADMIN_PASSWORD_NEW = 'UiSmokeAdminPassword2026-v2!';
const dbPath = path.join(os.tmpdir(), `pos-ui-smoke-${Date.now()}.db`);
const backupDir = path.join(os.tmpdir(), `pos-ui-smoke-backups-${Date.now()}`);

const CSV = '\uFEFFاسم المنتج,القسم,السعر,الوحدة,المخزون,الباركود,الضريبة\r\n' +
  'شيبسي مملح 90 جم,وجبات خفيفة,10,كيس,25,900777,14\r\n' +
  'مياه معدنية 1.5 لتر,مشروبات,6,عبوة,60,900778,0\r\n';

let jsdom;
try {
  jsdom = require('jsdom');
} catch {
  console.log('⚠️  jsdom is not installed — skipping the UI smoke test.');
  console.log('   npm install --no-save jsdom && npm run test:ui');
  process.exit(0);
}

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!condition) failures.push(label);
}

async function main() {
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      POS_DB_PATH: dbPath,
      POS_INITIAL_ADMIN_PASSWORD: ADMIN_PASSWORD,
      POS_DEVELOPER_USERNAME: 'ui-smoke-dev',
      POS_DEVELOPER_PASSWORD: 'UiSmokeDeveloper2026!',
      POS_BACKUP_DIR: backupDir,
      POS_BACKUP_KEEP: '3',
      POS_COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) break; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }

  const errors = [];
  const { JSDOM, VirtualConsole } = jsdom;
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  vc.on('error', (...args) => errors.push(args.join(' ')));

  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // jsdom has neither fetch nor a cookie jar; both are needed for a session.
      let jar = '';
      window.fetch = async (input, init = {}) => {
        const headers = { ...(init.headers || {}) };
        if (jar) headers.Cookie = jar;
        const res = await fetch(new URL(input, BASE).href, { ...init, headers });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) jar = setCookie.split(';')[0];
        return res;
      };
      // Older jsdom builds ship Blob/File without the Blob promise helpers the app uses.
      const readAs = (blob, as) => new Promise((resolve, reject) => {
        const reader = new window.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        if (as === 'text') reader.readAsText(blob);
        else if (as === 'dataurl') reader.readAsDataURL(blob);
        else reader.readAsArrayBuffer(blob);
      });
      for (const proto of [window.Blob.prototype, window.File.prototype]) {
        if (typeof proto.arrayBuffer !== 'function') proto.arrayBuffer = function () { return readAs(this, 'buffer'); };
        if (typeof proto.text !== 'function') proto.text = function () { return readAs(this, 'text'); };
      }
      window.__readAsDataUrl = blob => readAs(blob, 'dataurl');
    },
  });
  const { window } = dom;
  const $ = selector => window.document.querySelector(selector);
  const $$ = selector => [...window.document.querySelectorAll(selector)];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const submit = (selector) => $(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const tab = name => $$('.tab').find(t => t.dataset.view === name);

  await wait(2200);
  check('Arabic RTL shell renders', window.document.documentElement.dir === 'rtl' && !!$('#login-form'));

  $('#login-user').value = 'admin';
  $('#login-pass').value = ADMIN_PASSWORD;
  submit('#login-form');
  await wait(1500);
  if (!$('#force-password-modal').hidden) {
    $('#force-pw-current').value = ADMIN_PASSWORD;
    $('#force-pw-next').value = ADMIN_PASSWORD_NEW;
    submit('#force-password-form');
    await wait(1800);
  }
  check('sign-in works', !$('#app').hidden && $('#login-screen').hidden);

  if (!$('#shift-modal').hidden) {
    $('#opening-float').value = '200';
    $('#shift-confirm').click();
    await wait(1400);
  }
  check('shift opens', /وردية/.test($('#shift-badge').textContent) && !/لا توجد/.test($('#shift-badge').textContent), $('#shift-badge').textContent.trim());

  tab('inventory').click();
  await wait(700);
  check('stock-import card is reachable', !!$('#import-card') && window.getComputedStyle($('#import-card')).display !== 'none');
  check('import template link points at the API', ($('#import-card a.btn')?.getAttribute('href') || '') === '/api/products/import/template');

  const file = new window.File([CSV], 'stock.csv', { type: 'text/csv' });
  Object.defineProperty($('#import-file'), 'files', { value: [file], configurable: true });
  $('#import-file').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(1800);
  const rowsBeforeApply = $$('#import-body tr').length;
  check('preview lists the uploaded rows', rowsBeforeApply === 2, `${rowsBeforeApply} rows · ${$('#import-status').textContent.trim()}`);
  check('preview shows the summary', /جديد: 2/.test($('#import-summary').textContent), $('#import-summary').textContent.trim());

  $('#import-apply').click();
  await wait(2200);
  const imported = $$('#inv-body tr').find(row => row.textContent.includes('شيبسي مملح'));
  check('import writes the products', !!imported, imported ? imported.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : 'not found');
  check('preview closes after the import', $('#import-preview').hidden);

  tab('audit').click();
  await wait(1400);
  const auditRows = $$('#audit-body tr').length;
  check('audit log lists operations', auditRows >= 3, `${auditRows} rows`);
  check('audit shows localized action names', /\S/.test($('#audit-body tr')?.textContent || '') && !/products_imported/.test($('#audit-body')?.textContent || ''));

  $('#audit-search').value = 'admin';
  $('#audit-search').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(900);
  check('audit search filters', $$('#audit-body tr').length >= 1);

  tab('settings').click();
  await wait(1600);
  const backupsBefore = $$('#backups-list li').length;
  check('backup card lists server snapshots', backupsBefore >= 1, `${backupsBefore} files`);
  check('backup retention is explained', /24/.test($('#backup-note').textContent), $('#backup-note').textContent.trim().slice(0, 60));
  $('#backup-run').click();
  await wait(1800);
  check('manual backup creates a file', $$('#backups-list li').length > backupsBefore);

  // ---- purchases & suppliers ----
  tab('purchases').click();
  await wait(1200);
  check('purchases view opens', !!$('#suppliers-body') && $$('.tab').find(t => t.dataset.view === 'purchases').classList.contains('active'));
  check('empty supplier list is explained', /مورد/.test($('#suppliers-body').textContent), $('#suppliers-body').textContent.trim().slice(0, 40));

  $('#add-supplier-btn').click();
  await wait(300);
  $('#sup-name').value = 'شركة النيل للتوزيع';
  $('#sup-phone').value = '01001234567';
  submit('#supplier-form');
  await wait(1400);
  check('supplier is created', /شركة النيل/.test($('#suppliers-body').textContent));

  // supplier statement opens with the invoice we are about to create
  $$('#suppliers-body [data-sup-statement]')[0].click();
  await wait(1400);
  check('supplier statement opens', !$('#statement-modal').hidden && /كشف حساب/.test($('#stm-title').textContent), $('#stm-title').textContent.trim());
  check('statement explains an empty period', /لا توجد فواتير مشتريات/.test($('#stm-body').textContent), $('#stm-body').textContent.trim().slice(0, 40));
  $('#statement-modal [data-close]').click();
  await wait(200);

  const productsBefore = await (await window.fetch('/api/products')).json();
  const target = productsBefore[0];
  $('#add-purchase-btn').click();
  await wait(400);
  const lines = $$('#pur-lines .purchase-line');
  check('purchase form starts with two lines', lines.length === 2);
  const firstProduct = lines[0].querySelector('.pl-product');
  firstProduct.value = String(target.id);
  firstProduct.dispatchEvent(new window.Event('change', { bubbles: true }));
  $('#pur-supplier').value = [...$('#pur-supplier').options].find(o => o.textContent.includes('شركة النيل'))?.value || '';
  lines[0].querySelector('.pl-qty').value = '5';
  lines[0].querySelector('.pl-cost').value = '10';
  lines[0].querySelector('.pl-qty').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(200);
  check('purchase totals are calculated', /ج\.م/.test($('#pur-totals').textContent), $('#pur-totals').textContent.replace(/\s+/g, ' ').trim().slice(0, 70));
  submit('#purchase-form');
  await wait(2000);
  check('purchase appears in the invoice list', $$('#purchases-body tr').length >= 1 && /شركة النيل/.test($('#purchases-body').textContent));
  check('purchase save reported success', /استلام البضاعة/.test($('#toast').textContent), $('#toast').textContent.trim().slice(0, 90));
  const productsAfter = await (await window.fetch('/api/products')).json();
  const restocked = productsAfter.find(p => p.id === target.id);
  check('purchase increases stock', restocked.stock === target.stock + 5, `${target.name}: ${target.stock} → ${restocked.stock}`);
  check('purchase sets the unit cost', Number(restocked.cost_price) === 10, `cost ${restocked.cost_price}`);

  $$('#suppliers-body [data-sup-statement]')[0].click();
  await wait(1500);
  check('statement lists the new invoice', /INV|#|ج\.م/.test($('#stm-body').textContent) && $$('#stm-body tr').length === 1, $('#stm-body').textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
  check('statement totals the outstanding amount', $$('#stm-stats .stat').length === 4, $('#stm-stats').textContent.replace(/\s+/g, ' ').trim().slice(0, 70));

  $('#stm-pay-amount').value = '20';
  $('#stm-pay-method').value = 'bank';
  const invoiceOption = [...$('#stm-pay-invoice').options].find(o => o.value)?.value;
  $('#stm-pay-invoice').value = invoiceOption || '';
  $('#stm-pay-add').click();
  await wait(1800);
  check('payment is recorded from the statement', $$('#stm-payments-body tr').length === 1 && /تحويل بنكي/.test($('#stm-payments-body').textContent), $('#stm-payments-body').textContent.replace(/\s+/g, ' ').trim().slice(0, 70));
  check('payment lowers the outstanding balance', /34\.00/.test($('#stm-stats').textContent), $('#stm-stats').textContent.replace(/\s+/g, ' ').trim().slice(0, 80));

  window.confirm = () => true;
  $('#stm-payments-body [data-pay-del]').click();
  await wait(1600);
  check('deleting a payment restores the balance', /لا توجد دفعات/.test($('#stm-payments-body').textContent) && /54\.00/.test($('#stm-stats').textContent), $('#stm-stats').textContent.replace(/\s+/g, ' ').trim().slice(0, 70));
  $('#statement-modal [data-close]').click();
  await wait(200);
  tab('inventory').click();
  await wait(800);
  check('inventory shows the new quantity', $$('#inv-body tr').find(r => r.textContent.includes(target.name))?.textContent.includes(String(restocked.stock)), `${restocked.stock} expected`);

  // ---- stocktake ----
  tab('stocktake').click();
  await wait(1200);
  $('#stk-start').click();
  await wait(1800);
  const stkInputs = $$('#stk-body .stk-counted');
  check('stocktake lists products with expected quantities', stkInputs.length >= 20, `${stkInputs.length} rows`);
  const firstInput = stkInputs[0];
  const expected = Number(firstInput.closest('tr').children[1].textContent.trim());
  firstInput.value = String(expected + 2);
  firstInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(300);
  check('stocktake shows the difference live', /\+2/.test(firstInput.closest('tr').textContent), firstInput.closest('tr').textContent.replace(/\s+/g, ' ').trim().slice(0, 70));
  $('#stk-save').click();
  await wait(1200);
  window.confirm = () => true;
  $('#stk-apply').click();
  await wait(2200);
  const applied = $$('#stk-history tr').find(r => /مطبَّق|مطبّق/.test(r.textContent));
  check('stocktake is applied and recorded', !!applied, applied ? applied.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : $('#stk-history').textContent.trim().slice(0, 80));

  // ---- off-site backup status ----
  tab('settings').click();
  await wait(1400);
  check('off-site backup explains how to enable it', /POS_BACKUP_UPLOAD_URL/.test($('#offsite-note').textContent), $('#offsite-note').textContent.trim().slice(0, 60));

  // ---- profit report ----
  tab('sales').click();
  await wait(1600);
  check('profit card renders its five KPIs', $$('#profit-stats .stat').length === 5, $('#profit-stats').textContent.replace(/\s+/g, ' ').trim().slice(0, 80));
  check('profit card explains the cost source', /تكلفة الوحدة الحالية/.test($('#profit-note').textContent));
  check('empty profit period is explained', /لا توجد مبيعات مكتملة/.test($('#profit-days-body').textContent));

  check('VAT card nets output against input tax', $$('#vat-stats .stat').length === 5, $('#vat-stats').textContent.replace(/\s+/g, ' ').trim().slice(0, 80));
  check('VAT card explains the figures', /ضريبة المخرجات/.test($('#vat-note').textContent));

  const originalCreate = window.URL.createObjectURL;
  const originalClick = window.HTMLAnchorElement.prototype.click;
  let exportedBlob = null;
  window.URL.createObjectURL = blob => { exportedBlob = blob; return 'blob:mock'; };
  window.HTMLAnchorElement.prototype.click = () => {};
  $('#profit-export').click();
  await wait(400);
  const exportedCsv = exportedBlob ? await exportedBlob.text() : '';
  window.URL.createObjectURL = originalCreate;
  window.HTMLAnchorElement.prototype.click = originalClick;
  check('profit CSV exports headers, products and totals', /الهامش/.test(exportedCsv) && /الصنف/.test(exportedCsv), `${exportedCsv.split(/\r\n/).length} lines`);

  $('[data-lang-toggle]').click();
  await wait(700);
  check('English toggle switches direction', window.document.documentElement.dir === 'ltr');
  tab('inventory').click();
  await wait(600);
  check('English translations cover the new views', /Import stock from Excel/.test($('#import-card h3').textContent));
  check('English tab names are translated', /Purchases/.test(tab('purchases').textContent) && /Stocktake/.test(tab('stocktake').textContent));
  tab('sales').click();
  await wait(1200);
  check('English VAT card is translated', /Receivables|Output tax/.test($('#vat-stats').textContent), $('#vat-stats').textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
  check('English profit card is translated', /Profit & margin/.test($('#profit-card').textContent) && /Revenue \(ex-tax\)/.test($('#profit-stats').textContent), $('#profit-stats').textContent.replace(/\s+/g, ' ').trim().slice(0, 60));

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));

  const closed = new Promise(resolve => server.on('exit', code => resolve(code)));
  server.kill('SIGTERM');
  const exitCode = await Promise.race([closed, new Promise(r => setTimeout(() => r('timeout'), 12000))]);
  check('server shuts down gracefully on SIGTERM', exitCode === 0, String(exitCode));
  if (exitCode !== 0) console.log(serverLog.split('\n').slice(-15).join('\n'));

  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignore */ }

  try { window.close(); } catch { /* ignore */ }

  console.log('');
  if (failures.length) {
    console.error(`❌ UI smoke test failed: ${failures.length} check(s) — ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('✅ UI smoke test passed');
  process.exit(0);
}

main().catch(err => { console.error('FAILED', err); process.exit(1); });
