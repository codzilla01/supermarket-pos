'use strict';
/**
 * Minimal structured logger (zero dependencies).
 * Default human-readable lines; set POS_LOG_FORMAT=json for one JSON object per
 * line (what log shippers expect), POS_LOG_LEVEL=debug|info|warn|error to filter.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.POS_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const asJson = ['json', 'ndjson', 'structured'].includes(String(process.env.POS_LOG_FORMAT || '').toLowerCase());

function formatValue(value) {
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  return JSON.stringify(value);
}

function write(level, message, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = asJson
    ? JSON.stringify({ ts, level, msg: message, ...fields })
    : `[${ts}] ${level.toUpperCase().padEnd(5)} ${message}${Object.keys(fields).length ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${formatValue(v)}`).join(' ') : ''}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  try { stream.write(line + '\n'); } catch { /* logging must never crash the till */ }
}

module.exports = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
  isJson: () => asJson,
};
