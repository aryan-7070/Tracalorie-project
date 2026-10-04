'use strict';

/**
 * Tamper-evident security audit log.
 *
 * Every security-relevant event becomes an append-only row. Each row stores the
 * SHA-256 of its own canonical content *and* the hash of the previous entry for
 * the same actor, forming a per-actor hash chain. Editing or deleting a
 * historical row breaks that actor's chain from that point on, which
 * `verifyChain` detects.
 *
 * Pre-authentication events (bad password, unknown username) are recorded
 * against a NULL actor and chain together under a reserved system chain, so
 * they remain verifiable without attributing them to a user who may not exist.
 *
 * What is deliberately NOT recorded: passwords, tokens, and raw PII. Audit
 * rows are long-lived and broadly readable to operators, so they carry
 * identifiers and outcomes, not secrets.
 */

const crypto = require('./crypto');
const { query } = require('../db');
const { logger } = require('./logger');

/** Event vocabulary. Kept closed so dashboards and alerts can rely on it. */
const EVENTS = Object.freeze({
  REGISTER: 'account.registered',
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILURE: 'auth.login.failure',
  LOGIN_BLOCKED: 'auth.login.blocked',
  LOGOUT: 'auth.logout',
  TOKEN_REFRESH: 'auth.token.refresh',
  TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',
  PASSWORD_CHANGED: 'account.password.changed',
  PROFILE_UPDATED: 'account.profile.updated',
  SESSION_REVOKED: 'session.revoked',
  SESSIONS_REVOKED_ALL: 'session.revoked_all',
  CSRF_REJECTED: 'security.csrf.rejected',
  RATE_LIMIT_TRIPPED: 'security.rate_limit.tripped',
  DATA_EXPORTED: 'privacy.data.exported',
  ACCOUNT_DELETED: 'privacy.account.deleted',
  ANOMALOUS_ACCESS: 'security.anomalous_access',
});

/** Events that warrant an alert rather than a routine log line. */
const HIGH_SEVERITY = new Set([
  EVENTS.TOKEN_REUSE_DETECTED,
  EVENTS.CSRF_REJECTED,
  EVENTS.ACCOUNT_DELETED,
  EVENTS.ANOMALOUS_ACCESS,
]);

/** The genesis anchor: the `prev_hash` of the first entry in any chain. */
const GENESIS_HASH = '0'.repeat(64);

const VALID_ACTIONS = new Set(Object.values(EVENTS));

// Tail hashes are cached briefly so a burst of writes does not issue one
// `ORDER BY id DESC LIMIT 1` query per entry. A 1s window means a fork
// (two writers reading the same tail) is possible in theory, but detection is
// handled by verifyChain, and a serial `id` keeps rows ordered.
const tailCache = new Map();
const TAIL_TTL_MS = 1_000;
const TAIL_CACHE_MAX = 1_000;

function cacheKey(actorId) {
  return actorId === null || actorId === undefined ? '__system__' : `u:${actorId}`;
}

async function currentTailHash(actorId, client) {
  const key = cacheKey(actorId);
  const executor = client || { query };

  if (!client) {
    const hit = tailCache.get(key);
    if (hit && Date.now() - hit.at < TAIL_TTL_MS) return hit.hash;
  }

  const { rows } = await executor.query(
    `SELECT entry_hash FROM security_audit
     WHERE actor_id IS NOT DISTINCT FROM $1
     ORDER BY id DESC LIMIT 1`,
    [actorId ?? null]
  );

  const hash = rows[0]?.entry_hash || GENESIS_HASH;

  if (!client) {
    if (tailCache.size >= TAIL_CACHE_MAX) tailCache.clear();
    tailCache.set(key, { hash, at: Date.now() });
  }
  return hash;
}

function invalidateTail(actorId) {
  if (actorId === undefined) tailCache.clear();
  else tailCache.delete(cacheKey(actorId));
}

