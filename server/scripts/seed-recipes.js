'use strict';

/**
 * Seed starter protein-rich recipes for a user. A runnable Node script that
 * connects to Postgres, creates a demo user if needed, and inserts a small
 * set of meals (each with ~20–50g protein) and their ingredients.
 */

require('dotenv').config();

const crypto = require('crypto');
const blindIndex = require('../lib/crypto').blindIndex;
const bcrypt = require('bcrypt');
const logger = require('../lib/logger');
const { pool } = require('../db');

const DEMO_USER = process.env.DEMO_SEED_USER || 'demo';
const DEMO_PASS = process.env.DEMO_SEED_PASS || 'tracalorie-demo';

const recipes = [
  {
    name: 'Chicken Rice Bowl',
    description: 'Lean chicken breast, brown rice, greens and olive oil',
    servings: 1,
    ingredients: [
      { name: 'Chicken breast (raw)', amount: 200, calories: 220, protein: 40, carbs: 0, fat: 10 },
      { name: 'Brown rice (cooked)', amount: 150, calories: 165, protein: 3.6, carbs: 34.5, fat: 1.2 },
      { name: 'Broccoli', amount: 100, calories: 34, protein: 2.8, carbs: 7, fat: 0.4 },
      { name: 'Olive oil', amount: 10, calories: 80, protein: 0, carbs: 0, fat: 9 },
    ],
  },
  {
    name: 'Greek Yogurt Berry Bowl',
    description: 'High-protein Greek yogurt with berries and nuts',
    servings: 1,
    ingredients: [
      { name: 'Greek yogurt (plain)', amount: 200, calories: 120, protein: 18, carbs: 6, fat: 4 },
      { name: 'Mixed berries', amount: 100, calories: 57, protein: 0.7, carbs: 14, fat: 0.3 },
      { name: 'Mixed nuts', amount: 30, calories: 174, protein: 6, carbs: 5, fat: 15 },
    ],
  },
  {
    name: 'Tofu Scramble',
    description: 'Crispy tofu, mushrooms, peppers and spring onions',
    servings: 1,
    ingredients: [
      { name: 'Firm tofu', amount: 250, calories: 375, protein: 31.5, carbs: 7.5, fat: 25 },
      { name: 'Mushrooms', amount: 70, calories: 15, protein: 2, carbs: 2, fat: 0.3 },
      { name: 'Bell pepper', amount: 70, calories: 15, protein: 0.5, carbs: 3, fat: 0.1 },
      { name: 'Olive oil', amount: 10, calories: 80, protein: 0, carbs: 0, fat: 9 },
    ],
  },
  {
    name: 'Egg Bhurji',
    description: 'Indian style scrambled eggs with tomatoes and onions',
    servings: 1,
    ingredients: [
      { name: 'Whole eggs', amount: 200, calories: 286, protein: 25.2, carbs: 2, fat: 20 },
      { name: 'Onion', amount: 50, calories: 20, protein: 0.5, carbs: 4.5, fat: 0.1 },
      { name: 'Tomato', amount: 70, calories: 14, protein: 0.7, carbs: 3, fat: 0.2 },
      { name: 'Ghee', amount: 5, calories: 45, protein: 0, carbs: 0, fat: 5 },
    ],
  },
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let user = await client.query('SELECT id FROM users WHERE username=$1', [DEMO_USER]);
    if (!user.rows[0]) {
      const passwordHash = await bcrypt.hash(DEMO_PASS, 10);
      user = await client.query(
        `INSERT INTO users (username, username_bidx, password_hash, calorie_limit)
         VALUES ($1,$2,$3,2000)
         RETURNING id`,
        [DEMO_USER, blindIndex(DEMO_USER.toLowerCase(), 'username'), passwordHash]
      );
      logger.info(`Created demo user "${DEMO_USER}"`);
    }
    const userId = user.rows[0].id;
    for (const r of recipes) {
      const rec = await client.query(
        `INSERT INTO recipes (user_id, name, description, servings)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [userId, r.name, r.description, r.servings]
      );
      const recipeId = rec.rows[0]?.id;
      if (!recipeId) continue;
      await client.query('DELETE FROM recipe_ingredients WHERE recipe_id=$1', [recipeId]);
      for (const ing of r.ingredients) {
        await client.query(
          `INSERT INTO recipe_ingredients (recipe_id, name, amount, calories, protein_g, carbs_g, fat_g)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            recipeId,
            ing.name,
            ing.amount,
            ing.calories,
            ing.protein,
            ing.carbs,
            ing.fat,
          ]
        );
      }
      await client.query(
        `UPDATE recipes r
         SET calories = COALESCE((SELECT SUM(calories) FROM recipe_ingredients ri WHERE ri.recipe_id=r.id),0),
             protein_g = COALESCE((SELECT SUM(protein_g) FROM recipe_ingredients ri WHERE ri.recipe_id=r.id),0),
             carbs_g   = COALESCE((SELECT SUM(carbs_g) FROM recipe_ingredients ri WHERE ri.recipe_id=r.id),0),
             fat_g     = COALESCE((SELECT SUM(fat_g) FROM recipe_ingredients ri WHERE ri.recipe_id=r.id),0),
             updated_at=now()
         WHERE r.id=$1`,
        [recipeId]
      );
      logger.info(`Seeded: ${r.name}`);
    }
    await client.query('COMMIT');
    logger.info('Done.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main();
