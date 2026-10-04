'use strict';

/**
 * Environment configuration.
 *
 * Validated once at import time. The process refuses to start on missing or
 * unsafe configuration rather than booting in a half-secured state.
 */

const crypto = require('crypto');

// Load .env here rather than in each entry point, so every process that reads
// configuration gets it. dotenv never overwrites a variable that is already set
// in the real environment, which is what keeps container and CI secrets
// authoritative over a stray file checked out on disk.
require('dotenv').config();

const PLACEHOLDER_SECRETS = [
  'change-me',
  'changeme',
  'secret',
  'your-secret-key',
  'your-secret-key-here',
  'your-secret-key-change-this-in-production',
];

const isProduction = process.env.NODE_ENV === 'production';

function fail(errors) {
  const detail = errors.map((e) => `  - ${e}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${detail}`);
}

function requireSecret(name, { minLength = 32 } = {}) {
  const value = process.env[name];

  if (!value) {
    fail([`${name} is required`]);
  }

  if (value.length < minLength) {
    fail([`${name} must be at least ${minLength} characters (got ${value.length})`]);
  }

  const lowered = value.toLowerCase();
  if (PLACEHOLDER_SECRETS.some((p) => lowered.includes(p))) {
    fail([`${name} still contains a placeholder value`]);
  }

  if (isProduction && value === value.split('').reverse().join('')) {
    fail([`${name} looks like a trivial pattern`]);
  }

  return value;
}

function parseOrigins(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function parsePositiveInt(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    fail([`${name} must be a positive integer (got "${raw}")`]);
  }
  return n;
}

