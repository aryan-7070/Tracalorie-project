# Tracalorie - Full Stack Calorie Tracker

A full-stack web application for tracking daily calorie intake with user authentication and personalized calorie limits.

## Tech Stack

**Frontend:**
- React 18
- Vite
- Bootstrap 5
- React Bootstrap

**Backend:**
- Node.js (20+) + Express 5
- PostgreSQL
- Cookie-based sessions (HttpOnly, `SameSite=Strict`, `__Host-` prefix) over JWT access tokens
- Bcrypt for password hashing
- Zod request validation, helmet security headers, explicit CORS allowlist
- Hash-chained security audit log with envelope-encrypted PII

## Project Structure

```
Tracalorie-project/
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/    # React components
│   │   ├── services/      # API and auth services
│   │   ├── styles/        # Component styles
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── server/                # Express backend
│   ├── config/           # Validated env config (single source of truth)
│   ├── lib/              # crypto, sessions, passwords, audit, findings
│   ├── middleware/       # auth, csrf, cors, rate limit, security headers
│   ├── routes/           # API routes
│   ├── schemas/          # Zod schemas for every input
│   ├── sql/              # Checksummed migrations (001_core.sql)
│   ├── test/             # Integration suite (npm test)
│   ├── scripts/          # lint, load-check, secrets generator
│   ├── app.js            # createApp() factory
│   ├── db.js             # Database connection
│   ├── index.js          # Server entry point
│   ├── migrate.js        # Migration runner
│   ├── package.json
│   ├── .env.example
│   └── README.md
└── README.md
```

## Prerequisites

- Node.js (v20 or higher — see `engines` in `server/package.json`)
- npm or yarn
- PostgreSQL (v12 or higher)

## Installation

### 1. Clone the repository

```bash
git clone <repository-url>
cd Tracalorie-project
```

### 2. Setup Database

```bash
# Create the database
createdb tracalorie
```

### 3. Setup Backend

```bash
cd server

# Copy environment file and update with your values
cp .env.example .env

# Generate JWT_SECRET, PII_ENCRYPTION_KEY and BLIND_INDEX_KEY.
# The server refuses to boot without all three.
npm run secrets:generate

# Install dependencies
npm install

# Apply the database schema (runs server/sql/001_core.sql; safe to re-run)
npm run setup

# Start the server (development)
npm run dev
```

The server will run on `http://localhost:5000`

### 4. Setup Frontend

```bash
cd client

# Install dependencies
npm install

# Start the development server
npm run dev
```

The client will run on `http://localhost:3000`

## Environment Variables

### Server (.env)

The server validates configuration at boot and exits if anything required is
missing or unsafe — there are no silent defaults for secrets.

**Required (the server refuses to start without these):**

```
NODE_ENV=development
PORT=5000

# Generate with: npm run secrets:generate  (all three must be 32+ characters)
JWT_SECRET=
PII_ENCRYPTION_KEY=
BLIND_INDEX_KEY=

# PostgreSQL Connection
PGHOST=localhost
PGPORT=5432
PGDATABASE=tracalorie
PGUSER=postgres
PGPASSWORD=

CORS_ORIGINS=http://localhost:3000
```

**Required only when `NODE_ENV=production`** (invariants are enforced):

```
PGSSLMODE=require        # TLS to Postgres is mandatory in production
PGPASSWORD=              # must be set
COOKIE_SECURE=true       # defaults to true in production
CORS_ORIGINS=https://your-app.example.com   # must be a real allowlist, "*" is refused
```

**Optional** — sensible defaults exist for everything else: rate limits, lockout
thresholds, token TTLs, `BCRYPT_ROUNDS`, `TRUST_PROXY`, cookie prefix and
`GCS_EXPORT_*`. See `server/.env.example` for the full documented list.

**Important:** Never commit `.env` file. Use `.env.example` as a template.

## Available Scripts

### Server

```bash
npm run setup         # Apply migrations (idempotent)
npm run migrate       # Apply pending migrations
npm run migrate:status # Show applied / pending / drifted
npm run dev           # Start with nodemon (development)
npm start             # Start production server
npm test              # Integration suite (needs a migrated database)
npm run lint          # Syntax + house-style checks
npm run secrets:generate # Print a ready-to-paste secrets block
```

### Client

```bash
npm run dev      # Start development server
npm run build    # Build for production
npm run preview  # Preview production build
```

## API Endpoints

Authentication is **cookie-based**, not Bearer: the browser holds an
`HttpOnly` access token and a `__Host-`-prefixed refresh token, both
`SameSite=Strict`. Every mutating request must also echo the `csrf_token`
cookie in an `X-CSRF-Token` header.

### Health

- `GET /api/health` - Liveness probe, never touches the database
- `GET /api/health/ready` - Readiness probe, `503` if the database is down

