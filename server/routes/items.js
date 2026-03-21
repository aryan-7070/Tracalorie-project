const express = require('express');
const auth = require('../middleware/auth');
const pool = require('../db');

async function getClient(res) {
  try {
    return await pool.connect();
  } catch (err) {
    res.status(500).json({ message: 'Database connection error' });
    return null;
  }
}

const router = express.Router();

// All item routes require auth
router.use(auth);

// Retrieve all items for the current user, plus current limit
router.get('/', async (req, res) => {
  const client = await getClient(res);
  if (!client) return;

  try {
    const itemsResult = await client.query(
      'SELECT id, type, name, calories FROM items WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );

    const userResult = await client.query('SELECT calorie_limit FROM users WHERE id = $1', [req.user.id]);
    const calorieLimit = userResult.rows[0]?.calorie_limit ?? 2000;

    const meals = [];
    const workouts = [];

    itemsResult.rows.forEach((item) => {
      if (item.type === 'meal') meals.push(item);
      else if (item.type === 'workout') workouts.push(item);
    });

    return res.json({ meals, workouts, calorieLimit });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

router.post('/', async (req, res) => {
  const { type, name, calories } = req.body;

  if (!type || !name || typeof calories !== 'number') {
    return res.status(400).json({ message: 'Type, name, and calories are required' });
  }

  if (!['meal', 'workout'].includes(type)) {
    return res.status(400).json({ message: 'Type must be "meal" or "workout"' });
  }

  const client = await getClient(res);
  if (!client) return;

  try {
    const result = await client.query(
      'INSERT INTO items (user_id, type, name, calories) VALUES ($1, $2, $3, $4) RETURNING id, type, name, calories',
      [req.user.id, type, name, calories]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const client = await getClient(res);
  if (!client) return;

  try {
    await client.query('DELETE FROM items WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    return res.sendStatus(204);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

// Reset all items for the user
router.delete('/', async (req, res) => {
  const client = await getClient(res);
  if (!client) return;

  try {
    await client.query('DELETE FROM items WHERE user_id = $1', [req.user.id]);
    return res.sendStatus(204);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
