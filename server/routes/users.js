'use strict';

/** User settings. Retained for the documented `/api/user/limit` contract. */

const express = require('express');
const { query } = require('../db');
const { requireAuth, asyncHandler } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../schemas');
const audit = require('../lib/audit');
const { auditBase } = require('./auth');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/limit',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT calorie_limit FROM users WHERE id = $1', [req.user.id]);
    return res.json({ calorieLimit: rows[0]?.calorie_limit ?? 2000 });
  })
);

router.patch(
  '/limit',
  writeLimiter,
  validate({ body: schemas.updateLimit }),
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('UPDATE users SET calorie_limit = $1 WHERE id = $2', [
      req.body.calorieLimit,
      req.user.id,
    ]);

    if (rowCount === 0) {
      return res.status(404).json({ error: { code: 'user_not_found', message: 'User not found' } });
    }

    await audit.record({
      action: audit.EVENTS.PROFILE_UPDATED,
      actorId: req.user.id,
      sessionId: req.session?.uuid,
      ...auditBase(req),
      details: { fields: ['calorieLimit'] },
    });

    return res.status(204).end();
  })
);

module.exports = router;
