'use strict';

/**
 * Security and privacy routes.
 *
 * This is the module that answers "what do you know about me, what has happened
 * on my account, and how do I take it all back?" — the questions behind GDPR
 * Articles 15 (access), 20 (portability) and 17 (erasure), and behind most of
 * what a security interviewer will ask you to demonstrate.
 *
 * Every route is scoped to the authenticated user by id. No route accepts a
 * user id from the client, so there is no identifier to tamper with.
 */

const express = require('express');
const { query, transaction } = require('../db');
const { requireAuth, asyncHandler } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { clientIp, deviceLabel } = require('../middleware/clientIp');
const { writeLimiter, heavyLimiter } = require('../middleware/rateLimit');
const schemas = require('../schemas');
const sessions = require('../lib/sessions');
const audit = require('../lib/audit');
const findings = require('../lib/findings');
const cloudExport = require('../lib/cloudExport');
const crypto = require('../lib/crypto');
const password = require('../lib/password');
const { badRequest, notFound, unauthorized } = require('../lib/errors');
const { logger } = require('../lib/logger');
const { presentUser, USER_COLUMNS, auditBase } = require('./auth');

const router = express.Router();

router.use(requireAuth);

function decryptField(value, aad) {
  if (!value) return null;
  try {
    return crypto.decrypt(value, aad);
  } catch (err) {
    logger.error('Failed to decrypt field during export', { err, aad });
    return null;
  }
}

/**
 * Collect everything held about a user, in plaintext, for export.
 *
 * Decryption happens here and nowhere else, so the export is the single point
 * where PII exists unencrypted. The result is written straight to the response
 * (or an encrypted bucket object) and never logged.
 */
async function collectUserData(userId) {
  const [userRows, items, foods, sessionRows, loginRows, findingRows, exportRows] = await Promise.all([
    // lint:sql-safe USER_COLUMNS is a literal column-list constant.
    query(`SELECT ${USER_COLUMNS}, last_login_at, last_login_ip, created_at, updated_at
           FROM users WHERE id = $1`, [userId]),
    query(`SELECT id, type, name, calories, entry_date, created_at
           FROM items WHERE user_id = $1 ORDER BY created_at`, [userId]),
    query(`SELECT id, type, name, calories, times_used, last_used
           FROM foods WHERE user_id = $1 ORDER BY last_used DESC`, [userId]),
    query(`SELECT session_uuid, device_label, ip_address, created_at, last_used_at,
                  revoked_at, revoked_reason
           FROM user_sessions WHERE user_id = $1 ORDER BY created_at`, [userId]),
    query(`SELECT identifier, ip_address, successful, reason, created_at
           FROM login_attempts
           WHERE identifier IN (SELECT lower(username) FROM users WHERE id = $1)
           ORDER BY created_at DESC LIMIT 500`, [userId]),
    query(`SELECT kind, severity, message, resolved_at, created_at
           FROM security_findings WHERE user_id = $1 ORDER BY created_at DESC`, [userId]),
    query(`SELECT export_uuid, format, storage, byte_size, requested_at
           FROM data_exports WHERE user_id = $1 ORDER BY requested_at DESC`, [userId]),
  ]);

  const user = userRows.rows[0];
  if (!user) throw notFound('User not found', 'user_not_found');

  return {
    // Metadata that travels with the file so it is self-describing years later.
    export: {
      schema: 'tracalorie.user-export/v1',
      generatedAt: new Date().toISOString(),
      userId: userId,
      note: 'Contains decrypted personal data. Store securely and delete when no longer needed.',
    },
    profile: {
      id: user.id,
      username: user.username,
      email: decryptField(user.email_enc, `user:${user.id}:email`),
      displayName: decryptField(user.display_name_enc, `user:${user.id}:displayName`),
      calorieLimit: user.calorie_limit,
      units: user.units,
      timezone: user.timezone,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
      lastLoginIp: user.last_login_ip,
    },
    tracking: {
      itemCount: items.rowCount,
      foodCount: foods.rowCount,
      items: items.rows,
      foods: foods.rows,
    },
    security: {
      sessions: sessionRows.rows,
      recentLoginAttempts: loginRows.rows,
      findings: findingRows.rows,
      auditLog: await audit.listForUser(userId, { limit: 200 }),
    },
    dataExports: exportRows.rows,
  };
}

