# Tracalorie Server (Express + Postgres + JWT)

This server provides a simple API for the Tracalorie tracker app.

## Setup

1. Copy `.env.example` to `.env` and update the Postgres connection settings + `JWT_SECRET`.

2. Create the database:

```bash
createdb tracalorie
```

3. Install dependencies and apply the schema:

```bash
cd server
npm install
npm run setup   # applies sql/init.sql (creates users, items, foods). Idempotent — safe to re-run.
```

4. Start the server:

```bash
npm run dev
```

The API will listen on `http://localhost:5000` by default.

## API

- `POST /api/auth/register` { username, password }
- `POST /api/auth/login` { username, password }
- `GET /api/auth/me` (requires `Authorization: Bearer <token>`)

- `GET /api/items` (requires auth)
- `POST /api/items` { type, name, calories } — also auto-saves to the food library
- `DELETE /api/items/:id` (delete one item)
- `DELETE /api/items` (clear all items)

- `GET /api/user/limit` (requires auth)
- `PATCH /api/user/limit` { calorieLimit }

- `GET /api/foods` (requires auth)
- `POST /api/foods` { type, name, calories } — upsert
- `DELETE /api/foods/:id`

- `GET /api/stats` — last 7 days, weekly totals, current/best streaks, best day, badges