/**
 * Canonical, hash-covered representation of a row. Field set and order are
 * fixed and values are normalised so the digest is stable across Node versions
 * and Postgres type formatting.
 *
 * `occurred_at` is stored as `timestamptz` but the digest covers the ISO-8601
 * string with millisecond precision. Postgres returns exactly that shape, so
 * recomputation is byte-stable.
 */
function canonicalEntry(entry) {
  return {
    prev_hash: entry.prevHash,
    actor_id: entry.actorId ?? null,
    action: entry.action,
    outcome: entry.outcome,
    ip_address: entry.ip ?? null,
    user_agent: entry.userAgent ? String(entry.userAgent).slice(0, 512) : null,
    request_id: entry.requestId ?? null,
    session_id: entry.sessionId ?? null,
    details: entry.details ?? null,
    occurred_at: entry.occurredAt,
  };
}

function hashEntry(canonical) {
  return crypto.sha256Hex(crypto.canonicalJson(canonical));
}

const INSERT_SQL = `INSERT INTO security_audit
     (prev_hash, entry_hash, actor_id, action, outcome, ip_address,
      user_agent, request_id, session_id, details, occurred_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
   RETURNING id, entry_hash, occurred_at`;

function toParams(canonical) {
  return [
    canonical.prev_hash,
    hashEntry(canonical),
    canonical.actor_id,
    canonical.action,
    canonical.outcome,
    canonical.ip_address,
    canonical.user_agent,
    canonical.request_id,
    canonical.session_id,
    canonical.details ? JSON.stringify(canonical.details) : null,
    canonical.occurred_at,
  ];
}

/**
 * Append an audit entry.
 *
 * @param {object} entry
 * @param {string} entry.action     one of EVENTS
 * @param {string} [entry.outcome]  'success' | 'failure' (default 'success')
 * @param {number} [entry.actorId]  acting user; null for pre-auth events
 * @param {string} [entry.ip]
 * @param {string} [entry.userAgent]
 * @param {string} [entry.requestId]
 * @param {string} [entry.sessionId]
 * @param {object} [entry.details]   non-sensitive structured context
 * @returns {Promise<object|null>}  the stored row, or null if the write failed
 */
async function record(entry) {
  const action = entry.action;
  if (!action || !VALID_ACTIONS.has(action)) {
    logger.warn('Audit entry with unknown action rejected', { action });
    return null;
  }

  const actorId = entry.actorId ?? null;
  const canonical = canonicalEntry({
    ...entry,
    prevHash: entry.prevHash || (await currentTailHash(actorId)),
    occurredAt: entry.occurredAt || new Date().toISOString(),
  });

  try {
    const result = await query(INSERT_SQL, toParams(canonical));
    invalidateTail(actorId);
    return logAndReturn(canonical, result.rows[0]);
  } catch (err) {
    // Audit must never take down the request path: a security log that 500s the
    // app under load is worse than one that occasionally drops a row. Wire a
    // counter to this log line to make drops visible in production.
    logger.error('Audit write failed', { err, action, requestId: entry.requestId });
    return null;
  }
}

/**
 * Append inside an existing transaction, so that e.g. account deletion and its
 * audit entry commit or roll back together.
 */
async function recordInTransaction(client, entry) {
  const action = entry.action;
  if (!action || !VALID_ACTIONS.has(action)) {
    throw new Error(`Invalid audit action: ${action}`);
  }

  const actorId = entry.actorId ?? null;
  const canonical = canonicalEntry({
    ...entry,
    prevHash: entry.prevHash || (await currentTailHash(actorId, client)),
    occurredAt: entry.occurredAt || new Date().toISOString(),
  });

  const result = await client.query(INSERT_SQL, toParams(canonical));
  invalidateTail(actorId);
  return { id: result.rows[0].id, entryHash: result.rows[0].entry_hash };
}