// -----------------------------------------------------------------------------
// GET /api/security/overview
// -----------------------------------------------------------------------------
router.get(
  '/overview',
  heavyLimiter,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const [sessionsResult, findingsResult, auditSummary, oldestAttempt, recentAttempts] = await Promise.all([
      sessions.listActiveSessions(userId, { currentSessionUuid: req.session.uuid }),
      findings.listForUser(userId, { limit: 20 }),
      audit.summaryForUser(userId, { days: 30 }),
      query(
        `SELECT created_at FROM login_attempts
         WHERE identifier = (SELECT lower(username) FROM users WHERE id = $1)
         ORDER BY created_at ASC LIMIT 1`,
        [userId]
      ),
      query(
        `SELECT COUNT(*) FILTER (WHERE successful)::int AS successes,
                COUNT(*) FILTER (WHERE NOT successful)::int AS failures
         FROM login_attempts
         WHERE identifier = (SELECT lower(username) FROM users WHERE id = $1)
           AND created_at >= now() - interval '30 days'`,
        [userId]
      ),
    ]);

    return res.json({
      security: {
        activeSessions: sessionsResult,
        openFindings: findingsResult,
        auditSummary,
        accountAgeDays: oldestAttempt.rows[0]
          ? Math.floor((Date.now() - new Date(oldestAttempt.rows[0].created_at).getTime()) / 86_400_000)
          : null,
        last30Days: recentAttempts.rows[0] || { successes: 0, failures: 0 },
      },
    });
  })
);

// -----------------------------------------------------------------------------
// GET /api/security/sessions
// -----------------------------------------------------------------------------
router.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const active = await sessions.listActiveSessions(req.user.id, {
      currentSessionUuid: req.session?.uuid ?? null,
    });
    return res.json({ sessions: active });
  })
);

// -----------------------------------------------------------------------------
// DELETE /api/security/sessions/:id
// -----------------------------------------------------------------------------
router.delete(
  '/sessions/:id',
  writeLimiter,
  validate({ params: schemas.sessionUuidParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (id === req.session?.uuid) {
      throw badRequest('Use POST /api/auth/logout to end your current session', 'use_logout_endpoint');
    }

    const revoked = await sessions.revokeSession(req.user.id, id, 'logout');
    if (!revoked) {
      throw notFound('Session not found or already revoked', 'session_not_found');
    }

    await audit.record({
      action: audit.EVENTS.SESSION_REVOKED,
      actorId: req.user.id,
      sessionId: req.session?.uuid,
      ...auditBase(req),
      details: { revokedSession: id },
    });

    return res.json({ message: 'Session revoked', sessionId: id });
  })
);

// -----------------------------------------------------------------------------
// GET /api/security/audit
// -----------------------------------------------------------------------------
router.get(
  '/audit',
  heavyLimiter,
  validate({ query: schemas.auditQuery }),
  asyncHandler(async (req, res) => {
    const { limit, offset, days } = req.validatedQuery;

    const [entries, summary] = await Promise.all([
      query(
        `SELECT id, action, outcome, ip_address, user_agent, request_id, details, occurred_at
         FROM security_audit
         WHERE actor_id = $1
           AND occurred_at >= now() - make_interval(days => $2::int)
         ORDER BY id DESC
         LIMIT $3 OFFSET $4`,
        [req.user.id, days, limit, offset]
      ),
      audit.summaryForUser(req.user.id, { days }),
    ]);

    return res.json({ entries: entries.rows, summary, pagination: { limit, offset, days } });
  })
);

