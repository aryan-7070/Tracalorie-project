'use strict';

/**
 * Account-level brute-force defence.
 *
 * Complements the per-IP rate limiter. An attacker with a botnet rotates source
 * addresses, so the per-IP budget never fires, but they must still guess the
 * *same* password for the *same* account. Lockout is therefore keyed on the
 * account, and the failure counter is persisted so it survives restarts and is
 * shared across instances.
 *
 * Progressive delay rather than a hard lockout. After `threshold` consecutive
 * failures the account is blocked for a window that doubles with each further
 * failure, capped at `maxDelaySeconds`. A hard N-strike lockout is trivially
 * weaponised as a denial of service against a known victim, and an attacker
 * can also use "lock them out until you unblock me" as a harassment tool. The
 * delay is long enough to make online guessing infeasible and short enough that
 * a real user recovers on their own.
 *
 * Defence in depth, because this is a control with a known DoS trade-off:
 *   - Failures from *different* IPs for the same account still accumulate
 *     (catches credential stuffing).
 *   - A correct password does NOT clear the counter if the account is already
 *     inside its delay window, so an attacker cannot probe timing.
 */

const config = require('../config/env');
const { query } = require('../db');
const { logger } = require('./logger');
const { tooManyRequests, unauthorized } = require('./errors');

/** Record every attempt, successful or not, for abuse analytics. */
async function recordAttempt({ identifier, ip, userAgent, successful, reason }) {
  try {
    await query(
      `INSERT INTO login_attempts (identifier, ip_address, user_agent, successful, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [String(identifier).slice(0, 254), ip || null, userAgent ? String(userAgent).slice(0, 512) : null, successful, reason || null]
    );
  } catch (err) {
    logger.error('Failed to record login attempt', { err });
  }
}

/** Current lockout state for a user row. */
function lockoutState(user) {
  if (!user?.locked_until) return { locked: false, retryAfterSeconds: 0, failures: user?.failed_login_count ?? 0 };

  const lockedUntil = new Date(user.locked_until).getTime();
  const now = Date.now();

  if (lockedUntil <= now) return { locked: false, retryAfterSeconds: 0, failures: user.failed_login_count ?? 0 };

  return {
    locked: true,
    retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000),
    failures: user.failed_login_count ?? 0,
  };
}

/** Delay for the Nth consecutive failure: base * 2^(N - threshold), capped. */
function delayForFailureCount(count) {
  if (count < config.lockout.threshold) return 0;
  const exponent = Math.min(count - config.lockout.threshold, 16);
  return Math.min(
    config.lockout.baseDelaySeconds * 2 ** exponent,
    config.lockout.maxDelaySeconds
  );
}

/** Register a failure and return the new state. */
async function registerFailure(userId) {
  const { rows } = await query(
    `UPDATE users
     SET failed_login_count = failed_login_count + 1,
         last_failed_login_at = now(),
         locked_until = CASE
           WHEN failed_login_count + 1 >= $2
             THEN now() + make_interval(secs => LEAST($3::int * (1 << LEAST(failed_login_count + 1 - $2, 16)), $4::int))
           ELSE locked_until
         END
     WHERE id = $1
     RETURNING failed_login_count, locked_until`,
    [userId, config.lockout.threshold, config.lockout.baseDelaySeconds, config.lockout.maxDelaySeconds]
  );

  const user = rows[0];
  return lockoutState({ ...user });
}

/** Clear counters after a successful authentication. */
async function registerSuccess(userId, ip) {
  await query(
    `UPDATE users
     SET failed_login_count = 0, locked_until = NULL, last_login_at = now(), last_login_ip = $2
     WHERE id = $1`,
    [userId, ip || null]
  );
}

/** Admin unlock. */
async function clearLockout(userId) {
  await query(
    'UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1',
    [userId]
  );
}

/**
 * Guard a login attempt.
 * @throws 429 when inside the delay window
 * @throws 401 when the account does not exist (identical shape to a bad password)
 */
function assertNotLocked(user) {
  const state = lockoutState(user);
  if (!state.locked) return state;

  throw tooManyRequests(
    `Too many failed attempts. Try again in ${Math.ceil(state.retryAfterSeconds / 60)} minute(s), or reset your password.`,
    'account_locked',
    { retryAfterSeconds: state.retryAfterSeconds }
  );
}

/**
 * Uniform failure for an unknown user.
 *
 * Returning "Invalid credentials" for both an unknown account and a wrong
 * password prevents username enumeration. The dummy bcrypt comparison in
 * `password.verify` equalises timing so the *duration* does not leak either.
 */
function invalidCredentials() {
  return unauthorized('Invalid username or password', 'invalid_credentials');
}

/** Recent failure count for a username, including ones with no user row. */
async function failuresForIdentifier(identifier) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS failures
     FROM login_attempts
     WHERE identifier = $1 AND successful = false
       AND created_at >= now() - interval '24 hours'`,
    [String(identifier).toLowerCase()]
  );
  return rows[0]?.failures ?? 0;
}

module.exports = {
  recordAttempt,
  lockoutState,
  delayForFailureCount,
  registerFailure,
  registerSuccess,
  clearLockout,
  assertNotLocked,
  invalidCredentials,
  failuresForIdentifier,
};
