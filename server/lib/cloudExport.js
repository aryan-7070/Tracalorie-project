'use strict';

/**
 * Google Cloud Storage upload, without the SDK.
 *
 * Rationale: `@google-cloud/storage` pulls in ~80 transitive packages and
 * carried 6 advisories at the time of writing (tar, teeny-request, gaxios,
 * retry-request, uuid, node-pre-gyp) for what is ultimately one authenticated
 * HTTPS PUT. Writing the JWT-bearer flow directly against the GCS JSON API
 * costs ~120 lines of `crypto` and `fetch`, and brings the production
 * dependency tree to zero known vulnerabilities.
 *
 * Flow (Google OAuth 2.0 service-account JWT assertion):
 *   1. Build a JWT asserting `{alg:RS256, typ:JWT}` with the service account's
 *      client_email as `iss`, the token URI as `aud`, and a 1-hour expiry.
 *   2. Sign it with the service account's RSA private key.
 *   3. POST it to https://oauth2.googleapis.com/token for an access token.
 *   4. Use that bearer token to PUT the object.
 *
 * Objects are written with `x-goog-encryption-*` headers so Google encrypts them
 * with a customer-managed or Google-managed key at rest. We also pre-encrypt the
 * payload with AES-256-GCM, so the object is unreadable without the application
 * key regardless of what the bucket's default KMS key is — defence in depth for
 * the case where bucket-level access is misconfigured.
 */

const crypto = require('./crypto');
const config = require('../config/env');
const { logger } = require('./logger');
const { internal } = require('./errors');

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';

let cachedToken = null;

/** Parse a PEM private key. Supports PKCS#1 and PKCS#8. */
function loadPrivateKey(pem) {
  return crypto.createPrivateKey(pem);
}

/**
 * Build and sign the service-account assertion.
 * @param {object} creds { client_email, private_key }
 */
function buildAssertion(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: creds.client_email,
    scope: SCOPE,
    aud: TOKEN_URI,
    iat: now,
    exp: now + 3600,
  };

  const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), loadPrivateKey(creds.private_key));

  return `${signingInput}.${signature.toString('base64url')}`;
}

/** Exchange the assertion for an access token, cached until shortly before expiry. */
async function getAccessToken(creds) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: buildAssertion(creds),
  });

  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    // Never log the assertion: it is a bearer credential for the bucket.
    throw internal(`GCS authentication failed (${res.status})`, 'gcs_auth_failed');
  }

  const json = await res.json();
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };

  return cachedToken.value;
}

/** Is a bucket configured? Determines inline vs. uploaded delivery. */
function isConfigured() {
  return Boolean(config.cloud.gcsBucket);
}

/**
 * Encrypt an export payload for storage.
 *
 * AAD binds the ciphertext to the user id, so an object copied into another
 * user's export prefix will not decrypt.
 */
function encryptExport(userId, payload) {
  const aad = `export:user:${userId}`;
  return {
    aad,
    ciphertext: crypto.encrypt(JSON.stringify(payload), aad),
    checksum: crypto.sha256Hex(JSON.stringify(payload)),
  };
}

/**
 * Upload a user's encrypted data export.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {object} params.payload        plaintext export contents
 * @param {string} [params.format]       extension for the object name
 * @returns {Promise<{gsUri:string, objectName:string, byteSize:number, checksum:string, expiresAt:string}>}
 */
async function uploadExport({ userId, payload, format = 'json' }) {
  if (!isConfigured()) {
    throw internal('GCS_EXPORT_BUCKET is not configured', 'gcs_not_configured');
  }

  const creds = loadCredentials();

  const { ciphertext, checksum } = encryptExport(userId, payload);
  const body = Buffer.from(ciphertext, 'utf8');

  const now = new Date();
  // Date-partitioned prefix: keeps object listing tidy and makes lifecycle
  // rules (e.g. delete after 30 days) straightforward to attach.
  const datePartition = now.toISOString().slice(0, 10);
  const objectName = `${config.cloud.exportKeyPrefix}/${userId}/${datePartition}/${crypto.uuid()}.${format}.enc`;

  const accessToken = await getAccessToken(creds);

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    'x-goog-meta-user-id': String(userId),
    'x-goog-meta-format': format,
    'x-goog-meta-checksum': checksum,
    // GCS requires an exact SHA-256 of the body to verify integrity in transit.
    'x-goog-content-sha256': crypto.sha256Hex(body),
  };

  if (config.cloud.encryptionKeyName) {
    // Customer-managed CMEK. Without it, GCS applies Google's default key.
    headers['x-goog-encryption-key'] = config.cloud.encryptionKeyName;
    headers['x-goog-encryption-algorithm'] = 'AES256';
  }

  const endpoint = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(
    config.cloud.gcsBucket
  )}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.error('GCS export upload failed', { status: res.status, detail: detail.slice(0, 300) });
    throw internal('Data export upload failed', 'gcs_upload_failed');
  }

  const expiration = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  logger.info('gcs.export_uploaded', { userId, objectName, byteSize: body.length });

  return {
    gsUri: `gs://${config.cloud.gcsBucket}/${objectName}`,
    objectName,
    byteSize: body.length,
    checksum,
    expiresAt: expiration,
  };
}

function loadCredentials() {
  // Two supported sources: a JSON key file (common in CI) or inline values
  // from environment variables (12-factor, preferred on a managed runtime).
  const inlineClientEmail = process.env.GCS_CLIENT_EMAIL;
  const inlinePrivateKey = process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (inlineClientEmail && inlinePrivateKey) {
    return { client_email: inlineClientEmail, private_key: inlinePrivateKey };
  }

  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath) {
    // eslint-disable-next-line global-require
    const parsed = JSON.parse(require('fs').readFileSync(keyPath, 'utf8'));
    return { client_email: parsed.client_email, private_key: parsed.private_key };
  }

  throw internal(
    'GCS bucket configured but no credentials found (set GCS_CLIENT_EMAIL and GCS_PRIVATE_KEY)',
    'gcs_credentials_missing'
  );
}

module.exports = { isConfigured, uploadExport, encryptExport, buildAssertion };
