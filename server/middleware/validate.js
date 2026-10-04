'use strict';

/**
 * Schema validation.
 *
 * Every mutating endpoint declares a zod schema for body, query and params.
 * The parsed and coerced result replaces the raw input, so handlers can never
 * accidentally read an unvalidated field.
 *
 * Unknown keys are stripped rather than passed through. This is a cheap,
 * meaningful defence: it prevents mass-assignment, where a client sends
 * `{ role: "admin" }` to a profile-update endpoint and the handler copies the
 * whole body into an UPDATE.
 */

const { ZodError } = require('zod');
const { validationFailed } = require('../lib/errors');

/** Flatten a ZodError into `[{ path, message, code }]` for the API response. */
function formatIssues(err) {
  return err.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Build validation middleware.
 *
 * @param {object} schemas
 * @param {import('zod').ZodTypeAny} [schemas.body]
 * @param {import('zod').ZodTypeAny} [schemas.query]
 * @param {import('zod').ZodTypeAny} [schemas.params]
 */
function validate(schemas = {}) {
  return (req, res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) {
        // Express 5 exposes req.query via a getter with no setter. Assign to a
        // separate field rather than fighting it.
        req.validatedQuery = schemas.query.parse(req.query);
      }
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      return next();
    } catch (err) {
      if (err instanceof ZodError) {
        return next(validationFailed(formatIssues(err)));
      }
      return next(err);
    }
  };
}

module.exports = { validate, formatIssues };
