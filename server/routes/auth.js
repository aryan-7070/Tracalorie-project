'use strict';

/**
 * Authentication routes.
 *
 * Contract with the client:
 *   - Tokens are set as httpOnly cookies. The response body never contains a
 *     token, so there is nothing for a script to steal.
 *   - The body returns the user object and a CSRF token, which the client keeps
 *     in memory and echoes in `X-CSRF-Token`.
 */

const express = require('express');
const config = require('../config/env');
const { query, transaction } = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth, asyncHandler } = require('../middleware/auth');
const { clientIp, deviceLabel } = require('../middleware/clientIp');
const { loginLimiter, authLimiter, refreshLimiter, writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../schemas');
const crypto = require('../lib/crypto');
const password = require('../lib/password');
const sessions = require('../lib/sessions');
const lockout = require('../lib/lockout');
const audit = require('../lib/audit');
const findings = require('../lib/findings');
const { badRequest, unauthorized, conflict, tooManyRequests } = require('../lib/errors');
const { logger } = require('../lib/logger');

const router = express.Router();

/** Decrypt PII columns for a user row. Returns nulls rather than throwing so a
 *  single undecryptable field does not break the whole profile. */
function presentUser(row) {
  const decrypt = (value, aad) => {
    if (!value) return null;
    try {
      return crypto.decrypt(value, aad);
    } catch (err) {
      logger.error('Failed to decrypt user field', { err, aad });
      return null;
    }
  };

  return {
    id: row.id,
    username: row.username,
    email: decrypt(row.email_enc, `user:${row.id}:email`),
    displayName: decrypt(row.display_name_enc, `user:${row.id}:displayName`),
    calorieLimit: row.calorie_limit,
    units: row.units,
    timezone: row.timezone,
    bodyWeightKg: row.body_weight_kg,
    proteinTargetG: row.protein_target_g,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

const USER_COLUMNS = `id, username, email_enc, display_name_enc, calorie_limit,
                      units, timezone, body_weight_kg, protein_target_g,
                      last_login_at, created_at`;

/** Set the full cookie pair for a new session. */
function establishSession(res, { accessToken, refreshToken }) {
  res.cookie(
    sessions.cookieName(sessions.COOKIE_ACCESS),
    accessToken,
    sessions.cookieOptions({ maxAge: config.jwt.accessTtlSeconds * 1000 })
  );
  // Scoped to the auth routes so it is not attached to ordinary API calls.
  res.cookie(
    sessions.cookieName(sessions.COOKIE_REFRESH),
    refreshToken,
    sessions.cookieOptions({
      maxAge: config.session.refreshTtlSeconds * 1000,
      path: sessions.REFRESH_COOKIE_PATH,
    })
  );
}

function clearSessionCookies(res) {
  res.clearCookie(sessions.cookieName(sessions.COOKIE_ACCESS), sessions.cookieOptions());
  res.clearCookie(
    sessions.cookieName(sessions.COOKIE_REFRESH),
    sessions.cookieOptions({ path: sessions.REFRESH_COOKIE_PATH })
  );
}

function auditBase(req) {
  return {
    ip: clientIp(req),
    userAgent: req.headers['user-agent'],
    requestId: req.id,
  };
}

// -----------------------------------------------------------------------------
// POST /api/auth/register
// -----------------------------------------------------------------------------
router.post(
  '/register',
  authLimiter,
  validate({ body: schemas.register }),
  asyncHandler(async (req, res) => {
    const { username: rawUsername, email, password: rawPassword, displayName } = req.body;

    const normalisedUsername = rawUsername.toLowerCase();
    const usernameBidx = crypto.blindIndex(normalisedUsername, 'username');
    const emailBidx = email ? crypto.blindIndex(email, 'email') : null;

    password.assertPolicy(rawPassword, { username: normalisedUsername, email });

    // Password hashing is the slowest operation in the request path (~250ms at
    // cost 12). Doing it *before* the uniqueness check would let an attacker
    // use duplicate registrations as a CPU-amplification vector, so check first.
    const clash = await query(
      `SELECT 1 FROM users
       WHERE username_bidx = $1 OR ($2::text IS NOT NULL AND email_bidx = $2)
       LIMIT 1`,
      [usernameBidx, emailBidx]
    );

    if (clash.rowCount > 0) {
      // Which field clashed is not disclosed, so the response cannot be used to
      // enumerate registered users.
      throw conflict('That username or email is already registered', 'already_registered');
    }

    const passwordHash = await password.hash(rawPassword);

    let user;
    try {
      user = await transaction(async (client) => {
        const { rows } = await client.query(
          // lint:sql-safe USER_COLUMNS is a literal column-list constant.
          `INSERT INTO users (username, username_bidx, email_enc, email_bidx, display_name_enc, password_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${USER_COLUMNS}`,
          [
            normalisedUsername,
            usernameBidx,
            email ? crypto.encrypt(email, 'user:pending:email') : null,
            emailBidx,
            displayName ? crypto.encrypt(displayName, 'user:pending:displayName') : null,
            passwordHash,
          ]
        );
        return rows[0];
      });
    } catch (err) {
      if (err.code === '23505') {
        throw conflict('That username or email is already registered', 'already_registered');
      }
      throw err;
    }

    // The ciphertext AAD used the real id, so re-encrypt now that it exists.
    if (email || displayName) {
      const { rows } = await query(
        // lint:sql-safe USER_COLUMNS is a literal column-list constant.
        `UPDATE users SET email_enc = $2, display_name_enc = $3 WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [
          user.id,
          email ? crypto.encrypt(email, `user:${user.id}:email`) : null,
          displayName ? crypto.encrypt(displayName, `user:${user.id}:displayName`) : null,
        ]
      );
      user = rows[0];
    }

    await sessions.recordPasswordHistory(user.id, passwordHash);

    await audit.record({
      action: audit.EVENTS.REGISTER,
      actorId: user.id,
      ...auditBase(req),
      details: { username: user.username },
    });

    // Registration does not auto-login. Returning a session here would mean a
    // token exists before the user has demonstrated they control the password.
    logger.info('account.registered', { userId: user.id, username: user.username });

    return res.status(201).json({
      user: presentUser(user),
      message: 'Account created. Please sign in.',
    });
  })
);

// -----------------------------------------------------------------------------
// POST /api/auth/login
// -----------------------------------------------------------------------------
router.post(
  '/login',
  loginLimiter,
  validate({ body: schemas.login }),
  asyncHandler(async (req, res) => {
    const { username: identifier, password: candidate } = req.body;
    const base = auditBase(req);
    const normalised = identifier.toLowerCase();

    const isEmailLike = identifier.includes('@');
    const bidx = isEmailLike
      ? crypto.blindIndex(identifier, 'email')
      : crypto.blindIndex(normalised, 'username');

    // lint:sql-safe USER_COLUMNS is a literal column-list constant.
    const { rows } = await query(
      `SELECT ${USER_COLUMNS}, password_hash, failed_login_count, locked_until, status, token_epoch
       FROM users
       WHERE ($1::text IS NOT NULL AND email_bidx = $1)
          OR username_bidx = $2
       LIMIT 1`,
      [isEmailLike ? bidx : null, isEmailLike ? null : bidx]
    );

    const user = rows[0];

    if (!user) {
      // Burn comparable CPU so response time does not reveal existence.
      await password.verify(candidate, null);
      await lockout.recordAttempt({ identifier: normalised, ip: base.ip, userAgent: base.userAgent, successful: false, reason: 'unknown_user' });
      await audit.record({
        action: audit.EVENTS.LOGIN_FAILURE,
        outcome: 'failure',
        ...base,
        details: { reason: 'unknown_user', identifier: normalised.slice(0, 64) },
      });
      throw lockout.invalidCredentials();
    }

    if (user.status !== 'active') {
      await lockout.recordAttempt({ identifier: normalised, ip: base.ip, userAgent: base.userAgent, successful: false, reason: 'inactive' });
      await audit.record({
        action: audit.EVENTS.LOGIN_BLOCKED,
        outcome: 'failure',
        actorId: user.id,
        ...base,
        details: { reason: 'account_inactive', status: user.status },
      });
      throw lockout.invalidCredentials();
    }

    // Progressive lockout check happens *after* the account is identified, so
    // the correct password still fails while the account is in its delay
    // window. That prevents an attacker from using a valid credential to probe
    // whether the account exists.
    lockout.assertNotLocked(user);

    const isMatch = await password.verify(candidate, user.password_hash);

    if (!isMatch) {
      const state = await lockout.registerFailure(user.id);
      await lockout.recordAttempt({ identifier: normalised, ip: base.ip, userAgent: base.userAgent, successful: false, reason: 'bad_password' });
      await audit.record({
        action: state.locked ? audit.EVENTS.LOGIN_BLOCKED : audit.EVENTS.LOGIN_FAILURE,
        outcome: 'failure',
        actorId: user.id,
        ...base,
        details: {
          reason: 'bad_password',
          failureCount: state.failures,
          locked: state.locked,
          retryAfterSeconds: state.retryAfterSeconds,
        },
      });

      if (state.locked) {
        throw tooManyRequests(
          `Too many failed attempts. Try again in ${Math.ceil(state.retryAfterSeconds / 60)} minute(s), or reset your password.`,
          'account_locked',
          { retryAfterSeconds: state.retryAfterSeconds }
        );
      }

      throw lockout.invalidCredentials();
    }

    // ---- Success -------------------------------------------------------

    const previousDevice = await knownDevice(user.id, base.userAgent);

    await lockout.registerSuccess(user.id, base.ip);
    await lockout.recordAttempt({ identifier: normalised, ip: base.ip, userAgent: base.userAgent, successful: true, reason: null });

    const { session, accessToken, refreshToken } = await sessions.createSession(user, {
      ip: base.ip,
      userAgent: base.userAgent,
      deviceLabel: deviceLabel(base.userAgent),
    });

    establishSession(res, { accessToken, refreshToken });

    await audit.record({
      action: audit.EVENTS.LOGIN_SUCCESS,
      actorId: user.id,
      sessionId: session.session_uuid,
      ...base,
      details: { device: deviceLabel(base.userAgent) },
    });

    // Surface an unfamiliar device so the user can recognise it in their
    // security panel. This is a detection heuristic, not proof of compromise.
    if (base.userAgent && !previousDevice) {
      await findings.record({
        userId: user.id,
        kind: 'new_device_login',
        severity: 'medium',
        message: `New sign-in from ${deviceLabel(base.userAgent)}`,
        metadata: { ip: base.ip, device: deviceLabel(base.userAgent) },
      });
    }

    logger.info('auth.login.success', { userId: user.id, requestId: req.id });

    return res.json({
      user: presentUser({ ...user, last_login_at: new Date() }),
      csrfToken: req.csrfToken,
      expiresIn: config.jwt.accessTtlSeconds,
    });
  })
);

/** Has this exact user agent signed in before? Used for new-device detection. */
async function knownDevice(userId, userAgent) {
  if (!userAgent) return true;
  const { rows } = await query(
    `SELECT 1 FROM user_sessions
     WHERE user_id = $1 AND user_agent = $2 LIMIT 1`,
    [userId, String(userAgent).slice(0, 512)]
  );
  return rows.length > 0;
}

// -----------------------------------------------------------------------------
// POST /api/auth/refresh
// -----------------------------------------------------------------------------
router.post(
  '/refresh',
  refreshLimiter,
  asyncHandler(async (req, res) => {
    const presented = req.cookies?.[sessions.cookieName(sessions.COOKIE_REFRESH)];
    const base = auditBase(req);

    if (!presented) {
      throw unauthorized('No refresh token provided', 'refresh_token_missing');
    }

    let result;
    try {
      result = await sessions.rotateRefreshToken(presented, {
        ip: base.ip,
        userAgent: base.userAgent,
        deviceLabel: deviceLabel(base.userAgent),
      });
    } catch (err) {
      if (err.code === 'refresh_token_reuse') {
        // The session is already dead; drop the cookies so the client is not
        // stuck replaying a bad token.
        clearSessionCookies(res);
        await audit.record({
          action: audit.EVENTS.TOKEN_REUSE_DETECTED,
          outcome: 'failure',
          actorId: err.auditContext?.userId ?? null,
          ...base,
          details: { familyId: err.auditContext?.familyId, impact: 'entire_family_revoked' },
        });
      }
      throw err;
    }

    establishSession(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });

    await audit.record({
      action: audit.EVENTS.TOKEN_REFRESH,
      actorId: result.user.id,
      sessionId: result.session.session_uuid,
      ...base,
    });

    return res.json({
      user: presentUser(result.user),
      csrfToken: req.csrfToken,
      expiresIn: config.jwt.accessTtlSeconds,
    });
  })
);

// -----------------------------------------------------------------------------
// POST /api/auth/logout
// -----------------------------------------------------------------------------
router.post(
  '/logout',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const accessToken = req.cookies?.[sessions.cookieName(sessions.COOKIE_ACCESS)];
    const refreshToken = req.cookies?.[sessions.cookieName(sessions.COOKIE_REFRESH)];
    const base = auditBase(req);

    if (refreshToken) {
      // Revoke by family so every token in this login's rotation lineage dies
      // together; otherwise the next refresh would resurrect the session.
      const fingerprint = crypto.tokenFingerprint(refreshToken);
      const { rows } = await query(
        'SELECT user_id, family_id FROM user_sessions WHERE token_hash = $1',
        [fingerprint]
      );
      if (rows[0]) {
        await query(
          `UPDATE user_sessions
           SET revoked_at = now(), revoked_reason = 'logout'
           WHERE family_id = $1 AND revoked_at IS NULL`,
          [rows[0].family_id]
        );
        await audit.record({
          action: audit.EVENTS.LOGOUT,
          actorId: rows[0].user_id,
          ...base,
        });
      }
    } else if (accessToken) {
      try {
        const payload = sessions.verifyAccessToken(accessToken);
        await audit.record({
          action: audit.EVENTS.LOGOUT,
          actorId: Number(payload.sub),
          sessionId: payload.sid,
          ...base,
          details: { via: 'access_token_only' },
        });
      } catch {
        // An expired or malformed access token on logout is not an error worth
        // surfacing; the browser ends up logged out regardless.
      }
    }

    clearSessionCookies(res);
    return res.status(204).end();
  })
);

// -----------------------------------------------------------------------------
// POST /api/auth/logout-all
// -----------------------------------------------------------------------------
router.post(
  '/logout-all',
  requireAuth,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const revoked = await sessions.revokeAllSessions(req.user.id, {
      exceptSessionUuid: req.session.uuid,
      reason: 'logout_all',
    });

    // Bump the epoch so the *other* sessions' outstanding access tokens are
    // rejected immediately rather than lingering for up to 15 minutes.
    await query('UPDATE users SET token_epoch = token_epoch + 1 WHERE id = $1', [req.user.id]);

    await audit.record({
      action: audit.EVENTS.SESSIONS_REVOKED_ALL,
      actorId: req.user.id,
      sessionId: req.session.uuid,
      ...auditBase(req),
      details: { revokedSessions: revoked },
    });

    return res.json({ revokedSessions: revoked, message: `Signed out of ${revoked} other device(s).` });
  })
);

// -----------------------------------------------------------------------------
// POST /api/auth/change-password
// -----------------------------------------------------------------------------
router.post(
  '/change-password',
  requireAuth,
  writeLimiter,
  validate({ body: schemas.changePassword }),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const base = auditBase(req);

    const { rows } = await query(
      'SELECT id, password_hash, token_epoch FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = rows[0];

    if (!user || !(await password.verify(currentPassword, user.password_hash))) {
      await audit.record({
        action: audit.EVENTS.PASSWORD_CHANGED,
        outcome: 'failure',
        actorId: req.user.id,
        ...base,
        details: { reason: 'incorrect_current_password' },
      });
      // Deliberately does not reveal whether the current password was close to
      // correct, nor how many attempts remain.
      throw unauthorized('Current password is incorrect', 'invalid_credentials');
    }

    if (await password.verify(newPassword, user.password_hash)) {
      throw badRequest('New password must differ from the current one', 'password_reused');
    }

    if (await sessions.isPasswordReused(req.user.id, newPassword)) {
      throw badRequest(
        `Choose a password you have not used in your last ${config.password.historyDepth} passwords`,
        'password_reused'
      );
    }

    password.assertPolicy(newPassword, { username: req.user.username, email: req.user.emailEnc });

    const newHash = await password.hash(newPassword);

    await transaction(async (client) => {
      await client.query(
        'UPDATE users SET password_hash = $2, password_changed_at = now(), token_epoch = token_epoch + 1 WHERE id = $1',
        [req.user.id, newHash]
      );
      await client.query(
        'INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)',
        [req.user.id, newHash]
      );
      await client.query(
        `DELETE FROM password_history
         WHERE user_id = $1
           AND id NOT IN (SELECT id FROM password_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)`,
        [req.user.id, config.password.historyDepth]
      );
      // Every other session dies. The caller's session is re-issued below.
      await client.query(
        `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'password_change'
         WHERE user_id = $1 AND revoked_at IS NULL AND session_uuid <> $2`,
        [req.user.id, req.session.uuid]
      );
    });

    await audit.record({
      action: audit.EVENTS.PASSWORD_CHANGED,
      actorId: req.user.id,
      sessionId: req.session.uuid,
      ...base,
    });

    // The epoch bump invalidated the caller's own access token. Mint a fresh
    // session so the user stays signed in on this device.
    const refreshedUser = { ...user, token_epoch: Number(user.token_epoch) + 1 };
    const { session, accessToken, refreshToken } = await sessions.createSession(refreshedUser, {
      ip: base.ip,
      userAgent: base.userAgent,
      deviceLabel: deviceLabel(base.userAgent),
    });

    establishSession(res, { accessToken, refreshToken });

    logger.info('auth.password_changed', { userId: req.user.id, requestId: req.id });

    return res.json({
      message: 'Password updated. Other devices have been signed out.',
      sessionId: session.session_uuid,
      csrfToken: req.csrfToken,
    });
  })
);

// -----------------------------------------------------------------------------
// GET /api/auth/me
// -----------------------------------------------------------------------------
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      // lint:sql-safe USER_COLUMNS is a literal column-list constant.
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (!rows[0]) {
      throw unauthorized('Account no longer exists', 'account_missing');
    }

    return res.json({ user: presentUser(rows[0]), csrfToken: req.csrfToken });
  })
);

// -----------------------------------------------------------------------------
// GET /api/auth/csrf  — unauthenticated CSRF bootstrap
//
// Why this exists: `issueCsrfCookie` mints the token and sets the cookie, but
// `verifyCsrf` rejects a mutating request that arrives without a matching
// header. On a first-ever visit the client therefore cannot log in — it has no
// token yet, and cannot obtain one without making a request. This endpoint is
// the escape hatch: a safe GET that returns the token the middleware has
// already put in the cookie.
//
// This is not a CSRF weakness. An attacker can trigger the request, but the
// response is unreadable cross-origin (CORS blocks it) and the token is useless
// without the matching SameSite=Strict cookie, which the browser withholds on
// cross-site requests. The client can only read this token on its own origin.
// -----------------------------------------------------------------------------
router.get('/csrf', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ csrfToken: req.csrfToken });
});

// -----------------------------------------------------------------------------
// GET /api/auth/session  — cheap endpoint for the client to validate a cookie
// -----------------------------------------------------------------------------
router.get(
  '/session',
  requireAuth,
  asyncHandler(async (req, res) => {
    return res.json({
      authenticated: true,
      sessionId: req.session.uuid,
      expiresIn: config.jwt.accessTtlSeconds,
      csrfToken: req.csrfToken,
    });
  })
);

// -----------------------------------------------------------------------------
// PATCH /api/auth/profile
// -----------------------------------------------------------------------------
router.patch(
  '/profile',
  requireAuth,
  writeLimiter,
  validate({ body: schemas.updateProfile }),
  asyncHandler(async (req, res) => {
    const { displayName, email, timezone, units, bodyWeightKg, proteinTargetG } = req.body;
    const userId = req.user.id;
    const changed = [];

    const sets = [];
    const values = [userId];
    const push = (fragment, value) => {
      values.push(value);
      sets.push(`${fragment} = $${values.length}`);
    };

    if (displayName !== undefined) {
      push('display_name_enc', crypto.encrypt(displayName, `user:${userId}:displayName`));
      changed.push('displayName');
    }

    if (email !== undefined) {
      const emailBidx = crypto.blindIndex(email, 'email');
      const { rows } = await query('SELECT 1 FROM users WHERE email_bidx = $1 AND id <> $2', [emailBidx, userId]);
      if (rows.length) {
        throw conflict('That email is already in use', 'email_taken');
      }
      push('email_enc', crypto.encrypt(email, `user:${userId}:email`));
      push('email_bidx', emailBidx);
      changed.push('email');
    }

    if (timezone !== undefined) push('timezone', timezone);
    if (units !== undefined) push('units', units);
    if (bodyWeightKg !== undefined) {
      push('body_weight_kg', bodyWeightKg);
      changed.push('bodyWeightKg');
    }
    if (proteinTargetG !== undefined) {
      push('protein_target_g', proteinTargetG);
      changed.push('proteinTargetG');
    }

    // `sets` is built by `push()` above from literal column fragments; only the
    // values are request-derived, and those travel as bound parameters.
    // lint:sql-safe column identifiers are a hardcoded allowlist
    if (sets.length > 0) {
      await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, values);
    }

    await audit.record({
      action: audit.EVENTS.PROFILE_UPDATED,
      actorId: userId,
      sessionId: req.session.uuid,
      ...auditBase(req),
      details: { fields: changed },
    });

    // lint:sql-safe USER_COLUMNS is a module-level constant of literal column
    // names; no request data reaches the string.
    const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);

    return res.json({ user: presentUser(rows[0]) });
  })
);

module.exports = { router, presentUser, USER_COLUMNS, auditBase, establishSession, clearSessionCookies };
