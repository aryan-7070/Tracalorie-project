# Tracalorie Server (Express + Postgres + JWT)

This server provides a simple API for the Tracalorie tracker app.

## Setup

1. Copy `.env.example` to `.env` and update the Postgres connection settings + `JWT_SECRET`.

2. Create the database and run the schema:

```bash
# Replace with your own database name if needed
createdb tracalorie
psql -d tracalorie -f server/sql/init.sql
```

3. Install dependencies:

```bash
cd server
npm install
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
- `POST /api/items` { type, name, calories }
- `DELETE /api/items/:id` (delete one item)
- `DELETE /api/items` (clear all items)

- `GET /api/user/limit` (requires auth)
- `PATCH /api/user/limit` { calorieLimit }

