'use strict';

/**
 * Security findings: detected anomalies surfaced to the user.
 *
 * Distinct from the audit log. The audit log is the immutable record of what
 * happened; findings are the interpretation — "this looks wrong, look at it".
 * Separating them keeps the security panel readable and lets findings be
 * resolved without mutating history.
 */

const { query } = require('../db');
const { logger } = require('./logger');

const KINDS = Object.freeze({
  NEW_DEVICE_LOGIN: 'new_device_login',
  NEW_LOCATION_LOGIN: 'new_location_login',
  CREDENTIAL_STUFFING: 'credential_stuffing',
  REPEATED_LOGIN_FAILURES: 'repeated_login_failures',
  PASSWORD_CHANGED: 'password_changed',
  SESSIONS_REVOKED: 'sessions_revoked',
  TOKEN_REUSE: 'token_reuse_detected',
});

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

async function record({ userId, kind, severity = 'low', message, metadata = null }) {
  try {
    const { rows } = await query(
      `INSERT INTO security_findings (user_id, kind, severity, message, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, kind, severity, message, metadata, resolved_at, created_at`,
      [userId, kind, severity, message.slice(0, 500), metadata ? JSON.stringify(metadata) : null]
    );
    return rows[0];
  } catch (err) {
    // Never let finding generation break the request it is describing.
    logger.error('Failed to record security finding', { err, kind, userId });
    return null;
  }
}

/**
 * Coarse "new location" heuristic.
 *
 * Deliberately derived from a /16 network prefix rather than the full address:
 * a full IP is far too volatile to be a useful signal (mobile networks rotate
 * addresses constantly) and comparing it exactly would produce a finding on
 * almost every login. A /16 is stable enough to mean "somewhere new" and coarse
 * enough not to be noise.
 */
function networkPrefix(ip) {
  if (!ip) return null;
  if (ip.includes(':')) {
    // IPv6: keep the first three hextets (~/48).
    return ip.split(':').slice(0, 3).join(':') || null;
  }
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}` : null;
}

async function listForUser(userId, { includeResolved = false, limit = 25 } = {}) {
  const { rows } = await query(
    `SELECT id, kind, severity, message, metadata, resolved_at, created_at
     FROM security_findings
     WHERE user_id = $1 AND ($2::boolean OR resolved_at IS NULL)
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, includeResolved, limit]
  );
  return rows.map((r) => ({ ...r, severityRank: SEVERITY_ORDER[r.severity] ?? 3 }));
}

async function resolve(findingId, userId) {
  const { rowCount } = await query(
    'UPDATE security_findings SET resolved_at = now() WHERE id = $1 AND user_id = $2 AND resolved_at IS NULL',
    [findingId, userId]
  );
  return rowCount > 0;
}

/**
 * Detect burst failures against one account from many source addresses — the
 * signature of credential stuffing, which per-IP limiting and per-account
 * lockout each miss on their own.
 */
async function detectCredentialStuffing(userId, identifier) {
  const { rows } = await query(
    `SELECT COUNT(DISTINCT ip_address)::int AS distinct_ips,
            COUNT(*)::int AS attempts
     FROM login_attempts
     WHERE identifier = $1
       AND successful = false
       AND created_at >= now() - interval '1 hour'`,
    [String(identifier).toLowerCase()]
  );

  const { distinct_ips, attempts } = rows[0] || { distinct_ips: 0, attempts: 0 };

  if (attempts >= 20 && distinct_ips >= 5) {
    return record({
      userId,
      kind: KINDS.CREDENTIAL_STUFFING,
      severity: 'high',
      message: `${attempts} failed sign-in attempts from ${distinct_ips} different networks in the last hour. Consider changing your password.`,
      metadata: { attempts, distinctIps: distinct_ips, windowHours: 1 },
    });
  }

  return null;
}

module.exports = { KINDS, record, listForUser, resolve, detectCredentialStuffing, networkPrefix };
