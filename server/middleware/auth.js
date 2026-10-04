'use strict';

/**
 * Request authentication and CSRF defence.
 *
 * Tokens live in httpOnly cookies rather than localStorage. This removes token
 * theft via XSS entirely: injected script cannot read a cookie the browser
 * withholds from JavaScript. (It can still *send* the cookie, which is why CSRF
 * protection below is mandatory, not optional.)
 *
 * Cookie attributes, and what each one stops:
 *   httpOnly            — JS cannot read the token (stops XSS exfiltration)
 *   Secure              — never sent over plaintext HTTP (stops network sniffing)
 *   SameSite=Strict     — not sent on cross-site requests at all (first line of
 *                         CSRF defence, independent of the token below)
 *   __Host- prefix      — browser refuses to accept the cookie unless it is
 *                         Secure, has no Domain attribute, and has Path=/.
 *                         This defeats subdomain cookie-injection, where an
 *                         attacker-controlled subdomain sets a cookie for the
 *                         parent domain.
 *
 * CSRF: SameSite=Strict already blocks the overwhelming majority of CSRF. The
 * double-submit token below is defence in depth for the residual cases — a
 * compromised same-site subdomain, or a browser that treats SameSite loosely.
 * The attacker cannot read the cookie to copy it into the header, so they cannot
 * forge the request.
 */

const crypto = require('../lib/crypto');
const config = require('../config/env');
const { verifyAccessToken, cookieName, COOKIE_ACCESS, COOKIE_CSRF } = require('../lib/sessions');
const { query } = require('../db');
const { unauthorized, forbidden } = require('../lib/errors');
const { clientIp, deviceLabel } = require('./clientIp');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Attach a CSRF cookie if absent. Runs on every request so a fresh tab always
 * has a token to echo.
 */
function issueCsrfCookie(req, res, next) {
  let token = req.cookies?.[cookieName(COOKIE_CSRF)];

  if (!token || !/^[A-Za-z0-9_-]{32,64}$/.test(token)) {
    token = crypto.randomToken(32);
    res.cookie(cookieName(COOKIE_CSRF), token, {
      ...{
        httpOnly: false, // deliberately readable: the client must echo it
        secure: config.cookies.secure,
        sameSite: config.cookies.samesite,
        path: '/',
      },
      ...(config.cookies.domain ? { domain: config.cookies.domain } : {}),
      maxAge: config.session.refreshTtlSeconds * 1000,
    });
    // Make it visible to this request too, so a client that reads the cookie
    // before the response lands does not see a stale value.
    req.cookies = { ...(req.cookies || {}), [cookieName(COOKIE_CSRF)]: token };
  }

  req.csrfToken = token;
  next();
}

/** Double-submit cookie verification for state-changing methods. */
function verifyCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const cookieToken = req.cookies?.[cookieName(COOKIE_CSRF)];
  const headerToken = req.get('x-csrf-token') || req.get('x-xsrf-token');

  if (!cookieToken || !headerToken) {
    return next(
      forbidden('Missing CSRF token', 'csrf_failed')
    );
  }

  if (!crypto.safeEqual(cookieToken, headerToken)) {
    return next(forbidden('Invalid CSRF token', 'csrf_failed'));
  }

  return next();
}

/**
 * Require a valid access token.
 *
 * The token is a stateless JWT, but it is checked against session and account
 * state on every request. That costs one indexed lookup and buys immediate
 * revocation: logging out, changing a password, or detecting reuse takes effect
 * now rather than when the 15-minute token expires.
 */
async function requireAuth(req, res, next) {
  const header = req.get('authorization');
  const cookieToken = req.cookies?.[cookieName(COOKIE_ACCESS)];

  // Accept the cookie as the primary channel. A Bearer header remains supported
  // for non-browser clients (mobile, CLI, integration tests).
  const token = cookieToken || (header?.startsWith('Bearer ') ? header.slice(7) : null);

  if (!token) {
    return next(unauthorized('Authentication required', 'no_credentials'));
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      // Distinct code so the client knows to refresh rather than log out.
      return next(unauthorized('Access token expired', 'token_expired'));
    }
    return next(unauthorized('Invalid access token', 'token_invalid'));
  }

  try {
    const { rows } = await query(
      `SELECT u.id, u.username, u.calorie_limit, u.units, u.timezone, u.status,
              u.token_epoch, u.email_enc, u.display_name_enc,
              s.session_uuid, s.family_id, s.revoked_at, s.absolute_expires_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.session_uuid = $1`,
      [payload.sid]
    );

    const row = rows[0];

    if (!row) {
      return next(unauthorized('Session not found', 'session_invalid'));
    }

    if (row.revoked_at) {
      return next(unauthorized('Session has been revoked', 'session_revoked'));
    }

    if (new Date(row.absolute_expires_at).getTime() <= Date.now()) {
      return next(unauthorized('Session has expired', 'session_expired'));
    }

    if (row.status !== 'active') {
      return next(forbidden('Account is not active', 'account_inactive'));
    }

    // Epoch mismatch => password changed or "log out everywhere" since this
    // token was minted.
    if (Number(payload.epoch) !== Number(row.token_epoch)) {
      return next(unauthorized('Session is no longer valid', 'token_epoch_mismatch'));
    }

    req.user = {
      id: row.id,
      username: row.username,
      calorieLimit: row.calorie_limit,
      units: row.units,
      timezone: row.timezone,
      emailEnc: row.email_enc,
      displayNameEnc: row.display_name_enc,
    };
    req.session = {
      uuid: row.session_uuid,
      familyId: row.family_id,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

/** Attach `req.user` when credentials are present, but never reject. */
async function optionalAuth(req, res, next) {
  if (!req.cookies?.[cookieName(COOKIE_ACCESS)] && !req.get('authorization')) {
    return next();
  }
  return requireAuth(req, res, (err) => next(err && err.status === 401 ? null : err));
}

/** Wrap an async handler so rejections reach the error handler. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = {
  requireAuth,
  optionalAuth,
  verifyCsrf,
  issueCsrfCookie,
  asyncHandler,
  clientIp,
  deviceLabel,
};
