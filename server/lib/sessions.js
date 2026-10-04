'use strict';

/**
 * Session lifecycle and refresh-token rotation with reuse detection.
 *
 * Threat model
 * ------------
 * A refresh token is a long-lived bearer credential, so it is the most valuable
 * thing to steal from a browser. Two mechanisms contain the damage:
 *
 * 1. Rotation. Every refresh mints a new token and revokes the presented one.
 *    A stolen token is therefore single-use.
 *
 * 2. Reuse detection. Refresh tokens belong to a `family_id` — the lineage of
 *    rotations from one original login. If a token that has already been
 *    rotated is presented again, something is wrong: either the legitimate user
 *    replayed a stale token, or an attacker is using a stolen one. We cannot
 *    distinguish those, so we assume compromise and revoke the entire family,
 *    forcing a fresh login. The legitimate user is mildly inconvenienced; the
 *    attacker is evicted. That is the correct trade-off.
 *
 * Only SHA-256 fingerprints of tokens are persisted, so a database dump does not
 * yield usable credentials.
 */

const jwt = require('jsonwebtoken');
const crypto = require('./crypto');
const config = require('../config/env');
const { query, transaction } = require('../db');
const { logger } = require('./logger');
const { unauthorized, forbidden } = require('./errors');

const COOKIE_ACCESS = 'access_token';
const COOKIE_REFRESH = 'refresh_token';
const COOKIE_CSRF = 'csrf_token';

function cookieName(base) {
  return `${config.cookies.prefix}${base}`;
}

/** Common cookie options. Path is scoped so tokens travel as little as possible. */
function cookieOptions({ maxAge, path = '/' } = {}) {
  return {
    httpOnly: true,
    secure: config.cookies.secure,
    sameSite: config.cookies.samesite,
    path,
    ...(config.cookies.domain ? { domain: config.cookies.domain } : {}),
    ...(maxAge ? { maxAge } : {}),
  };
}

// The refresh cookie is scoped to the auth routes: it is never needed by
// /api/items, so an XSS on a data page cannot exfiltrate it to the same origin
// path. Narrow scope is free defence.
const REFRESH_COOKIE_PATH = '/api/auth';

/** Sign a short-lived access token bound to a specific session. */
function signAccessToken({ userId, sessionUuid, tokenEpoch }) {
  return jwt.sign(
    { sub: String(userId), sid: sessionUuid, epoch: tokenEpoch },
    config.jwt.secret,
    {
      algorithm: 'HS256',
      expiresIn: config.jwt.accessTtlSeconds,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      // A unique id per token, so two tokens issued in the same second for the
      // same session are still distinguishable.
      jwtid: crypto.randomToken(16),
    }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.secret, {
    algorithms: ['HS256'], // pinned: prevents `alg: none` and RS256->HS256 confusion
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
}

/**
 * Create a new session and its first refresh token.
 * @returns {Promise<{session, accessToken, refreshToken}>}
 */
async function createSession(user, { ip, userAgent, deviceLabel } = {}) {
  const refreshToken = crypto.randomToken(32);
  const now = Date.now();

  const { rows } = await query(
    `INSERT INTO user_sessions
       (user_id, token_hash, ip_address, user_agent, device_label, absolute_expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::int))
     RETURNING id, session_uuid, family_id, access_jti, created_at, absolute_expires_at`,
    [
      user.id,
      crypto.tokenFingerprint(refreshToken),
      ip || null,
      userAgent ? String(userAgent).slice(0, 512) : null,
      deviceLabel || null,
      config.session.absoluteLifetimeSeconds,
    ]
  );

  const session = rows[0];

  const accessToken = signAccessToken({
    userId: user.id,
    sessionUuid: session.session_uuid,
    tokenEpoch: user.token_epoch ?? 1,
  });

  return { session, accessToken, refreshToken };
}

/**
 * Rotate a refresh token.
 *
 * Runs in a single transaction with the row locked `FOR UPDATE`, so two
 * concurrent requests presenting the same token cannot both succeed. Exactly
 * one rotates; the other observes the revoked row and is treated as reuse.
 *
 * @returns {Promise<{session, accessToken, refreshToken, rotated:boolean}>}
 * @throws  unauthorized on unknown/expired token
 * @throws  forbidden  on detected reuse (family already revoked)
 */
async function rotateRefreshToken(presentedToken, context = {}) {
  if (!presentedToken) {
    throw unauthorized('No refresh token provided', 'refresh_token_missing');
  }

  const fingerprint = crypto.tokenFingerprint(presentedToken);

  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT s.id, s.user_id, s.family_id, s.session_uuid, s.token_hash,
              s.revoked_at, s.revoked_reason, s.absolute_expires_at,
              u.token_epoch, u.status
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
       FOR UPDATE OF s`,
      [fingerprint]
    );

    const existing = rows[0];

    if (!existing) {
      // Unknown token. Could be a forged value or a token from a fully purged
      // session. No audit actor is known, so this is recorded on the system
      // chain by the caller.
      throw unauthorized('Invalid refresh token', 'refresh_token_invalid');
    }

    // --- Reuse detection -------------------------------------------------
    if (existing.revoked_at) {
      if (config.session.revokeFamilyOnReuse) {
        await client.query(
          `UPDATE user_sessions
           SET revoked_at = now(), revoked_reason = 'reuse_detected'
           WHERE family_id = $1 AND revoked_at IS NULL`,
          [existing.family_id]
        );

        logger.error('Refresh token reuse detected — family revoked', {
          familyId: existing.family_id,
          userId: existing.user_id,
          ip: context.ip,
        });
      }

      const err = unauthorized(
        'This session is no longer valid. Please sign in again.',
        'refresh_token_reuse'
      );
      // Attach context for the caller's audit record.
      err.auditContext = { userId: existing.user_id, familyId: existing.family_id };
      throw err;
    }

    if (new Date(existing.absolute_expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'expired' WHERE id = $1`,
        [existing.id]
      );
      throw unauthorized('Session has expired. Please sign in again.', 'session_expired');
    }

    if (existing.status !== 'active') {
      await client.query(
        `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'admin' WHERE id = $1`,
        [existing.id]
      );
      throw forbidden('Account is not active', 'account_inactive');
    }

    // --- Rotation --------------------------------------------------------
    const nextRefreshToken = crypto.randomToken(32);

    const { rows: newRows } = await client.query(
      `INSERT INTO user_sessions
         (user_id, family_id, token_hash, ip_address, user_agent, device_label, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, session_uuid, family_id, access_jti, created_at, absolute_expires_at`,
      [
        existing.user_id,
        existing.family_id, // lineage preserved
        crypto.tokenFingerprint(nextRefreshToken),
        context.ip || null,
        context.userAgent ? String(context.userAgent).slice(0, 512) : null,
        context.deviceLabel || null,
        // Absolute lifetime is inherited: rotation must never extend it, or a
        // rotating token would never actually expire.
        existing.absolute_expires_at,
      ]
    );

    const newSession = newRows[0];

    await client.query(
      `UPDATE user_sessions
       SET revoked_at = now(), revoked_reason = 'rotated', last_used_at = now()
       WHERE id = $1`,
      [existing.id]
    );

    const { rows: userRows } = await client.query(
      'SELECT id, token_epoch, username, calorie_limit, email_enc, display_name_enc, units, timezone FROM users WHERE id = $1',
      [existing.user_id]
    );

    const accessToken = signAccessToken({
      userId: existing.user_id,
      sessionUuid: newSession.session_uuid,
      tokenEpoch: userRows[0].token_epoch,
    });

    return {
      session: newSession,
      accessToken,
      refreshToken: nextRefreshToken,
      user: userRows[0],
      rotated: true,
    };
  });
}

