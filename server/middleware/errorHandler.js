'use strict';

/**
 * Terminal error handling.
 *
 * Two rules:
 *   1. Clients never receive an unexpected error's message, stack, SQL text or
 *      driver detail. A Postgres error can leak table and column names; a
 *      driver error can leak file paths. Unexpected errors become an opaque 500
 *      plus a correlation id.
 *   2. Every unexpected error is logged with full context server-side, so
 *      nothing is lost while the response stays safe.
 *
 * Known AppErrors pass through with their intentional status and message.
 */

const { AppError } = require('../lib/errors');
const config = require('../config/env');
const { logger } = require('../lib/logger');

/** Postgres error codes that are safe to summarise for the client. */
const PG_SAFE = new Set([
  '23505', // unique_violation
  '23503', // foreign_key_violation
  '23514', // check_violation
  '22001', // string_data_right_truncation
  '22P02', // invalid_text_representation
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

/** Translate a driver error into a safe, meaningful response. */
function translatePgError(err) {
  if (!err.code || !PG_SAFE.has(err.code)) return null;

  switch (err.code) {
    case '23505':
      return new AppError('That value is already taken', {
        status: 409,
        code: 'duplicate_value',
      });
    case '23503':
      return new AppError('Referenced resource does not exist', {
        status: 409,
        code: 'referenced_resource_missing',
      });
    case '23514':
      return new AppError('Value failed a database constraint', {
        status: 422,
        code: 'constraint_violation',
      });
    case '22P02':
      return new AppError('Malformed value in request', {
        status: 400,
        code: 'malformed_value',
      });
    case '40001':
    case '40P01':
      return new AppError('Please retry your request', {
        status: 409,
        code: 'concurrent_modification',
      });
    default:
      return null;
  }
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
function errorHandler(err, req, res, next) {
  // Express 5 still routes thrown errors here, but guard against a handler
  // being invoked after the response has already been flushed.
  if (res.headersSent) {
    return next(err);
  }

  const log = req.log || logger;

  if (err instanceof AppError) {
    if (err.status >= 500) {
      log.error('request.failed', { err, code: err.code });
    } else {
      log.warn('request.rejected', { code: err.code, status: err.status, path: req.path });
    }

    if (err.code === 'csrf_failed') {
      return res.status(403).json({
        ...err.toJSON(),
        // Tells the client to refresh its CSRF token and retry once.
        retryable: true,
      });
    }

    return res.status(err.status).json(err.toJSON());
  }

  const translated = translatePgError(err);
  if (translated) {
    log.warn('request.db_rejected', { code: err.code, constraint: err.constraint, path: req.path });
    return res.status(translated.status).json(translated.toJSON());
  }

  // Malformed JSON from body-parser.
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({
      error: { code: 'malformed_json', message: 'Request body is not valid JSON' },
    });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'payload_too_large', message: 'Request body exceeds the allowed size' },
    });
  }

  if (err.type === 'encoding.unsupported') {
    return res.status(415).json({
      error: { code: 'unsupported_encoding', message: 'Unsupported content encoding' },
    });
  }

  log.error('request.unhandled_error', {
    err,
    path: req.path,
    method: req.method,
    ip: req.clientIp,
    userId: req.user?.id,
    // Present in the response body, absent from the logs, so the user can quote
    // it when reporting the problem.
    userFacingRequestId: req.id,
  });

  return res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'An unexpected error occurred. Our team has been notified.',
      requestId: req.id,
    },
    ...(config.isProduction ? {} : { debug: { message: err.message, type: err.type } }),
  });
}

/** 404 for unmatched routes, so an unknown path does not fall through. */
function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'route_not_found',
      message: `No route matches ${req.method} ${req.path}`,
      requestId: req.id,
    },
  });
}

module.exports = { errorHandler, notFoundHandler, translatePgError };