### Authentication

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/refresh` - Rotate the access token
- `POST /api/auth/logout` - Revoke the current session
- `POST /api/auth/logout-all` - Revoke every session
- `POST /api/auth/change-password` - Change password (requires current password)
- `PATCH /api/auth/profile` - Update display name, email, timezone or units
- `GET /api/auth/csrf` - Issue the CSRF cookie
- `GET /api/auth/session` - Current session metadata
- `GET /api/auth/me` - Current user (requires auth)

### Items (Calorie Entries)

- `GET /api/items` - Get all items, grouped into `meals` / `workouts` (requires auth)
- `POST /api/items` - Create new item `{ type, name, calories, entryDate? }` (requires auth)
- `PATCH /api/items/:id` - Update an entry (requires auth)
- `DELETE /api/items/:id` - Delete specific item (requires auth)
- `DELETE /api/items` - Clear all items (requires auth)

### User Settings

- `GET /api/user/limit` - Get calorie limit (requires auth)
- `PATCH /api/user/limit` - Update calorie limit (requires auth)

### Foods (Saved Library)

- `GET /api/foods` - List saved foods (requires auth)
- `POST /api/foods` - Save a food `{ type, name, calories }` (upsert, requires auth)
- `DELETE /api/foods/:id` - Remove a food (requires auth)

> Items added via `POST /api/items` are auto-saved to the food library.

### Stats (Week Dashboard)

- `GET /api/stats` - 7-day chart data, weekly totals, streaks, and badges (requires auth)

### Security

- `GET /api/security/overview` - Account security posture (requires auth)
- `GET /api/security/sessions` - Active sessions (requires auth)
- `DELETE /api/security/sessions/:id` - Revoke a session (requires auth)
- `GET /api/security/audit` - Hash-chained audit log (requires auth)
- `GET /api/security/audit/verify` - Verify the audit chain (requires auth)
- `GET /api/security/findings` - Security findings (requires auth)
- `POST /api/security/findings/:id/resolve` - Resolve a finding (requires auth)
- `GET /api/security/export` - Export your data (requires auth)
- `POST /api/security/export/archive` - Archive an export (requires auth)
- `DELETE /api/security/account` - Delete account (requires password + `DELETE`)
- `GET /api/security/profile` - Profile fields (requires auth)

## Features

- ✅ User registration and login with JWT authentication
- ✅ Add/delete calorie entries
- ✅ Track daily calorie intake
- ✅ Set personalized calorie limits
- ✅ Food library with quick-add suggestions (auto-built from your entries)
- ✅ My Foods panel with one-click re-add of saved meals and workouts
- ✅ Week dashboard with per-day chart, streak tracking, and achievement badges
- ✅ Secure password hashing with bcrypt
- ✅ Parameterized SQL queries (SQL-injection safe)
- ✅ One-command DB setup (`npm run setup`)
- ✅ Responsive UI with Bootstrap

## Development

### Running Both Services

Open two terminal windows:

**Terminal 1 - Backend:**
```bash
cd server
npm run dev
```

**Terminal 2 - Frontend:**
```bash
cd client
npm run dev
```

Then open `http://localhost:3000` in your browser.

## Deployment

The server serves the built client from `client/dist` when that directory
exists, so the UI and API run on **one origin**. That matters: the session
cookies are `SameSite=Strict` with a `__Host-` prefix, and browsers never send
them across sites. A static host for the client plus a separate API host breaks
login unless you also switch to `COOKIE_SAMESITE=none` and give the client an
explicit API base URL — neither of which the client currently uses.

So deploy this as **one service**, not two.

### Render, Railway, Fly.io or any Node host

```
Build command:  npm i --prefix server && npm i --prefix client && npm run build --prefix client
Start command:  npm run migrate --prefix server && npm start --prefix server
```

`npm run build --prefix client` is what produces `client/dist`; without it the
server starts as an API only and every page request 404s.

Environment variables: see above. `NODE_ENV=production` turns on the strict
invariants, so `PGSSLMODE`, `PGPASSWORD`, `COOKIE_SECURE` and a real
`CORS_ORIGINS` must all be set before the process will boot.

### Database

Any managed PostgreSQL. Neon and Supabase both have free tiers that work.
Point `PGHOST` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` at it and run
`npm run migrate --prefix server` once (the start command above already does).

Migrations are checksummed and refuse to run if an already-applied file has
changed — add a new `server/sql/NNN_*.sql` instead of editing an old one.

### What does *not* work

- **Netlify / Vercel for the whole app.** They have no PostgreSQL, and
  serverless functions cannot hold your `pg` pool across invocations, run the
  boot-time healthcheck, or keep the 15-minute session-purge interval alive.
- **Hosting `client/` on Netlify and `server/` elsewhere without changes.** The
  client only calls relative `/api/...` paths and has no `VITE_API_URL`
  support, so those requests hit the static host and 404.

## Security Notes

Already implemented — see `server/README.md` for the full model:

- Never commit `.env` files; secrets are validated at boot and the process
  exits rather than starting with a weak or missing value
- Rate limiting on global, auth, write and heavy routes
- Account lockout with progressive delay after repeated failed logins
- `HttpOnly` + `SameSite=Strict` + `__Host-` cookies; refresh tokens rotate
  and revoke the token they replace
- Zod validation on every input; unknown body fields are rejected, not stripped
- Parameterised SQL throughout, and a lint rule that fails on interpolated SQL
- Content-Security-Policy set to `default-src 'none'` with only same-origin
  sources — which is why no third-party CDN or webfont is loaded

## Testing

```bash
cd server
npm test
```

The suite mounts the real app in-process via supertest and exercises
registration, login, session refresh, item CRUD, CSRF enforcement and audit
chain verification. It needs a reachable, migrated database but no `.env`
(`NODE_ENV=test` supplies throwaway secrets). Point `PG*` at a scratch
database — the tests create rows.

## License

MIT

## Contributing

Feel free to submit issues and enhancement requests!