/** Revoke one session. Scoped to the owner so ids are not guessable-by-privilege. */
async function revokeSession(userId, sessionUuid, reason = 'logout') {
  const { rowCount } = await query(
    `UPDATE user_sessions
     SET revoked_at = now(), revoked_reason = $3
     WHERE session_uuid = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionUuid, userId, reason]
  );
  return rowCount > 0;
}

/** Revoke every session for a user, optionally sparing the current one. */
async function revokeAllSessions(userId, { exceptSessionUuid = null, reason = 'logout_all' } = {}) {
  const { rowCount } = await query(
    `UPDATE user_sessions
     SET revoked_at = now(), revoked_reason = $3
     WHERE user_id = $1 AND revoked_at IS NULL
       AND (session_uuid IS DISTINCT FROM $2)`,
    [userId, exceptSessionUuid, reason]
  );
  return rowCount;
}

/** Active sessions for the "where am I signed in" panel. */
async function listActiveSessions(userId, { currentSessionUuid = null, limit = 25 } = {}) {
  const { rows } = await query(
    `SELECT session_uuid, device_label, ip_address, user_agent,
            created_at, last_used_at,
            (session_uuid = $2::uuid) AS is_current
     FROM user_sessions
     WHERE user_id = $1
       AND revoked_at IS NULL
       AND absolute_expires_at > now()
     ORDER BY last_used_at DESC
     LIMIT $3`,
    [userId, currentSessionUuid, limit]
  );
  return rows;
}

/** Housekeeping: revoke sessions past their absolute lifetime. */
async function purgeExpiredSessions() {
  const { rowCount } = await query(
    `UPDATE user_sessions
     SET revoked_at = now(), revoked_reason = 'expired'
     WHERE revoked_at IS NULL AND absolute_expires_at <= now()`
  );
  return rowCount;
}

/** Record a password used earlier, for reuse prevention. */
async function recordPasswordHistory(userId, passwordHash) {
  await query(
    `INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)`,
    [userId, passwordHash]
  );
  // Keep only the most recent N.
  await query(
    `DELETE FROM password_history
     WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM password_history WHERE user_id = $1
         ORDER BY created_at DESC LIMIT $2
       )`,
    [userId, config.password.historyDepth]
  );
}

/** True if the candidate matches any of the user's recent passwords. */
async function isPasswordReused(userId, candidate) {
  const { rows } = await query(
    'SELECT password_hash FROM password_history WHERE user_id = $1',
    [userId]
  );
  // bcrypt.compare against each is CPU-bound; a user has at most a handful.
  const bcrypt = require('bcrypt');
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- deliberate: parallel bcrypt
    // would spike memory (each hash allocates ~2^cost bytes) and defeat the
    // rate limiting we are trying to keep.
    if (await bcrypt.compare(candidate, row.password_hash)) return true;
  }
  return false;
}

module.exports = {
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  COOKIE_CSRF,
  REFRESH_COOKIE_PATH,
  cookieName,
  cookieOptions,
  signAccessToken,
  verifyAccessToken,
  createSession,
  rotateRefreshToken,
  revokeSession,
  revokeAllSessions,
  listActiveSessions,
  purgeExpiredSessions,
  recordPasswordHistory,
  isPasswordReused,
};
