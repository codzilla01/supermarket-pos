'use strict';
/**
 * Automatic database backups: gzipped JSON snapshots on disk with retention.
 * No cron, no dependencies — a timer inside the POS process plus the same dump
 * the manual "export backup" button uses, so a restore is always possible.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
function startScheduler({ db, dir, intervalHours = 24, keep = 7, getSettings, log }) {
  const intervalMs = Math.max(0.05, Number(intervalHours) || 24) * 3600 * 1000;
  let timer = null;

  const run = reason => {
    try {
      const info = createBackup(db, dir, getSettings);
      const removed = pruneBackups(dir, keep);
      log?.info('backup created', { file: info.file, bytes: info.bytes, reason, pruned: removed.length });
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

module.exports = { dumpDatabase, createBackup, listBackups, pruneBackups, startScheduler, stamp, FILE_RE };
