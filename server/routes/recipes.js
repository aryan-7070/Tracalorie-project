'use strict';

/**
 * Recipes router: CRUD over user-owned meal templates and "log this recipe"
 * which inserts a meal into `items` in one transaction, scaling by servings.
 *
 * Totals are cached on the `recipes` row (so the list is cheap to read) and
 * recomputed when ingredients change — no derived queries on read.
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

async function recomputeTotals(client, recipeId) {
  const { rows } = await client.query(
    `SELECT
       COALESCE(SUM(calories), 0) AS calories,
       COALESCE(SUM(protein_g), 0) AS protein_g,
       COALESCE(SUM(carbs_g), 0) AS carbs_g,
       COALESCE(SUM(fat_g), 0) AS fat_g,
       COUNT(*) AS cnt
     FROM recipe_ingredients
     WHERE recipe_id = $1`,
    [recipeId]
  );
  const c = rows[0] || { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, cnt: 0 };
  await client.query(
    `UPDATE recipes
     SET calories = COALESCE($2, 0),
         protein_g = COALESCE($3, 0),
         carbs_g = COALESCE($4, 0),
         fat_g = COALESCE($5, 0),
         updated_at = now()
     WHERE id = $1`,
    [recipeId, c.calories, c.protein_g, c.carbs_g, c.fat_g]
  );
  return c;
}

router.get(
  '/',
  heavyLimiter,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT r.id, r.name, r.description, r.servings,
              r.calories, r.protein_g, r.carbs_g, r.fat_g,
              r.created_at,
              (SELECT COUNT(*)::int FROM recipe_ingredients ri WHERE ri.recipe_id = r.id) AS ingredient_count
       FROM recipes r
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    return res.json(rows);
  })
);

router.get(
  '/:id',
  heavyLimiter,
  validate({ params: schemas.idParam }),
  asyncHandler(async (req, res) => {
    const r = await query(`SELECT id,user_id,name,description,servings,calories,protein_g,carbs_g,fat_g,created_at,updated_at FROM recipes WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    if (!r.rows[0]) throw notFound('Recipe not found', 'recipe_not_found');
    const ing = await query(`SELECT id,recipe_id,name,amount,calories,protein_g,carbs_g,fat_g FROM recipe_ingredients WHERE recipe_id=$1`, [req.params.id]);
    return res.json({ ...r.rows[0], ingredients: ing.rows });
  })
);

router.post(
  '/',
  writeLimiter,
  validate({ body: schemas.createRecipe }),
  asyncHandler(async (req, res) => {
    const { name, description, servings, ingredients = [] } = req.body;
    const created = await transaction(async (client) => {
      const rec = await client.query(
        `INSERT INTO recipes (user_id, name, description, servings)
         VALUES ($1, $2, $3, COALESCE($4, 1))
         RETURNING id, name, description, servings, calories, protein_g, carbs_g, fat_g, created_at, updated_at`,
        [req.user.id, name, description || null, servings]
      );
      const recipe = rec.rows[0];
      for (const ing of ingredients) {
        await client.query(
          `INSERT INTO recipe_ingredients
             (recipe_id, name, amount, calories, protein_g, carbs_g, fat_g)
           VALUES ($1,$2,COALESCE($3,1),$4,$5,$6,$7)`,
          [
            recipe.id,
            ing.name,
            ing.amount,
            ing.calories,
            ing.protein ?? null,
            ing.carbs ?? null,
            ing.fat ?? null,
          ]
        );
      }
      await recomputeTotals(client, recipe.id);
      const full = await client.query(`SELECT id,user_id,name,description,servings,calories,protein_g,carbs_g,fat_g,created_at,updated_at FROM recipes WHERE id=$1`, [recipe.id]);
      return full.rows[0];
    });
    return res.status(201).json(created);
  })
);

router.patch(
  '/:id',
  writeLimiter,
  validate({ params: schemas.idParam, body: schemas.updateRecipe }),
  asyncHandler(async (req, res) => {
    await transaction(async (client) => {
      const r = await client.query(`SELECT id FROM recipes WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
      if (!r.rows[0]) throw notFound('Recipe not found', 'recipe_not_found');
      const allowed = { name: 'name', description: 'description', servings: 'servings' };
      const sets = [];
      const values = [req.params.id];
      for (const [k, col] of Object.entries(allowed)) {
        if (req.body[k] === undefined) continue;
        values.push(req.body[k]);
        sets.push(`${col} = $${values.length}`);
      }
      if (sets.length) {
        // lint:sql-safe `sets` is assembled from a literal allowlist of column names.
        await client.query(`UPDATE recipes SET ${sets.join(', ')} WHERE id = $1`, values);
      }
      if (Array.isArray(req.body.ingredients)) {
        await client.query('DELETE FROM recipe_ingredients WHERE recipe_id=$1', [req.params.id]);
        for (const ing of req.body.ingredients) {
          await client.query(
            `INSERT INTO recipe_ingredients
               (recipe_id, name, amount, calories, protein_g, carbs_g, fat_g)
             VALUES ($1,$2,COALESCE($3,1),$4,$5,$6,$7)`,
            [
              req.params.id,
              ing.name,
              ing.amount,
              ing.calories,
              ing.protein ?? null,
              ing.carbs ?? null,
              ing.fat ?? null,
            ]
          );
        }
        await recomputeTotals(client, req.params.id);
      }
    });
    const out = await query(`SELECT id,user_id,name,description,servings,calories,protein_g,carbs_g,fat_g,created_at,updated_at FROM recipes WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    if (!out.rows[0]) throw notFound('Recipe not found', 'recipe_not_found');
    const ing = await query(`SELECT id,recipe_id,name,amount,calories,protein_g,carbs_g,fat_g FROM recipe_ingredients WHERE recipe_id=$1`, [req.params.id]);
    return res.json({ ...out.rows[0], ingredients: ing.rows });
  })
);

router.delete(
  '/:id',
  writeLimiter,
  validate({ params: schemas.idParam }),
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM recipes WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (rowCount === 0) throw notFound('Recipe not found', 'recipe_not_found');
    return res.status(204).end();
  })
);

router.post(
  '/:id/log',
  writeLimiter,
  validate({ params: schemas.idParam, body: schemas.logRecipe }),
  asyncHandler(async (req, res) => {
    const created = await transaction(async (client) => {
      const rec = await client.query(`SELECT id,user_id,name,description,servings,calories,protein_g,carbs_g,fat_g,created_at,updated_at FROM recipes WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
      if (!rec.rows[0]) throw notFound('Recipe not found', 'recipe_not_found');
      const r = rec.rows[0];
      const servings = Number(req.body.servings ?? 1);
      if (servings <= 0 || servings > 500) throw badRequest('Servings must be between 0.25 and 200', 'invalid_servings');
      const factor = servings / Number(r.servings || 1);
      const date = resolveEntryDate(req.body.entryDate);
      const name = r.name;
      const calories = Math.max(0, Math.round((Number(r.calories || 0) * factor)));
      const protein_g = Number(r.protein_g || 0) * factor;
      const carbs_g = Number(r.carbs_g || 0) * factor;
      const fat_g = Number(r.fat_g || 0) * factor;
      const { rows } = await client.query(
        `INSERT INTO items (user_id, type, name, calories, protein_g, carbs_g, fat_g, entry_date)
         VALUES ($1,'meal',$2,$3,$4,$5,$6,COALESCE($7::date,(now() AT TIME ZONE 'UTC')::date))
         RETURNING id, type, name, calories, protein_g, carbs_g, fat_g, entry_date::text AS entry_date, created_at`,
        [req.user.id, name, calories, protein_g || null, carbs_g || null, fat_g || null, date]
      );
      return rows[0];
    });
    return res.status(201).json(created);
  })
);

module.exports = router;
