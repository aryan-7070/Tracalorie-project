'use strict';

/**
 * Calorie entry routes.
 *
 * Ownership is enforced two ways: every statement filters on `user_id`, and the
 * id parameter is coerced to a bounded integer by the schema. A guessed id
 * belonging to another user matches zero rows and returns 404 — the response
 * does not distinguish "not yours" from "does not exist", so ids cannot be
 * probed for existence.
 */

const express = require('express');
const { query, transaction } = require('../db');
const { requireAuth, asyncHandler } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter, heavyLimiter } = require('../middleware/rateLimit');
const schemas = require('../schemas');
const { notFound, badRequest } = require('../lib/errors');

const router = express.Router();

router.use(requireAuth);

/**
 * Coerce a client-supplied date into the server's UTC day.
 * Rejects far-future or far-past entries, which are always mistakes and would
 * otherwise let a single row distort the streak and badge calculations.
 */
function resolveEntryDate(raw) {
  if (!raw) return null;

  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest('entryDate is not a valid date', 'invalid_entry_date');
  }

  const now = new Date();
  const maxPast = new Date(now.getTime() - 365 * 86_400_000);
  const tomorrow = new Date(now.getTime() + 86_400_000);

  if (parsed < maxPast || parsed > tomorrow) {
    throw badRequest('entryDate must be within the last 365 days and not in the future', 'entry_date_out_of_range');
  }

  return raw;
}

// GET /api/items
router.get(
  '/',
  heavyLimiter,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, type, name, calories, entry_date, created_at
       FROM items
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 500`,
      [req.user.id]
    );

    const userResult = await query('SELECT calorie_limit FROM users WHERE id = $1', [req.user.id]);
    const calorieLimit = userResult.rows[0]?.calorie_limit ?? 2000;

    return res.json({
      meals: rows.filter((r) => r.type === 'meal'),
      workouts: rows.filter((r) => r.type === 'workout'),
      calorieLimit,
    });
  })
);

// POST /api/items
router.post(
  '/',
  writeLimiter,
  validate({ body: schemas.createItem }),
  asyncHandler(async (req, res) => {
    const { type, name, calories, entryDate } = req.body;
    const date = resolveEntryDate(entryDate);

    // One transaction: an entry and its library upsert must both land or
    // neither, otherwise the food library drifts out of sync with the log.
    const created = await transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO items (user_id, type, name, calories, entry_date)
         VALUES ($1, $2, $3, $4, COALESCE($5::date, (now() AT TIME ZONE 'UTC')::date))
         RETURNING id, type, name, calories, entry_date, created_at`,
        [req.user.id, type, name, calories, date]
      );

      await client.query(
        `INSERT INTO foods (user_id, type, name, calories)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, type, name)
         DO UPDATE SET
           calories = EXCLUDED.calories,
           times_used = foods.times_used + 1,
           last_used = now()`,
        [req.user.id, type, name, calories]
      );

      return rows[0];
    });

    return res.status(201).json(created);
  })
);

// PATCH /api/items/:id
router.patch(
  '/:id',
  writeLimiter,
  validate({ params: schemas.idParam, body: schemas.createItem.partial() }),
  asyncHandler(async (req, res) => {
    const date = resolveEntryDate(req.body.entryDate);

    // Build the SET clause and the parameter array together, so placeholders
    // stay contiguous and every parameter is actually referenced. (Postgres
    // rejects a query whose highest placeholder exceeds its parameter count, and
    // an unreferenced $n has no inferable type.)
    //
    // Column names come from this literal map, never from the request, so the
    // identifier list cannot be influenced by a client.
    const allowed = { type: 'type', name: 'name', calories: 'calories', entryDate: 'entry_date' };
    const sets = [];
    const values = [req.params.id];

    for (const [key, column] of Object.entries(allowed)) {
      if (req.body[key] === undefined) continue;
      values.push(req.body[key]);
      sets.push(`${column} = $${values.length}`);
    }

    if (sets.length === 0) {
      throw badRequest('Provide at least one field to update', 'no_fields');
    }

    // Ownership filter is part of the same statement, so there is no window in
    // which a row belonging to another user is read before being rejected.
    values.push(req.user.id);

    const { rows } = await query(
      // lint:sql-safe `sets` is assembled above from a literal column allowlist.
      `UPDATE items SET ${sets.join(', ')} WHERE id = $1 AND user_id = $${values.length}
       RETURNING id, type, name, calories, entry_date, created_at`,
      values
    );

    if (!rows[0]) throw notFound('Item not found', 'item_not_found');
    return res.json(rows[0]);
  })
);

// DELETE /api/items/:id
router.delete(
  '/:id',
  writeLimiter,
  validate({ params: schemas.idParam }),
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM items WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);

    if (rowCount === 0) throw notFound('Item not found', 'item_not_found');
    return res.status(204).end();
  })
);

// DELETE /api/items
router.delete(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM items WHERE user_id = $1', [req.user.id]);
    return res.json({ deleted: rowCount });
  })
);

module.exports = router;
