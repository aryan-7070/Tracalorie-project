const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const auth = require('../middleware/auth');

async function getClient(res) {
  try {
    return await pool.connect();
  } catch (err) {
    res.status(500).json({ message: 'Database connection error' });
    return null;
  }
}

const router = express.Router();

function createToken(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
}

router.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  const client = await getClient(res);
  if (!client) return;

  try {
    const existing = await client.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length) {
      return res.status(400).json({ message: 'Username already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await client.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, calorie_limit',
      [username, passwordHash]
    );

    const user = result.rows[0];
    const token = createToken(user);
    return res.json({ token, user: { id: user.id, username: user.username, calorieLimit: user.calorie_limit } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  const client = await getClient(res);
  if (!client) return;

  try {
    const result = await client.query('SELECT id, username, password_hash, calorie_limit FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = createToken(user);
    return res.json({ token, user: { id: user.id, username: user.username, calorieLimit: user.calorie_limit } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

router.get('/me', auth, async (req, res) => {
  const client = await getClient(res);
  if (!client) return;

  try {
    const result = await client.query('SELECT id, username, calorie_limit FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json({ user: { id: user.id, username: user.username, calorieLimit: user.calorie_limit } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
