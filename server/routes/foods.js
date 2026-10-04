'use strict';

/** Saved food library. Same ownership model as items. */

const express = require('express');
const { query } = require('../db');
const { requireAuth, asyncHandler } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter, heavyLimiter } = require('../middleware/rateLimit');
const schemas = require('../schemas');
const { notFound } = require('../lib/errors');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/',
  heavyLimiter,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, type, name, calories, times_used, last_used
       FROM foods
       WHERE user_id = $1
       ORDER BY last_used DESC NULLS LAST, times_used DESC
       LIMIT 200`,
      [req.user.id]
    );
    return res.json(rows);
  })
);

router.post(
  '/',
  writeLimiter,
  validate({ body: schemas.createFood }),
  asyncHandler(async (req, res) => {
    const { type, name, calories } = req.body;

    const { rows } = await query(
      `INSERT INTO foods (user_id, type, name, calories)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, type, name)
       DO UPDATE SET
         calories = EXCLUDED.calories,
         times_used = foods.times_used + 1,
         last_used = now()
       RETURNING id, type, name, calories, times_used, last_used`,
      [req.user.id, type, name, calories]
    );

    return res.status(201).json(rows[0]);
  })
);

router.delete(
  '/:id',
  writeLimiter,
  validate({ params: schemas.idParam }),
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM foods WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);

    if (rowCount === 0) throw notFound('Food not found', 'food_not_found');
    return res.status(204).end();
  })
);

module.exports = router;
