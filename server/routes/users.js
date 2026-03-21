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

router.use(auth);

router.get('/limit', async (req, res) => {
  const client = await getClient(res);
  if (!client) return;

  try {
    const result = await client.query('SELECT calorie_limit FROM users WHERE id = $1', [req.user.id]);
    const calorieLimit = result.rows[0]?.calorie_limit ?? 2000;
    return res.json({ calorieLimit });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

router.patch('/limit', async (req, res) => {
  const { calorieLimit } = req.body;
  if (typeof calorieLimit !== 'number') {
    return res.status(400).json({ message: 'calorieLimit must be a number' });
  }

  const client = await getClient(res);
  if (!client) return;

  try {
    await client.query('UPDATE users SET calorie_limit = $1 WHERE id = $2', [calorieLimit, req.user.id]);
    return res.sendStatus(204);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