// -----------------------------------------------------------------------------
// GET /api/security/audit/verify
// -----------------------------------------------------------------------------
router.get(
  '/audit/verify',
  heavyLimiter,
  asyncHandler(async (req, res) => {
    const result = await audit.verifyChain({ actorId: req.user.id });
    return res.json({
      verification: result,
      explanation:
        'Each audit entry stores the SHA-256 of its own content and a hash of the previous entry. ' +
        'If any entry were edited or removed, the recomputed hash would no longer match.',
    });
  })
);

// -----------------------------------------------------------------------------
// GET /api/security/findings
// -----------------------------------------------------------------------------
router.get(
  '/findings',
  asyncHandler(async (req, res) => {
    const open = await findings.listForUser(req.user.id, { includeResolved: false });
    const all = await findings.listForUser(req.user.id, { includeResolved: true, limit: 50 });
    return res.json({ open, all });
  })
);

// -----------------------------------------------------------------------------
// POST /api/security/findings/:id/resolve
// -----------------------------------------------------------------------------
router.post(
  '/findings/:id/resolve',
  writeLimiter,
  validate({ params: schemas.idParam }),
  asyncHandler(async (req, res) => {
    const ok = await findings.resolve(req.params.id, req.user.id);
    if (!ok) throw notFound('Finding not found or already resolved', 'finding_not_found');
    return res.json({ message: 'Finding marked as reviewed' });
  })
);

// -----------------------------------------------------------------------------
// GET /api/security/export  — GDPR Article 15 + 20
// -----------------------------------------------------------------------------
router.get(
  '/export',
  heavyLimiter,
  validate({ query: schemas.exportQuery }),
  asyncHandler(async (req, res) => {
    const { format } = req.validatedQuery;
    const userId = req.user.id;

    const payload = await collectUserData(userId);
    const json = JSON.stringify(payload, null, 2);
    const body = format === 'csv' ? toCsv(payload) : json;

    const { rowCount } = await query(
      `INSERT INTO data_exports (user_id, format, storage, byte_size, checksum, expires_at)
       VALUES ($1, $2, 'inline', $3, $4, now() + interval '7 days')`,
      [userId, format, Buffer.byteLength(body), crypto.sha256Hex(body)]
    );

    await audit.record({
      action: audit.EVENTS.DATA_EXPORTED,
      actorId: userId,
      sessionId: req.session?.uuid,
      ...auditBase(req),
      details: { format, byteSize: Buffer.byteLength(body) },
    });

    logger.info('privacy.data_exported', { userId, format, bytes: Buffer.byteLength(body) });

    // `no-store` keeps the export out of browser and proxy caches. A
    // downloadable file is exactly the kind of response that must not linger.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="tracalorie-export-${userId}-${Date.now()}.${format}"`);

    return res.status(200).type(format === 'csv' ? 'text/csv' : 'application/json').send(body);
  })
);

// -----------------------------------------------------------------------------
// POST /api/security/export/archive  — encrypted copy to Google Cloud Storage
// -----------------------------------------------------------------------------
router.post(
  '/export/archive',
  heavyLimiter,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    if (!cloudExport.isConfigured()) {
      throw badRequest(
        'Cloud archiving is not enabled on this deployment. Use GET /api/security/export for an inline download.',
        'cloud_export_disabled'
      );
    }

    const payload = await collectUserData(userId);

    let result;
    try {
      result = await cloudExport.uploadExport({ userId, payload, format: 'json' });
    } catch (err) {
      logger.error('privacy.archive_failed', { err, userId });
      throw err;
    }

    await query(
      `INSERT INTO data_exports (user_id, format, storage, location, byte_size, checksum, expires_at)
       VALUES ($1, 'json', 'gcs', $2, $3, $4, $5)`,
      [userId, result.gsUri, result.byteSize, result.checksum, result.expiresAt]
    );

    await audit.record({
      action: audit.EVENTS.DATA_EXPORTED,
      actorId: userId,
      sessionId: req.session?.uuid,
      ...auditBase(req),
      details: { storage: 'gcs', byteSize: result.byteSize },
    });

    return res.status(201).json({
      message: 'Encrypted archive stored. It is encrypted with the application key and expires automatically.',
      location: result.gsUri,
      byteSize: result.byteSize,
      checksum: result.checksum,
      expiresAt: result.expiresAt,
    });
  })
);

