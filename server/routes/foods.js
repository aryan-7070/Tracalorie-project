'use strict';

/** Saved food library. Same ownership model as items. */

const express = require('express');
const { query } = require('../db');
const { requireAuth, asyncHandler } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter, heavyLimiter } = require('../middleware/rateLimit');
const schemas = require('../schemas');
const { notFound, badRequest } = require('../lib/errors');

const router = express.Router();

router.use(requireAuth);

// Upstream is a public, keyless API; results are untrusted input, so only the
// fields we own are copied out and every value is coerced/trimmed here.
const OFF_SEARCH_URL = 'https://world.openfoodfacts.org/cgi/search.pl';
const LOOKUP_TIMEOUT_MS = 5000;

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeOffProduct(product) {
  if (!product || typeof product !== 'object') return null;
  const name = typeof product.product_name === 'string' ? product.product_name.trim() : '';
  if (!name) return null;
  return {
    code: typeof product.code === 'string' ? product.code : null,
    name: name.slice(0, 200),
    brand: typeof product.brands === 'string' ? product.brands.trim().slice(0, 100) || null : null,
    calories: toNumberOrNull(product['energy-kcal_100g']),
    protein: toNumberOrNull(product.proteins_100g),
    carbs: toNumberOrNull(product.carbohydrates_100g),
    fat: toNumberOrNull(product.fat_100g),
  };
}

router.get(
  '/lookup',
  heavyLimiter,
  validate({ query: schemas.foodLookupQuery }),
  asyncHandler(async (req, res) => {
    const params = new URLSearchParams({
      search_terms: req.query.q,
      search_simple: '1',
      action: 'process',
      json: '1',
      page_size: '10',
      fields: 'code,product_name,brands,energy-kcal_100g,proteins_100g,carbohydrates_100g,fat_100g',
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

    let data;
    try {
      const response = await fetch(`${OFF_SEARCH_URL}?${params}`, {
        signal: controller.signal,
        headers: { 'user-agent': 'Tracalorie/2.0 (food lookup)' },
      });
      if (!response.ok) throw new Error(`Upstream responded ${response.status}`);
      data = await response.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw badRequest('Food search timed out, try again', 'lookup_timeout');
      }
      throw badRequest('Food search is unavailable right now, try again', 'lookup_unavailable');
    } finally {
      clearTimeout(timer);
    }

    const products = Array.isArray(data?.products) ? data.products : [];
    const results = products.map(normalizeOffProduct).filter(Boolean);
    return res.json({ results });
  })
);

router.get(
  '/',
  heavyLimiter,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, type, name, calories, protein_g, carbs_g, fat_g, times_used, last_used
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
    const { type, name, calories, protein, carbs, fat } = req.body;

    const { rows } = await query(
      `INSERT INTO foods (user_id, type, name, calories, protein_g, carbs_g, fat_g)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, type, name)
       DO UPDATE SET
         calories = EXCLUDED.calories,
         protein_g = EXCLUDED.protein_g,
         carbs_g = EXCLUDED.carbs_g,
         fat_g = EXCLUDED.fat_g,
         times_used = foods.times_used + 1,
         last_used = now()
       RETURNING id, type, name, calories, protein_g, carbs_g, fat_g, times_used, last_used`,
      [req.user.id, type, name, calories, protein ?? null, carbs ?? null, fat ?? null]
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
