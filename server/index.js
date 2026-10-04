'use strict';

/**
 * Process entry point.
 *
 * Responsibilities that belong here rather than in app.js: binding the socket,
 * failing fast if configuration is invalid, and shutting down cleanly. A
 * container that is SIGKILLed mid-transaction because it ignored SIGTERM loses
 * in-flight writes and leaves connections dangling during a rolling deploy.
 */

const config = require('./config/env');
const { createApp } = require('./app');
const { close: closePool, healthcheck } = require('./db');
const { purgeExpiredSessions } = require('./lib/sessions');
const { detectCredentialStuffing } = require('./lib/findings');
const { logger } = require('./lib/logger');

const app = createApp();

let server;
let shuttingDown = false;
let housekeepingTimer = null;

async function start() {
  // Fail fast: booting without a reachable database only defers the error to
  // the first request, which in a container looks like a healthy start.
  try {
    const db = await healthcheck();
    logger.info('database.connected', db);
  } catch (err) {
    logger.fatal('Database unreachable at startup', { err });
    process.exit(1);
  }

  await startHousekeeping();

  server = app.listen(config.port, () => {
    logger.info('server.started', {
      port: config.port,
      env: config.nodeEnv,
      pid: process.pid,
      node: process.version,
    });
  });

  // Slowloris defence: cap how long a client may take to send its headers and
  // body. Without these, a handful of connections held open exhausts the pool.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000; // must exceed a typical load balancer's 60s
  server.maxHeadersCount = 100;
}

/**
 * Periodic maintenance.
 *
 * `setInterval` here rather than an external cron so a single-container
 * deployment still cleans up. Documented as the thing to move to Cloud Scheduler
 * or a Kubernetes CronJob once running at scale.
 */
function startHousekeeping() {
  const RUN_EVERY_MS = 15 * 60_000;

  const run = async () => {
    try {
      const purged = await purgeExpiredSessions();
      if (purged > 0) logger.info('housekeeping.sessions_purged', { purged });
    } catch (err) {
      logger.error('housekeeping.failed', { err });
    }
  };

  run();
  housekeepingTimer = setInterval(run, RUN_EVERY_MS);
  // Do not hold the event loop open purely for housekeeping.
  housekeepingTimer.unref();
}

/**
 * Graceful shutdown.
 *
 * Order matters: stop accepting new connections, let in-flight requests finish,
 * then close the database pool. Draining first is what prevents dropped
 * requests during a rolling deploy.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('server.shutdown_started', { signal });

  // Hard ceiling so a stuck connection cannot block a deploy indefinitely.
  const forceTimer = setTimeout(() => {
    logger.error('server.shutdown_forced', { afterMs: 10_000 });
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  try {
    if (housekeepingTimer) clearInterval(housekeepingTimer);

    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info('server.http_closed');
    }

    await closePool();
    logger.info('server.database_closed');

    clearTimeout(forceTimer);
    logger.info('server.shutdown_complete', { signal });
    process.exit(0);
  } catch (err) {
    logger.error('server.shutdown_failed', { err, signal });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// An unhandled rejection means a bug or a broken invariant. Log it with full
// context and exit non-zero so the orchestrator replaces this instance rather
// than leaving it in an unknown state.
process.on('unhandledRejection', (reason) => {
  logger.fatal('unhandled_rejection', { reason, stack: reason?.stack });
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  // State is unknown after an uncaught exception, so a graceful drain is not
  // trustworthy. Exit immediately and let the platform restart us.
  logger.fatal('uncaught_exception', { err, stack: err.stack });
  process.exit(1);
});

start().catch((err) => {
  logger.fatal('server.start_failed', { err });
  process.exit(1);
});

module.exports = { app, shutdown, detectCredentialStuffing };
