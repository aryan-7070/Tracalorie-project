'use strict';

/**
 * Application error taxonomy.
 *
 * Every error surfaced to a client is an AppError with an explicit HTTP status
 * and a stable machine-readable `code`. Anything that is *not* an AppError is
 * treated as an unexpected failure: logged with detail, reported to the client
 * as an opaque 500 with a correlation id.
 */

class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details, expose = true } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
    this.expected = true;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.expose ? this.message : 'Internal server error',
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

const badRequest = (message, code = 'bad_request', details) =>
  new AppError(message, { status: 400, code, details });

const validationFailed = (details) =>
  new AppError('Request validation failed', { status: 422, code: 'validation_failed', details });

const unauthorized = (message = 'Authentication required', code = 'unauthorized') =>
  new AppError(message, { status: 401, code });

const forbidden = (message = 'You do not have access to this resource', code = 'forbidden') =>
  new AppError(message, { status: 403, code });

const notFound = (message = 'Resource not found', code = 'not_found') =>
  new AppError(message, { status: 404, code });

const conflict = (message, code = 'conflict') => new AppError(message, { status: 409, code });

const tooManyRequests = (message = 'Too many requests', code = 'rate_limited', details) =>
  new AppError(message, { status: 429, code, details });

const internal = (message = 'Internal server error', code = 'internal_error') =>
  new AppError(message, { status: 500, code, expose: false });

module.exports = {
  AppError,
  badRequest,
  validationFailed,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooManyRequests,
  internal,
};
