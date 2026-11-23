#!/usr/bin/env node
'use strict';
/**
 * Decrypt an off-site backup container back to the JSON that
 * Settings → Import backup accepts.
 *
 *   node scripts/restore-backup.js --file backup-20260101-020000.posbak \
 *        --key "$POS_BACKUP_ENCRYPTION_KEY" --out restore.json
 *
 *   # inspect without writing anything
 *   node scripts/restore-backup.js --file x.posbak --check
 *
 * The key can also come from POS_BACKUP_ENCRYPTION_KEY. Without --out the JSON
 * goes to stdout and the summary to stderr, so `> restore.json` still works.
 */
const fs = require('fs');
const path = require('path');
const { unpackBackup, isEncrypted } = require('../lib/backup-crypto');

function usage(message) {
  if (message) console.error('✖ ' + message);
  console.error('Usage: node scripts/restore-backup.js --file <backup.posbak> [--key <passphrase>] [--out <file.json>] [--check]');
  process.exit(message ? 1 : 0);
}

const args = process.argv.slice(2);
const get = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes('--help') || args.includes('-h') || !args.length) usage();
const file = get('--file') || get('-f');
if (!file) usage('missing --file');
const key = get('--key') || process.env.POS_BACKUP_ENCRYPTION_KEY || '';
if (!key) usage('missing --key (or POS_BACKUP_ENCRYPTION_KEY)');
const out = get('--out') || get('-o');
const checkOnly = args.includes('--check');

if (!fs.existsSync(file)) usage(`file not found: ${file}`);
const buffer = fs.readFileSync(file);
if (!isEncrypted(buffer)) usage('this is not an encrypted .posbak container');

let dump;
try {
  dump = unpackBackup(buffer, key);
} catch (e) {
  console.error(e.message === 'WRONG_KEY_OR_CORRUPT'
    ? '✖ Wrong key or corrupted file — the backup was not changed.'
    : '✖ ' + e.message);
  process.exit(1);
}

if (!Array.isArray(dump.products) || !Array.isArray(dump.sales)) {
  console.error('✖ Decrypted file does not look like a POS backup (missing products/sales).');
  process.exit(1);
}

const summary = {
  exported_at: dump.exported_at,
  products: dump.products.length,
  sales: dump.sales.length,
  sale_items: (dump.sale_items || []).length,
  customers: (dump.customers || []).length,
  shifts: (dump.shifts || []).length,
  audit_entries: (dump.audit_log || []).length,
};
console.error('✅ Decrypted successfully');
for (const [label, value] of Object.entries(summary)) console.error(`   ${label}: ${value}`);

if (checkOnly) process.exit(0);
const json = JSON.stringify(dump);
if (out) {
  fs.writeFileSync(path.resolve(out), json);
  console.error(`✅ Written to ${path.resolve(out)} — import it from Settings → Import backup.`);
} else {
  process.stdout.write(json);
}
