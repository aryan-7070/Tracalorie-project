'use strict';

/**
 * Client IP resolution.
 *
 * `req.ip` is only trustworthy when Express is told how many proxies sit in
 * front of the app. Getting this wrong is a security bug, not a cosmetic one:
 *
 *   - Too few hops  -> the proxy's IP is recorded, so every user shares one rate
 *                      limit bucket and per-account lockout looks like a
 *                      denial-of-service against one victim.
 *   - Too many hops -> a client can forge `X-Forwarded-For` and evade rate
 *                      limiting entirely.
 *
 * `TRUST_PROXY` therefore defaults to exactly 1 hop in production (the common
 * single load-balancer deployment) and is validated to reject ranges that are
 * too permissive.
 */

const config = require('../config/env');

function resolveTrustProxySetting() {
  const raw = config.trustProxy;

  if (raw === 'false') return false;
  if (raw === 'true') {
    // Trusting every hop means any client can spoof its address. Refused.
    if (config.isProduction) {
      throw new Error('TRUST_PROXY=true is refused in production: clients could spoof X-Forwarded-For.');
    }
    return true;
  }

  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new Error(`TRUST_PROXY must be false or an integer 0-5 (got "${raw}")`);
  }
  return hops;
}

const trustProxy = resolveTrustProxySetting();

/**
 * Best-effort client IP for audit records.
 *
 * `req.ip` already honours the Express trust setting. This wrapper exists to
 * give audit rows a single canonical field and to degrade gracefully when the
 * address is an IPv6 loopback-ish value we do not want to store.
 */
function clientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || null;
  if (!ip) return null;
  // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1) so grouping by IP is stable.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** Coarse, non-identifying device label shown in the "active sessions" list. */
function deviceLabel(userAgent) {
  if (!userAgent) return 'Unknown device';

  const ua = String(userAgent);
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /curl/i.test(ua) ? 'curl'
    : /Postman/i.test(ua) ? 'Postman'
    : /node/i.test(ua) ? 'Node'
    : /bot|crawler|spider/i.test(ua) ? 'Bot'
    : 'Browser';

  const os =
    /Windows NT/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';

  return os ? `${browser} on ${os}` : browser;
}

module.exports = { trustProxy, clientIp, deviceLabel };
