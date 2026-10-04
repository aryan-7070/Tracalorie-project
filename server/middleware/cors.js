'use strict';

/**
 * CORS allowlist.
 *
 * The previous configuration was `cors()`, which reflects any origin and
 * allows credentialed requests — the textbook setup for cross-origin token
 * theft. This replaces it with an explicit allowlist.
 *
 * Requests from an unlisted origin are refused outright (403) rather than
 * silently stripped of CORS headers. Stripping is the spec-correct behaviour
 * for non-browser clients, but 403 is unambiguous for operators debugging a
 * misconfigured deploy, and no browser can act on the refused response anyway.
 */

const config = require('../config/env');
const { logger } = require('../lib/logger');

const allowed = new Set(config.cors.origins);

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;

  // Same-origin and non-browser clients (curl, health probes, server-to-server)
  // send no Origin header. Nothing to negotiate.
  if (!origin) return next();

  // Normalise trailing slash so config formatting mistakes do not silently
  // reject a legitimate origin.
  const normalised = String(origin).replace(/\/+$/, '');

  if (!allowed.has(normalised)) {
    logger.warn('CORS origin rejected', {
      origin: normalised,
      path: req.path,
      requestId: req.id,
    });
    return res.status(403).json({
      error: { code: 'origin_not_allowed', message: 'Origin is not allowed' },
    });
  }

  res.setHeader('Access-Control-Allow-Origin', normalised);
  // Explicit, not `*` — required for credentialed requests.
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type,X-CSRF-Token,X-Request-ID,Authorization'
    );
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID,RateLimit-Remaining,RateLimit-Reset');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.sendStatus(204);
  }

  return next();
}

module.exports = { corsMiddleware, allowedOrigins: [...allowed] };
