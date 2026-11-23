'use strict';
/**
 * Encrypted off-site backup container (zero dependencies, node:crypto only).
 *
 * Layout:  "POSBAK01" | version(1) | salt(16) | iv(12) | tag(16) | AES-256-GCM(gzip(json))
 *
 * The key is never stored in the file: it comes from POS_BACKUP_ENCRYPTION_KEY
 * (or an operator-supplied passphrase for `scripts/restore-backup.js`), so an
 * uploaded copy is useless to anyone who only has the storage bucket.
 */
const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = Buffer.from('POSBAK01', 'ascii');
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const MIN_KEY_LENGTH = 16;

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 16384, r: 8, p: 1 });
}

function assertKey(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_KEY_LENGTH) throw new Error('BACKUP_KEY_TOO_SHORT');
}

/** Encrypt raw bytes. Returns the self-describing container. */
function encrypt(buffer, passphrase) {
  assertKey(passphrase);
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, cipher.getAuthTag(), body]);
}

function isEncrypted(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > MAGIC.length + 1 && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Decrypt a container; throws WRONG_KEY_OR_CORRUPT if the key or data is wrong. */
function decrypt(buffer, passphrase) {
  assertKey(passphrase);
  if (!isEncrypted(buffer)) throw new Error('NOT_AN_ENCRYPTED_BACKUP');
  const version = buffer[MAGIC.length];
  if (version !== VERSION) throw new Error('UNSUPPORTED_BACKUP_VERSION');
  const offset = MAGIC.length + 1;
  const salt = buffer.subarray(offset, offset + SALT_LEN);
  const iv = buffer.subarray(offset + SALT_LEN, offset + SALT_LEN + IV_LEN);
  const tag = buffer.subarray(offset + SALT_LEN + IV_LEN, offset + SALT_LEN + IV_LEN + TAG_LEN);
  const body = buffer.subarray(offset + SALT_LEN + IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('WRONG_KEY_OR_CORRUPT');
  }
}

/** Package a backup dump object as an encrypted, compressed container. */
function packBackup(dumpObject, passphrase) {
  return encrypt(zlib.gzipSync(Buffer.from(JSON.stringify(dumpObject), 'utf8'), { level: 9 }), passphrase);
}

/** Inverse of packBackup — returns the parsed dump object. */
function unpackBackup(buffer, passphrase) {
  return JSON.parse(zlib.gunzipSync(decrypt(buffer, passphrase)).toString('utf8'));
}

module.exports = { encrypt, decrypt, isEncrypted, packBackup, unpackBackup, MAGIC, VERSION, MIN_KEY_LENGTH };
