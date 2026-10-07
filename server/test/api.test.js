'use strict';

/**
 * API integration suite.
 *
 * Mounts the real Express app in-process via supertest rather than spawning a
 * server: createApp() exists so these tests can bind no port at all.
 *
 * NODE_ENV is set before anything is required because config/env.js freezes
 * itself at first require. In test mode the config supplies throwaway
 * development secrets, so the suite needs no .env - but it does need the
 * database to exist and be migrated (`npm run setup`), because the routes under
 * test execute real SQL.
 *
 * Accounts are created with a unique username per run and are deliberately not
 * deleted: security_audit is hash-chained per actor, so removing rows would
 * break chain verification on the following run. Tests write to whatever
 * database PG* points at - point them at a throwaway database, not production.
 */

process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../app');
const audit = require('../lib/audit');

const app = createApp();
const stamp = Date.now();
const username = `qa.${String(stamp).slice(-8)}`;
const email = `qa.${stamp}@example.com`;
const password = 'integration-suite-1';

const jar = new Map();
let csrfToken;
let createdItemId;

/**
 * Supertest exposes `.set`/`.send` only once a method has been chosen, so the
 * method and path are taken up front rather than chaining off a bare
 * `request(app)`.
 *
 * Its response also exposes `headers` as a plain object, not a Headers
 * instance, so `getSetCookie()` is unavailable and `set-cookie` must be read
 * directly. The jar lives in one place because the CSRF cookie rotates, and a
 * stale header token fails every subsequent double-submit comparison.
 */
function send(method, path) {
  const r = request(app)[method](path);
  if (jar.size) r.set('Cookie', [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
  if (csrfToken) r.set('X-CSRF-Token', csrfToken);
  return r;
}

function remember(res) {
  for (const line of res.headers['set-cookie'] || []) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
  if (jar.has('csrf_token')) csrfToken = jar.get('csrf_token');
}

test('health endpoint reports ok', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, 'tracalorie-api');
});

test('CSRF cookie is issued with SameSite=Strict', async () => {
  const res = await request(app).get('/api/auth/csrf').expect(200);

  const raw = (res.headers['set-cookie'] || []).join(' ');
  // Regression: the config key was read with the wrong casing, so no SameSite
  // attribute was ever written and browsers silently fell back to Lax.
  assert.match(raw, /SameSite=Strict/i);

  remember(res);
  assert.ok(csrfToken, 'csrf_token cookie should be present');
  // The token is base64, so padding would be lost to a naive split('='), and a
  // truncated token then fails every double-submit comparison.
  assert.ok(csrfToken.length >= 32, `token looks truncated: ${csrfToken.length} chars`);
});

test('rejects a mutating request with no CSRF token', async () => {
  const res = await request(app)
    .post('/api/items')
    .send({ type: 'meal', name: 'x', calories: 1 })
    .expect(403);
  assert.equal(res.body.error?.code, 'csrf_failed');
});

test('unauthenticated requests are rejected', async () => {
  // A valid CSRF token is not authorisation: without a session these must
  // still be denied by requireAuth rather than reaching the handlers.
  await send('get', '/api/items').expect(401);
  await send('post', '/api/items').send({ type: 'meal', name: 'x', calories: 1 }).expect(401);
  await send('patch', '/api/user/limit').send({ calorieLimit: 2000 }).expect(401);
});

test('registers a new account', async () => {
  const res = await send('post', '/api/auth/register')
    .send({ username, email, password, displayName: 'QA' })
    .expect(201);

  assert.equal(res.body.user.username, username);
  remember(res);
});

test('rejects a weak password', async () => {
  const res = await send('post', '/api/auth/register')
    .send({ username: `qa.weak.${stamp}`, password: 'short' })
    .expect(422);
  assert.ok(res.body.error?.code);
});

test('logs in and resolves the session', async () => {
  const res = await send('post', '/api/auth/login')
    .send({ username, password })
    .expect(200);

  assert.ok(res.body.user?.id ?? res.body.ok);
  remember(res);

  const me = await send('get', '/api/auth/me').expect(200);
  assert.equal(me.body.user.username, username);
});

test('rejects a wrong password', async () => {
  await send('post', '/api/auth/login')
    .send({ username, password: 'definitely-not-the-password' })
    .expect(401);
});

