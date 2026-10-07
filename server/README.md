# Tracalorie Server (Express 5 + PostgreSQL)

The API, and the static host for the built client when `client/dist` exists.

## Setup

1. Copy `.env.example` to `.env`:

```bash
cp .env.example .env
npm run secrets:generate   # prints JWT_SECRET, PII_ENCRYPTION_KEY, BLIND_INDEX_KEY
```

All three secrets are mandatory and must be at least 32 characters. The server
validates configuration on boot and exits rather than starting with a missing,
short or placeholder value.

2. Create the database:

```bash
createdb tracalorie
```

3. Install dependencies and apply migrations:

```bash
npm install
npm run setup   # applies sql/001_core.sql. Idempotent — safe to re-run.
```

4. Start the server:

```bash
npm run dev     # nodemon, http://localhost:5000
```

## Scripts

```bash
npm run setup          # apply pending migrations
npm run migrate:status # applied / pending / drift
npm run migrate:fresh  # drop and re-migrate (development only)
npm run lint           # syntax + house-style checks
npm test               # integration suite (needs a migrated database)
npm run secrets:generate
```

Migrations are checksum-tracked in `schema_migrations`. Editing a file that has
already been applied is refused — add a new `sql/NNN_*.sql` instead.

## Authentication model

Sessions are **cookies**, not `Authorization: Bearer` (a Bearer header is still
accepted for non-browser clients):

- `HttpOnly` access token plus a refresh token scoped to `/api/auth`
- `SameSite=Strict`, `Secure` in production, `__Host-` prefix in production
- Refresh rotates the token and revokes the one it replaces
- Every mutating request must echo the `csrf_token` cookie in `X-CSRF-Token`

## API

Health (unauthenticated, before CSRF):

- `GET /api/health`, `GET /api/health/ready`

Auth (`/api/auth`):

- `POST /register` { username, password, email?, displayName? }
- `POST /login` { username, password }
- `POST /refresh`, `POST /logout`, `POST /logout-all`
- `POST /change-password` { currentPassword, newPassword }
- `PATCH /profile`, `GET /profile`, `GET /me`
- `GET /csrf`, `GET /session`

Items (`/api/items`, requires auth):

- `GET /` — returns `{ meals, workouts, calorieLimit }`
- `POST /` { type, name, calories, entryDate? } — also auto-saves to the food library
- `PATCH /:id`, `DELETE /:id`, `DELETE /` (clear all)

Settings and library:

- `GET|PATCH /api/user/limit` { calorieLimit }
- `GET|POST /api/foods`, `DELETE /api/foods/:id`
- `GET /api/stats` — last 7 days, weekly totals, streaks, badges

Security (`/api/security`, requires auth):

- `GET /overview`, `GET /sessions`, `DELETE /sessions/:id`
- `GET /audit`, `GET /audit/verify`, `GET /findings`,
  `POST /findings/:id/resolve`
- `GET /export`, `POST /export/archive`
- `GET /profile`, `DELETE /account` (requires password + `DELETE` confirmation)

## Layout

- `app.js` — `createApp()` factory, so tests mount the app without a port
- `index.js` — process entry: healthcheck, listen, graceful shutdown
- `config/env.js` — the only place that reads `process.env`
- `lib/` — crypto (envelope encryption, blind indexes), sessions, passwords,
  lockout, hash-chained audit, findings, logging
- `middleware/` — auth/CSRF, CORS allowlist, rate limits, security headers,
  request context, client IP, validation, error handling
- `schemas/` — Zod schemas for every input
- `sql/` — migrations
- `test/` — integration suite
- `scripts/` — lint, load-check, secrets generator