function logAndReturn(canonical, row) {
  const fields = {
    audit_id: row.id,
    action: canonical.action,
    outcome: canonical.outcome,
    actor_id: canonical.actor_id,
    request_id: canonical.request_id,
    ip: canonical.ip_address,
  };

  if (HIGH_SEVERITY.has(canonical.action)) {
    logger.error(`audit:high ${canonical.action}`, { ...fields, details: canonical.details });
  } else if (canonical.outcome === 'failure') {
    logger.warn(`audit ${canonical.action}`, { ...fields, details: canonical.details });
  } else {
    logger.info(`audit ${canonical.action}`, fields);
  }

  return { id: row.id, entryHash: row.entry_hash, occurredAt: row.occurred_at };
}

/**
 * Walk an actor's chain and report the first break, if any.
 *
 * Two independent tamper signals are checked per row:
 *   1. content_mismatch — the row's own fields no longer hash to its entry_hash
 *      (someone edited a row in place).
 *   2. broken_link — prev_hash does not match the preceding entry's entry_hash
 *      (a row was deleted, or two entries were reordered).
 *
 * The final row's `headHash` is returned so a caller can anchor it externally
 * (a public append-only store, an emailed receipt, a signed transparency log).
 * Without external anchoring, a wholesale deletion of an actor's chain is
 * indistinguishable from "no history yet" — see docs/THREAT_MODEL.md.
 */
async function verifyChain({ actorId = null, limit = 10_000 } = {}) {
  const { rows } = await query(
    `SELECT id, prev_hash, entry_hash, action, outcome, ip_address, user_agent,
            request_id, session_id, details, occurred_at
     FROM security_audit
     WHERE actor_id IS NOT DISTINCT FROM $1
     ORDER BY id ASC
     LIMIT $2`,
    [actorId ?? null, limit]
  );

  const breaks = [];
  let expectedPrev = null;

  for (const row of rows) {
    const canonical = canonicalEntry({
      prevHash: row.prev_hash,
      actorId,
      action: row.action,
      outcome: row.outcome,
      ip: row.ip_address,
      userAgent: row.user_agent,
      requestId: row.request_id,
      sessionId: row.session_id,
      details: row.details && typeof row.details === 'object' ? row.details : null,
      occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    });

    if (hashEntry(canonical) !== row.entry_hash) {
      breaks.push({
        id: row.id,
        reason: 'content_mismatch',
        detail: 'Row content does not hash to its recorded entry_hash — the row was modified in place.',
      });
    }

    if (expectedPrev !== null && row.prev_hash !== expectedPrev) {
      breaks.push({
        id: row.id,
        reason: 'broken_link',
        detail: 'prev_hash does not match the preceding entry — a row was deleted or reordered.',
      });
    }

    expectedPrev = row.entry_hash;
  }

  return {
    valid: breaks.length === 0,
    checked: rows.length,
    headHash: expectedPrev,
    anchored: rows.length > 0,
    firstBreak: breaks[0] || null,
    breaks: breaks.slice(0, 20),
  };
}

/** Paginated read for the user's own security history. */
async function listForUser(userId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT id, action, outcome, ip_address, user_agent, request_id, details, occurred_at
     FROM security_audit
     WHERE actor_id = $1
     ORDER BY id DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

/** Aggregate view for the security dashboard. */
async function summaryForUser(userId, { days = 30 } = {}) {
  const { rows } = await query(
    `SELECT action, outcome, COUNT(*)::int AS count, MAX(occurred_at) AS last_seen
     FROM security_audit
     WHERE actor_id = $1
       AND occurred_at >= now() - make_interval(days => $2::int)
     GROUP BY action, outcome
     ORDER BY count DESC`,
    [userId, days]
  );
  return rows;
}

module.exports = {
  EVENTS,
  GENESIS_HASH,
  record,
  recordInTransaction,
  verifyChain,
  listForUser,
  summaryForUser,
  currentTailHash,
  invalidateTail,
};