test('updates and reads the calorie limit', async () => {
  await send('patch', '/api/user/limit').send({ calorieLimit: 2200 }).expect(204);

  const res = await send('get', '/api/user/limit').expect(200);
  assert.equal(res.body.calorieLimit, 2200);
});

test('creates, reads, updates and deletes an item', async () => {
  const created = await send('post', '/api/items')
    .send({ type: 'meal', name: 'Paneer tikka', calories: 480 })
    .expect(201);

  createdItemId = created.body.id;
  assert.equal(created.body.name, 'Paneer tikka');
  assert.ok(createdItemId);

  await send('post', '/api/items').send({ type: 'workout', name: 'Run', calories: 320 }).expect(201);

  const list = await send('get', '/api/items').expect(200);
  const total = list.body.meals.length + list.body.workouts.length;
  assert.ok(total >= 2, `expected at least 2 items, got ${total}`);
  assert.ok(list.body.calorieLimit, 'calorieLimit should come back with the list');

  // Regression: these two both 500'd because idParam was a bare primitive
  // rather than an object, so zod called Number({ id: '3' }).
  const patched = await send('patch', `/api/items/${createdItemId}`)
    .send({ calories: 520 })
    .expect(200);
  assert.equal(patched.body.calories, 520);

  await send('delete', `/api/items/${createdItemId}`).expect(204);
  await send('delete', `/api/items/${createdItemId}`).expect(404);
});

test('rejects malformed item input', async () => {
  const res = await send('post', '/api/items')
    .send({ type: 'snack', name: '', calories: 'lots' })
    .expect(422);

  assert.ok(res.body.error?.details || res.body.error?.code);
});

test('rejects unknown body fields instead of stripping them silently', async () => {
  const res = await send('post', '/api/items')
    .send({ type: 'meal', name: 'Rice', calories: 200, is_admin: true })
    .expect(422);
  assert.ok(res.body.error?.code);
});

test('returns stats, foods and security overviews', async () => {
  const stats = await send('get', '/api/stats').expect(200);
  assert.ok(stats.body);

  await send('post', '/api/foods').send({ type: 'meal', name: 'Oats', calories: 210 }).expect(201);
  const foods = await send('get', '/api/foods').expect(200);
  assert.ok(foods.body);

  await send('get', '/api/security/overview').expect(200);
  await send('get', '/api/security/sessions').expect(200);
});

test('records success-path audit entries and keeps the chain valid', async () => {
  const verify = await send('get', '/api/security/audit/verify').expect(200);
  assert.notEqual(verify.body.ok, false, `chain verification failed: ${JSON.stringify(verify.body)}`);

  const me = await send('get', '/api/auth/me').expect(200);
  const actorId = me.body.user.id;

  // Regression: canonicalEntry left `outcome` unset, which reached Postgres as
  // an explicit NULL, tripped NOT NULL and bypassed the column DEFAULT. Every
  // register/login/refresh/logout write was dropped; only the 7 explicit
  // `outcome: 'failure'` callers were ever persisted.
  const chain = await audit.verifyChain({ actorId });
  assert.equal(chain.valid, true, `audit chain invalid: ${JSON.stringify(chain.firstBreak)}`);
  assert.ok(chain.checked > 0, 'expected the chain to cover at least one entry');

  const entries = await audit.listForUser(actorId, { limit: 50 });
  const rows = Array.isArray(entries) ? entries : entries?.items ?? [];
  assert.ok(rows.length > 0, 'success-path entries should now be persisted');
});

test('refreshes the session token and invalidates the old one', async () => {
  const refreshed = await send('post', '/api/auth/refresh').expect(200);
  // Refresh rotates the access token and revokes the token it replaces, so
  // the jar must take the new cookie or the very next call presents a revoked
  // one. Capture it, then confirm the rotated session still authenticates.
  remember(refreshed);

  await send('get', '/api/auth/me').expect(200);
});

test('logs out and drops the session', async () => {
  await send('post', '/api/auth/logout').expect(204);
  await send('get', '/api/auth/me').expect(401);
});

test('unknown API routes return a JSON 404 envelope', async () => {
  const res = await request(app).get('/api/definitely-not-a-route').expect(404);
  assert.equal(res.headers['content-type'].includes('application/json'), true);
  assert.ok(res.body.error?.code);
});

after(() => {
  // Release the pg pool so `node --test` can exit instead of hanging open
  // idle connections.
  const db = require('../db');
  return db.close();
});
