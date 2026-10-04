'use strict';

/**
 * Migration runner.
 *
 * Applies every `sql/NNN_*.sql` file in order, exactly once, inside a
 * transaction, tracked in `schema_migrations`. Safe to run on every deploy.
 *
 * `npm run migrate`             apply pending migrations
 * `npm run migrate:status`      show applied / pending
 * `npm run migrate:fresh`       drop and recreate (dev only, refuses in prod)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool, query } = require('./db');
const config = require('./config/env');

const SQL_DIR = path.join(__dirname, 'sql');

function listMigrations() {
  if (!fs.existsSync(SQL_DIR)) return [];
  return fs
    .readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const raw = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
      return {
        version: file.replace(/\.sql$/, ''),
        file,
        sql: raw,
        checksum: crypto.createHash('sha256').update(raw, 'utf8').digest('hex'),
      };
    });
}

async function ensureMigrationsTable() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    checksum   TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function appliedVersions() {
  const { rows } = await query('SELECT version, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

async function status() {
  await ensureMigrationsTable();
  const applied = await appliedVersions();
  const migrations = listMigrations();

  const rows = migrations.map((m) => ({
    version: m.version,
    applied: applied.has(m.version),
    drift: applied.has(m.version) && applied.get(m.version) !== m.checksum,
  }));

  return { migrations: rows, pending: rows.filter((r) => !r.applied).length };
}

async function migrate() {
  await ensureMigrationsTable();
  const applied = await appliedVersions();
  const migrations = listMigrations();

  const pending = migrations.filter((m) => !applied.has(m.version));

  if (pending.length === 0) {
    console.log(`Schema up to date (${migrations.length} migration(s) applied).`);
    return;
  }

  // An already-applied migration whose file changed means the migration history
  // was rewritten. That silently invalidates every audit row hashed under the
  // old definition, so refuse rather than drift.
  for (const m of migrations) {
    const previous = applied.get(m.version);
    if (previous && previous !== m.checksum) {
      throw new Error(
        `Migration ${m.version} was modified after being applied ` +
          `(recorded ${previous.slice(0, 12)}…, file ${m.checksum.slice(0, 12)}…). ` +
          'Applied migrations are immutable. Add a new migration instead.'
      );
    }
  }

  for (const m of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)
         ON CONFLICT (version) DO NOTHING`,
        [m.version, m.checksum]
      );
      await client.query('COMMIT');
      console.log(`  applied  ${m.version}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${m.version} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`Applied ${pending.length} migration(s).`);
}

async function fresh() {
  if (config.isProduction) {
    throw new Error('migrate:fresh is refused in production. Drop the database explicitly if you mean it.');
  }
  console.log('Dropping public schema...');
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
}

async function main() {
  const command = process.argv[2] || 'up';

  if (command === 'status') {
    const { migrations, pending } = await status();
    console.table(migrations);
    console.log(pending === 0 ? 'Up to date.' : `${pending} pending.`);
    return;
  }

  if (command === 'fresh') return fresh();
  return migrate();
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`\nMigration failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { migrate, status, fresh, listMigrations };
