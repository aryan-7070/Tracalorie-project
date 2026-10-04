'use strict';

/**
 * PostgreSQL connection pool.
 *
 * Hardened defaults: server-side statement timeout so a pathological query
 * cannot pin a connection, TLS required outside development, and idle-client
 * eviction so a rolling deploy does not leak sockets.
 */

const { Pool, types } = require('pg');
const config = require('./config/env');
const { logger } = require('./lib/logger');

// Return BIGINT/NUMERIC as JS numbers rather than strings. Safe here because
// no column in this schema can exceed 2^53.
types.setTypeParser(types.builtins.INT8, (v) => Number(v));
types.setTypeParser(types.builtins.NUMERIC, (v) => Number(v));

const poolConfig = {
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  max: config.db.max,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
  idleTimeoutMillis: 30_000,
  statement_timeout: config.db.statementTimeoutMillis,
  query_timeout: config.db.statementTimeoutMillis + 2_000,
  application_name: `tracalorie-api:${config.nodeEnv}`,
};

if (config.db.password) poolConfig.password = config.db.password;

if (config.db.ssl) {
  poolConfig.ssl = {
    rejectUnauthorized: config.db.sslRejectUnauthorized,
    // Managed providers (Cloud SQL, Neon, Supabase, RDS) terminate TLS with a
    // certificate that is not in the system store, hence the explicit CA knob.
    ...(process.env.PGSSLROOTCERT
      ? { ca: require('fs').readFileSync(process.env.PGSSLROOTCERT, 'utf8') }
      : {}),
  };
}

const pool = new Pool(poolConfig);

// An idle client erroring out (network blip, DB restart, failover) emits on
// the pool. Without a handler this is an unhandled 'error' event and takes the
// process down. Clients are evicted automatically; the next checkout reconnects.
pool.on('error', (err) => {
  logger.error('Idle database client error', { err, code: err.code });
});

/** Run a parameterised query on a pooled connection. */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * throw. The client is always released.
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Transaction rollback failed', { err: rollbackErr });
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Liveness/readiness probe used by the orchestrator and the CI suite. */
async function healthcheck() {
  const started = process.hrtime.bigint();
  const result = await pool.query('SELECT 1 AS ok');
  const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    ok: result.rows[0]?.ok === 1,
    latencyMs: Math.round(latencyMs * 100) / 100,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, transaction, healthcheck, close };