/** Flatten tracking data to CSV for spreadsheet users. */
function toCsv(payload) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Guard against CSV injection: a cell starting with =, +, -, @ or a tab is
    // executed as a formula by Excel and Sheets. Prefix with an apostrophe.
    const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };

  const lines = [];
  lines.push('# tracalorie.user-export/v1');
  lines.push(`# generated_at,${escape(payload.export.generatedAt)}`);
  lines.push(`# user_id,${escape(payload.profile.id)}`);
  lines.push('');

  lines.push('## items');
  lines.push('id,type,name,calories,entry_date,created_at');
  for (const item of payload.tracking.items) {
    lines.push([item.id, item.type, item.name, item.calories, item.entry_date, item.created_at].map(escape).join(','));
  }

  lines.push('');
  lines.push('## foods');
  lines.push('id,type,name,calories,times_used,last_used');
  for (const food of payload.tracking.foods) {
    lines.push([food.id, food.type, food.name, food.calories, food.times_used, food.last_used].map(escape).join(','));
  }

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// DELETE /api/security/account  — GDPR Article 17
// -----------------------------------------------------------------------------
router.delete(
  '/account',
  writeLimiter,
  validate({ body: schemas.deleteAccount }),
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const base = auditBase(req);

    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!rows[0]) throw notFound('User not found', 'user_not_found');

    // Step-up authentication. Without this, anyone who obtains a session cookie
    // (XSS, shared device, session riding) could destroy the account.
    if (!(await password.verify(req.body.password, rows[0].password_hash))) {
      await audit.record({
        action: audit.EVENTS.ACCOUNT_DELETED,
        outcome: 'failure',
        actorId: userId,
        ...base,
        details: { reason: 'incorrect_password' },
      });
      throw unauthorized('Password is incorrect', 'invalid_credentials');
    }

    // Soft-delete first: the account is unusable immediately, and a background
    // job hard-deletes PII after the retention window. The audit chain keeps
    // working because security_audit.actor_id is ON DELETE SET NULL, so history
    // survives while the personal data does not.
    await transaction(async (client) => {
      await client.query(
        `UPDATE users
         SET status = 'pending_deletion', deletion_requested_at = now(), token_epoch = token_epoch + 1
         WHERE id = $1`,
        [userId]
      );
      await client.query(
        `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'account_deleted'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
    });

    await audit.record({
      action: audit.EVENTS.ACCOUNT_DELETED,
      actorId: null,
      ...base,
      details: { userId, mode: 'soft_delete', retentionDays: 30 },
    });

    res.clearCookie(sessions.cookieName(sessions.COOKIE_ACCESS), sessions.cookieOptions());
    res.clearCookie(
      sessions.cookieName(sessions.COOKIE_REFRESH),
      sessions.cookieOptions({ path: sessions.REFRESH_COOKIE_PATH })
    );

    logger.info('privacy.account_deleted', { userId, requestId: req.id });

    return res.json({
      message: 'Your account has been scheduled for deletion. All sessions are signed out and personal data is removed within 30 days.',
      deletedAt: new Date().toISOString(),
    });
  })
);

// -----------------------------------------------------------------------------
// GET /api/security/profile  — decrypted profile, for the settings screen
// -----------------------------------------------------------------------------
router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    // lint:sql-safe USER_COLUMNS is a literal column-list constant.
    const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.user.id]);
    return res.json({ user: presentUser(rows[0]) });
  })
);

module.exports = { router, collectUserData };
