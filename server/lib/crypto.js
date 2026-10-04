'use strict';

/**
 * Cryptographic primitives.
 *
 *  - AES-256-GCM for field-level encryption of PII at rest.
 *  - HMAC-SHA-256 "blind index" so encrypted columns stay uniquely searchable
 *    without ever decrypting the table.
 *  - Opaque token generation + SHA-256 storage for refresh tokens.
 *  - Timing-safe comparison everywhere.
 *
 * Design notes
 * ------------
 * Each ciphertext is bound to its column via an authenticated AAD parameter, so
 * a value lifted from `users.email_enc` cannot be replayed into
 * `users.display_name_enc` without the authentication tag failing. Every
 * ciphertext embeds its own random 96-bit IV, and the GCM tag is checked on
 * read — tampering is detected, not silently decrypted.
 */

const crypto = require('crypto');
const config = require('../config/env');
const { internal } = require('./errors');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit, GCM-recommended
const TAG_BYTES = 16;
const VERSION = 'v1';

let cachedKey;

/** Resolve the 32-byte data key. Hex/base64 pass through; passphrases derive. */
function dataKey() {
  if (cachedKey) return cachedKey;

  const raw = config.pii.key;
  if (!raw) {
    throw internal('PII encryption key is not configured', 'encryption_key_missing');
  }

  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) cachedKey = decoded;
  }

  if (!cachedKey) {
    // Deterministic derivation so restarts can still read existing rows.
    // A dedicated random key is strongly preferred; scrypt is the safety net
    // for operators who paste a human-readable secret.
    cachedKey = crypto.scryptSync(raw, 'tracalorie.pii.v1', 32);
  }

  return cachedKey;
}

let cachedBlindKey;
function blindKey() {
  if (cachedBlindKey) return cachedBlindKey;
  const raw = config.blindIndexKey;
  if (!raw) {
    throw internal('Blind index key is not configured', 'blind_index_key_missing');
  }
  cachedBlindKey = /^[a-fA-F0-9]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'utf8');
  return cachedBlindKey;
}

/**
 * Encrypt a UTF-8 string.
 * @param {string} plaintext
 * @param {string} aad  column/context name, authenticated but not encrypted
 * @returns {string} `v1:<iv>:<tag>:<ciphertext>` all base64url
 */
function encrypt(plaintext, aad) {
  if (plaintext === null || plaintext === undefined) return null;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, dataKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Decrypt a value produced by `encrypt`. Throws on tamper or AAD mismatch.
 * @returns {string|null}
 */
function decrypt(payload, aad) {
  if (payload === null || payload === undefined || payload === '') return null;

  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw internal('Malformed ciphertext', 'decrypt_failed');
  }

  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw internal('Malformed ciphertext', 'decrypt_failed');
  }

  try {
    const decipher = crypto.createDecipheriv(ALGO, dataKey(), iv);
    if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong AAD, or modified bytes. Indistinguishable by design.
    throw internal('Unable to decrypt value', 'decrypt_failed');
  }
}

/**
 * Normalise an identifier before hashing so `Alice@x.com`, `alice@x.com` and
 * ` alice@x.com ` collapse to one blind-index value.
 */
function normaliseIdentifier(value) {
  return String(value).trim().toLowerCase();
}

/**
 * Deterministic, non-reversible lookup key for an encrypted column.
 * Lets us enforce `UNIQUE` on ciphertext and query by email without decryption.
 */
function blindIndex(value, domain = 'default') {
  return crypto
    .createHmac('sha256', blindKey())
    .update(`${domain}\u0000${normaliseIdentifier(value)}`, 'utf8')
    .digest('base64url');
}

/** Cryptographically random opaque token, URL-safe. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** UUID v4 for ids we surface to clients. */
function uuid() {
  return crypto.randomUUID();
}

/**
 * Refresh tokens are high-entropy random values, so a fast hash is correct
 * here: there is no dictionary to attack, and SHA-256 keeps lookup O(1) on the
 * hot auth path. Passwords, which are low-entropy, use bcrypt instead.
 */
function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Constant-time string compare that does not leak length via early return. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform a comparison so timing does not reveal the mismatch.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** SHA-256 digest, hex. Used for the audit log hash chain. */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Structured clone-ish deep equality for canonical JSON serialisation. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

module.exports = {
  encrypt,
  decrypt,
  blindIndex,
  normaliseIdentifier,
  randomToken,
  uuid,
  tokenFingerprint,
  safeEqual,
  sha256Hex,
  canonicalJson,
};
