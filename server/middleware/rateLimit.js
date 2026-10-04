'use strict';

/**
 * Rate limiting.
 *
 * Two layers, because they defend against different attacks:
 *
 *   1. Per-IP limits (this file) bound total request volume. In-memory per
 *      instance, which is fast and cannot itself be used to amplify load
 *      against the database. Cost: limits reset on deploy and are per-instance,
 *      so a horizontally scaled deployment is N times more permissive. In
 *      production the edge (Cloud Armor / WAF / CDN rate rules) enforces the
 *      global budget; this is the application-level backstop. See
 *      docs/THREAT_MODEL.md for the full argument.
 *
 *   2. Per-account progressive lockout (lib/auth.js) is persisted in Postgres
 *      and is the real defence against distributed credential stuffing, where
 *      each attempt arrives from a different IP and layer 1 never fires.
 *
 * Successful requests are not counted on credential endpoints: a legitimate
 * user who logs in correctly several times in a row must never be locked out,
 * while failures accumulate.
 */

const rateLimit = require('express-rate-limit');
const config = require('../config/env');
const { logger } = require('../lib/logger');
const { tooManyRequests } = require('../lib/errors');
const { clientIp } = require('./clientIp');

function handlerFor(scope) {
  return (req, res, next, options) => {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(((options?.windowMs ?? 60_000) - (Date.now() - options?.request?.startedAt ?? Date.now())) / 1000)
    );

    res.setHeader('Retry-After', retryAfterSeconds);

    // Rate-limit rejections are security events, not routine 4xx noise, so
    // they are recorded in the audit chain. Fire-and-forget: never let the
    // audit write delay or fail the 429.
    const { record, EVENTS } = require('../lib/audit');
    record({
      action: EVENTS.RATE_LIMIT_TRIPPED,
      outcome: 'failure',
      actorId: req.user?.id ?? null,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      requestId: req.id,
      details: { scope, path: req.path },
    }).catch(() => {});

    logger.warn('rate_limit.exceeded', {
      scope,
      ip: clientIp(req),
      path: req.path,
      requestId: req.id,
    });

    next(
      tooManyRequests(
        'Too many requests. Please slow down and try again shortly.',
        'rate_limited',
        { scope, retryAfterSeconds }
      )
    );
  };
}

/** Standard rate-limit options with the responses we want to emit. */
function build({ windowMs, max, scope, keyFn, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7', // RateLimit-Limit / -Remaining / -Reset
    legacyHeaders: false,
    // Key on authenticated user when available so a shared NAT egress IP does
    // not cause one user to exhaust everyone's budget.
    keyGenerator: keyFn || ((req) => req.user?.id ?? clientIp(req)),
    skipSuccessfulRequests,
    handler: handlerFor(scope),
    // A failed limit lookup must not disable protection.
    skipFailedRequests: false,
  });
}

/** Broad ceiling: stops a single client from monopolising the process. */
const globalLimiter = build({
  ...config.rateLimit.global,
  scope: 'global',
});

/** Credential endpoints: the primary brute-force surface. */
const authLimiter = build({
  ...config.rateLimit.auth,
  scope: 'auth',
  // Key on the submitted identifier where present, so one attacker cannot burn
  // the budget of every other user behind the same IP.
  keyFn: (req) => {
    const identifier =
      (req.body && (req.body.username || req.body.email)) || req.params?.username;
    if (identifier && String(identifier).length <= 200) {
      return `id:${String(identifier).toLowerCase()}`;
    }
    return `ip:${clientIp(req)}`;
  },
  skipSuccessfulRequests: true,
});

/** Tighter budget for the login route specifically. */
const loginLimiter = build({
  windowMs: config.rateLimit.auth.windowMs,
  max: Math.max(5, Math.floor(config.rateLimit.auth.max / 2)),
  scope: 'login',
  keyFn: (req) => {
    const identifier = req.body?.username || req.body?.email;
    if (identifier && String(identifier).length <= 200) {
      return `id:${String(identifier).toLowerCase()}`;
    }
    return `ip:${clientIp(req)}`;
  },
  skipSuccessfulRequests: true,
});

/** Token refresh: unauthenticated, so bounded tightly. */
const refreshLimiter = build({
  windowMs: config.rateLimit.auth.windowMs,
  max: Math.max(10, config.rateLimit.auth.max),
  scope: 'refresh',
  keyFn: (req) => `ip:${clientIp(req)}`,
});

/** State-changing endpoints for authenticated users. */
const writeLimiter = build({
  ...config.rateLimit.write,
  scope: 'write',
});

/** Expensive aggregate/analytics endpoints. */
const heavyLimiter = build({
  windowMs: 60_000,
  max: 30,
  scope: 'heavy',
});

module.exports = {
  globalLimiter,
  authLimiter,
  loginLimiter,
  refreshLimiter,
  writeLimiter,
  heavyLimiter,
};
