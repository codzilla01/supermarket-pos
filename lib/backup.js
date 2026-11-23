'use strict';
/**
 * Automatic database backups: gzipped JSON snapshots on disk with retention.
 * No cron, no dependencies — a timer inside the POS process plus the same dump
 * the manual "export backup" button uses, so a restore is always possible.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { packBackup } = require('./backup-crypto');

const FILE_RE = /^backup-(\d{8}-\d{6})\.json(\.gz)?$/;

function dumpDatabase(db, getSettings) {
  return {
    exported_at: new Date().toISOString(),
    version: 2,
    users: db.prepare('SELECT id, username, role, name, active FROM users').all(),
    products: db.prepare('SELECT * FROM products').all(),
    customers: db.prepare('SELECT * FROM customers').all(),
    sales: db.prepare('SELECT * FROM sales').all(),
    sale_items: db.prepare('SELECT * FROM sale_items').all(),
    shifts: db.prepare('SELECT * FROM shifts').all(),
    settings: getSettings(db),
    suppliers: db.prepare('SELECT * FROM suppliers ORDER BY id').all(),
    purchases: db.prepare('SELECT * FROM purchases ORDER BY id').all(),
    purchase_items: db.prepare('SELECT * FROM purchase_items ORDER BY id').all(),
    supplier_payments: db.prepare('SELECT * FROM supplier_payments ORDER BY id').all(),
    stocktakes: db.prepare('SELECT * FROM stocktakes ORDER BY id').all(),
    stocktake_items: db.prepare('SELECT * FROM stocktake_items ORDER BY id').all(),
    subscription: db.prepare('SELECT * FROM subscriptions WHERE id = 1').get() || null,
    subscription_events: db.prepare('SELECT * FROM subscription_events ORDER BY id').all(),
    audit_log: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
  };
}

function stamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** Write backups/backup-YYYYMMDD-HHMMSS.json.gz and return its metadata. */
function createBackup(db, dir, getSettings, date = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const base = `backup-${stamp(date)}`;
  let file = path.join(dir, `${base}.json.gz`);
  let suffix = 1;
  while (fs.existsSync(file)) file = path.join(dir, `${base}-${suffix++}.json.gz`);
  const payload = dumpDatabase(db, getSettings);
  const raw = Buffer.from(JSON.stringify(payload));
  const gz = zlib.gzipSync(raw, { level: 9 });
  fs.writeFileSync(file, gz);
  return { file: path.basename(file), path: file, bytes: gz.length, rawBytes: raw.length, exported_at: payload.exported_at };
}

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => FILE_RE.test(name))
    .map(name => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      const m = FILE_RE.exec(name);
      const d = m[1];
      return {
        file: name,
        bytes: stat.size,
        created_at: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`,
        mtime: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Keep the newest `keep` snapshots, delete the rest. Returns removed names. */
function pruneBackups(dir, keep = 7) {
  const files = listBackups(dir);
  const limit = Math.max(1, Number(keep) || 1);
  const removed = [];
  for (const entry of files.slice(limit)) {
    try { fs.unlinkSync(path.join(dir, entry.file)); removed.push(entry.file); } catch { /* ignore */ }
  }
  return removed;
}

/**
 * Start the daily timer. Runs one backup right away when the newest snapshot is
 * older than the interval (or when none exists yet).
 */
function startScheduler({ db, dir, intervalHours = 24, keep = 7, getSettings, log, onBackup }) {
  const intervalMs = Math.max(0.05, Number(intervalHours) || 24) * 3600 * 1000;
  let timer = null;

  const run = reason => {
    try {
      const info = createBackup(db, dir, getSettings);
      const removed = pruneBackups(dir, keep);
      log?.info('backup created', { file: info.file, bytes: info.bytes, reason, pruned: removed.length });
      if (typeof onBackup === 'function') {
        // Off-site upload is best effort: never block or fail the local backup.
        Promise.resolve()
          .then(() => onBackup(info, reason))
          .catch(e => log?.error('off-site backup hook failed', { error: e.message }));
      }
      return info;
    } catch (e) {
      log?.error('backup failed', { reason, error: e.message });
      return null;
    }
  };

  const newest = listBackups(dir)[0];
  if (!newest || Date.now() - newest.mtime >= intervalMs) run('startup');

  timer = setInterval(() => run('scheduled'), intervalMs);
  timer.unref?.();

  return { stop: () => clearInterval(timer), run, dir, keep, intervalHours };
}

/**
 * Encrypt a fresh dump and push it to an operator-configured endpoint
 * (any HTTPS endpoint that accepts PUT/POST with a binary body — object
 * storage, a webhook, an S3-compatible gateway, …).
 */
async function uploadOffsite({
  db, getSettings, passphrase, url, token = '', method = 'PUT',
  fetchImpl = globalThis.fetch, log, attempts = 3,
} = {}) {
  if (!url) return { ok: false, skipped: true, reason: 'NOT_CONFIGURED' };
  if (!passphrase) return { ok: false, skipped: true, reason: 'NO_KEY' };
  let payload;
  const file = `backup-${stamp()}.posbak`;
  try {
    payload = packBackup(dumpDatabase(db, getSettings), passphrase);
  } catch (e) {
    log?.error('off-site backup encryption failed', { error: e.message });
    return { ok: false, error: e.message, file };
  }
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: String(method || 'PUT').toUpperCase(),
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(payload.length),
          'X-Backup-Name': file,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: payload,
      });
      if (res.ok) return { ok: true, status: res.status, file, bytes: payload.length };
      lastError = `HTTP ${res.status}`;
      // 4xx will not improve on retry (bad URL or token).
      if (res.status < 500) break;
    } catch (e) {
      lastError = e.message;
    }
    if (attempt < attempts) await new Promise(r => setTimeout(r, 400 * attempt));
  }
  return { ok: false, error: lastError || 'UPLOAD_FAILED', file, bytes: payload.length };
}

module.exports = { dumpDatabase, createBackup, listBackups, pruneBackups, startScheduler, uploadOffsite, stamp, FILE_RE };
