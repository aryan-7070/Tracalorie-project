'use strict';

/**
 * Structured JSON logging.
 *
 * Emits newline-delimited JSON on stdout, which is what every log aggregator
 * (Google Cloud Logging, Datadog, CloudWatch) ingests natively. In development
 * we render a compact human-readable line instead.
 *
 * Redaction is enforced here rather than at call sites: a secret that reaches
 * a log line must never leave the process.
 */

const config = require('../config/env');

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

const activeLevel = LEVELS[config.logLevel] ?? LEVELS.info;

const REDACTED = '[redacted]';

// Anything matching these keys is replaced wholesale, at any depth.
const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'tokenhash',
  'csrftoken',
  'authorization',
  'cookie',
  'setcookie',
  'secret',
  'jwtsecret',
  'piiencryptionkey',
  'blindindexkey',
  'apikey',
  'x-api-key',
  'privatekey',
  'ssn',
  'creditcard',
  'pan',
]);

// Free-text values that look like credentials get scrubbed even under an
// innocuous key, since audit details are frequently free-form.
const SECRET_VALUE_PATTERNS = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b[A-Fa-f0-9]{64,}\b/g, // long hex (token/sha hashes)
];

function normaliseKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function redactString(value) {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[depth-limit]';

  const t = typeof value;
  if (t === 'string') return redactString(value);
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return value.toString();
  if (t === 'function') return '[function]';
  if (t === 'symbol') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactError(value, depth);

  if (Array.isArray(value)) {
    const limit = 50;
    const mapped = value.slice(0, limit).map((v) => redact(v, depth + 1));
    if (value.length > limit) mapped.push(`[+${value.length - limit} more]`);
    return mapped;
  }

  if (t === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(normaliseKey(k)) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }

  return String(value);
}

function redactError(err, depth = 0) {
  return {
    name: err.name,
    message: redactString(err.message),
    code: err.code,
    // Stack traces can leak absolute paths and, in dev, source context.
    // Only emitted outside production.
    ...(config.isProduction ? {} : { stack: err.stack }),
    ...(err.details ? { details: redact(err.details, depth + 1) } : {}),
  };
}

const COLOURS = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[35m',
};

function write(stream, level, message, fields) {
  if ((LEVELS[level] ?? 0) < activeLevel) return;

  if (config.isProduction || !process.stderr.isTTY) {
    const record = {
      severity: level.toUpperCase(),
      time: new Date().toISOString(),
      message: redactString(String(message)),
      service: 'tracalorie-api',
      env: config.nodeEnv,
      ...(fields ? redact(fields) : {}),
    };
    stream.write(`${JSON.stringify(record)}\n`);
    return;
  }

  const ts = new Date().toISOString().slice(11, 23);
  const colour = COLOURS[level] || '';
  const extras = fields && Object.keys(fields).length ? ` ${JSON.stringify(redact(fields))}` : '';
  stream.write(`${colour}${ts} ${level.toUpperCase().padEnd(5)}\x1b[0m ${message}${extras}\n`);
}

function makeLogger(bindings = {}) {
  const bound = { ...bindings };
  const api = {};
  for (const level of Object.keys(LEVELS)) {
    api[level] = (message, fields) =>
      write(process.stderr, level, message, { ...bound, ...(fields || {}) });
  }
  api.child = (extra) => makeLogger({ ...bound, ...extra });
  return api;
}

const logger = makeLogger();

module.exports = { logger, redact, redactString, SENSITIVE_KEYS };
