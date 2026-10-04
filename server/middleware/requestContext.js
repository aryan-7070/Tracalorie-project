'use strict';

/**
 * Request correlation.
 *
 * Every request gets an id, taken from a trusted inbound `X-Request-ID` when it
 * looks sane and generated otherwise. The id is attached to the logger context,
 * returned in the response header, and stored on audit rows, so a user-reported
 * failure can be traced end to end.
 *
 * The inbound value is validated because an attacker-controlled request id ends
 * up in logs; unbounded strings are a log-injection and storage-bloat vector.
 */

const crypto = require('crypto');
const { logger } = require('../lib/logger');

const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

function requestContext(req, res, next) {
  const inbound = req.headers['x-request-id'];
  const requestId =
    typeof inbound === 'string' && SAFE_ID.test(inbound) ? inbound : crypto.randomUUID();

  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);

  // Narrow the logger scope to this request.
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
  });

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // 5xx is a server fault and always logged; 4xx is the client's problem and
    // would drown the log, so it is debug-only.
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'debug' : 'info';

    req.log[level]('request.completed', {
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.clientIp,
      userId: req.user?.id,
    });
  });

  next();
}

module.exports = { requestContext };