function build() {
  const errors = [];

  const nodeEnv = process.env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    errors.push(`NODE_ENV must be development|test|production (got "${nodeEnv}")`);
  }
  const production = nodeEnv === 'production';

  // In tests we fall back to a fixed dev-only secret so the suite is
  // reproducible. In production this is a hard failure.
  let jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret && nodeEnv === 'test') {
    jwtSecret = 'test-only-secret-do-not-use-outside-tests-000000';
  }

  const config = {
    nodeEnv,
    isProduction: production,
    isTest: nodeEnv === 'test',
    port: parsePositiveInt('PORT', process.env.PORT, 5000),
    logLevel: process.env.LOG_LEVEL || (production ? 'info' : 'debug'),

    jwt: {
      secret: null,
      issuer: 'tracalorie',
      audience: 'tracalorie-web',
      accessTtlSeconds: parsePositiveInt(
        'ACCESS_TOKEN_TTL_SECONDS',
        process.env.ACCESS_TOKEN_TTL_SECONDS,
        15 * 60
      ),
    },

    // Field-level encryption key for PII at rest. Must be 32 bytes, hex or
    // base64 encoded, or a passphrase we derive from with scrypt.
    pii: {
      key: process.env.PII_ENCRYPTION_KEY || null,
      keyIsExplicit: Boolean(process.env.PII_ENCRYPTION_KEY),
    },

    // Blind index key: HMAC over normalised identifiers so we can enforce
    // uniqueness on encrypted columns without decrypting the whole table.
    blindIndexKey: process.env.BLIND_INDEX_KEY || null,

    db: {
      host: process.env.PGHOST || 'localhost',
      port: parsePositiveInt('PGPORT', process.env.PGPORT, 5432),
      database: process.env.PGDATABASE || 'tracalorie',
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || null,
      ssl: process.env.PGSSLMODE === 'require' || process.env.PGSSLMODE === 'verify-full',
      sslRejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false',
      max: parsePositiveInt('PGPOOL_MAX', process.env.PGPOOL_MAX, 10),
      connectionTimeoutMillis: parsePositiveInt(
        'PG_CONNECT_TIMEOUT_MS',
        process.env.PG_CONNECT_TIMEOUT_MS,
        10_000
      ),
      statementTimeoutMillis: parsePositiveInt(
        'PG_STATEMENT_TIMEOUT_MS',
        process.env.PG_STATEMENT_TIMEOUT_MS,
        15_000
      ),
    },

    cors: {
      // Explicit allowlist. Empty + production is a fatal misconfiguration.
      origins: parseOrigins(process.env.CORS_ORIGINS),
      credentials: true,
    },

    cookies: {
      // Prefix cookies with __Host- in production: the browser then refuses to
      // send them over plaintext or from another host, killing subdomain
      // cookie-injection attacks.
      secure: process.env.COOKIE_SECURE
        ? process.env.COOKIE_SECURE === 'true'
        : production,
      prefix: process.env.COOKIE_PREFIX || (production ? '__Host-' : ''),
      sameSite: process.env.COOKIE_SAMESITE || 'strict',
      domain: process.env.COOKIE_DOMAIN || undefined,
    },

    password: {
      bcryptRounds: parsePositiveInt('BCRYPT_ROUNDS', process.env.BCRYPT_ROUNDS, 12),
      minLength: parsePositiveInt('PASSWORD_MIN_LENGTH', process.env.PASSWORD_MIN_LENGTH, 12),
      maxLength: 256,
      // bcrypt silently truncates at 72 bytes; reject longer input explicitly
      // rather than letting two different passwords hash to the same digest.
      bcryptMaxBytes: 72,
      historyDepth: 5,
    },

    lockout: {
      threshold: parsePositiveInt('LOGIN_LOCKOUT_THRESHOLD', process.env.LOGIN_LOCKOUT_THRESHOLD, 5),
      baseDelaySeconds: parsePositiveInt('LOGIN_LOCKOUT_BASE_SECONDS', process.env.LOGIN_LOCKOUT_BASE_SECONDS, 30),
      maxDelaySeconds: parsePositiveInt('LOGIN_LOCKOUT_MAX_SECONDS', process.env.LOGIN_LOCKOUT_MAX_SECONDS, 3600),
    },

    session: {
      refreshTtlSeconds: parsePositiveInt(
        'REFRESH_TOKEN_TTL_SECONDS',
        process.env.REFRESH_TOKEN_TTL_SECONDS,
        30 * 24 * 60 * 60
      ),
      absoluteLifetimeSeconds: parsePositiveInt(
        'SESSION_ABSOLUTE_LIFETIME_SECONDS',
        process.env.SESSION_ABSOLUTE_LIFETIME_SECONDS,
        90 * 24 * 60 * 60
      ),
      revokeFamilyOnReuse: true,
    },

    rateLimit: {
      global: {
        windowMs: parsePositiveInt('RATE_LIMIT_GLOBAL_WINDOW_MS', process.env.RATE_LIMIT_GLOBAL_WINDOW_MS, 60_000),
        max: parsePositiveInt('RATE_LIMIT_GLOBAL_MAX', process.env.RATE_LIMIT_GLOBAL_MAX, 300),
      },
      auth: {
        windowMs: parsePositiveInt('RATE_LIMIT_AUTH_WINDOW_MS', process.env.RATE_LIMIT_AUTH_WINDOW_MS, 15 * 60_000),
        max: parsePositiveInt('RATE_LIMIT_AUTH_MAX', process.env.RATE_LIMIT_AUTH_MAX, 10),
      },
      write: {
        windowMs: parsePositiveInt('RATE_LIMIT_WRITE_WINDOW_MS', process.env.RATE_LIMIT_WRITE_WINDOW_MS, 60_000),
        max: parsePositiveInt('RATE_LIMIT_WRITE_MAX', process.env.RATE_LIMIT_WRITE_MAX, 60),
      },
    },

    cloud: {
      // Optional Google Cloud Storage bucket for user-requested data exports.
      // Absent => exports are returned inline instead of uploaded.
      gcsBucket: process.env.GCS_EXPORT_BUCKET || null,
      exportKeyPrefix: process.env.GCS_EXPORT_PREFIX || 'exports',
      encryptionKeyName: process.env.GCS_KMS_KEY || null,
    },

    bodyLimit: process.env.BODY_LIMIT || '16kb',
    trustProxy: process.env.TRUST_PROXY || (production ? '1' : 'false'),
  };

  // --- Secret validation -------------------------------------------------

  if (nodeEnv === 'test') {
    config.jwt.secret = jwtSecret;
    config.pii.key = config.pii.key || crypto.createHash('sha256').update('test-pii-key').digest('hex');
    config.blindIndexKey = config.blindIndexKey || 'test-blind-index-key';
  } else {
    try {
      config.jwt.secret = requireSecret('JWT_SECRET', { minLength: 32 });
    } catch (err) {
      if (!jwtSecret) errors.push('JWT_SECRET is required (generate with: openssl rand -base64 48)');
    }

    try {
      requireSecret('PII_ENCRYPTION_KEY', { minLength: 32 });
    } catch (err) {
      if (!process.env.PII_ENCRYPTION_KEY) {
        errors.push('PII_ENCRYPTION_KEY is required (generate with: openssl rand -hex 32)');
      }
    }

    try {
      requireSecret('BLIND_INDEX_KEY', { minLength: 32 });
    } catch (err) {
      if (!process.env.BLIND_INDEX_KEY) {
        errors.push('BLIND_INDEX_KEY is required (generate with: openssl rand -base64 48)');
      }
    }
  }

  if (errors.length) fail(errors);

  // --- Cross-field invariants -------------------------------------------

  if (config.pii.keyIsExplicit && config.pii.key.length < 32) {
    fail(['PII_ENCRYPTION_KEY must be at least 32 characters']);
  }

  if (config.isProduction) {
    if (config.cors.origins.length === 0) {
      fail(['CORS_ORIGINS is required in production (comma-separated allowlist)']);
    }
    if (config.cors.origins.some((o) => o === '*')) {
      fail(['CORS_ORIGINS must not contain "*" in production']);
    }
    if (!config.cookies.secure) {
      fail(['COOKIE_SECURE must be true in production']);
    }
    if (!config.db.ssl) {
      fail(['PGSSLMODE must be require or verify-full in production']);
    }
    if (!config.db.password) {
      fail(['PGPASSWORD is required in production']);
    }
  }

  if (config.password.bcryptRounds < 10) {
    fail(['BCRYPT_ROUNDS must be at least 10']);
  }

  return Object.freeze(config);
}

module.exports = build();
