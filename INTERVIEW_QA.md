# Tracalorie — Interview Questions & Answers (1–2 years experience)

## 1. Architecture & Design

**Q1. Walk me through the overall architecture of Tracalorie.**

It's a fullstack monorepo with two independent npm packages. The `server/` is an Express REST API on port 5000 that talks to PostgreSQL using the `pg` library. The `client/` is a React 18 app built with Vite, running on port 3000. There's no router library or state library — just function components and hooks. In development, the Vite dev server proxies `/api` requests to `localhost:5000`, so the client just calls relative paths like `/api/items`. The flow is: user registers/logs in → gets a JWT → frontend stores it in localStorage → every authenticated request sends it as a Bearer token → server verifies it and scopes all data to that user's id.

**Q2. Why did you choose a separate `client/` and `server/` structure instead of a single app?**

Two main reasons. First, separation of concerns — the API is purely about data and business logic, the frontend purely about UI. That means I can change the UI without touching the API and vice versa. Second, deployability — the backend can be scaled independently, the React app can be served as static files by a CDN or Nginx, and any other client (mobile, third-party) could reuse the same API. It also keeps dependencies clean: Express/node modules don't leak into the React bundle.

**Q3. How does the frontend communicate with the backend in development?**

Through a Vite proxy configured in `vite.config.js`. Any request starting with `/api` from the browser is forwarded to `http://localhost:5000`. This avoids CORS issues in dev and means the client code uses relative URLs, which is good practice. In production I'd either serve the built React app from the Express server or configure the deployment's reverse proxy to do the same forwarding.

**Q4. How would you deploy this project in production?**

First, run `vite build` on the client to produce a `dist/` folder of static assets. Then, for the backend, set real environment variables — `PORT`, `JWT_SECRET`, and the `PG*` connection values — instead of the local defaults. Options are: serve the `dist/` folder statically from Express and the API from the same origin, or host the API on a platform like Railway/Fly and serve the frontend from Nginx/Netlify. I'd move the DB to a managed Postgres (since the code uses connection pooling via `pg.Pool`, it works the same). I'd also switch HTTPS on, set a strong JWT secret, and lock down CORS to the production origin instead of the wide-open `app.use(cors())` we have in dev.

---

## 2. Backend / API Design

**Q5. List the API endpoints and their purposes.**

Under `/api/auth`: `POST /register` (create user, hash password, return token + user), `POST /login` (verify credentials, return token + user), `GET /me` (protected — validate the token and return the current user). Under `/api/items` (all protected): `GET /` (return all meals and workouts for the user plus their calorie limit), `POST /` (add a meal or workout), `DELETE /:id` (delete one item), `DELETE /` (clear all items). Under `/api/user`: `GET /limit` (fetch calorie limit) and `PATCH /limit` (update it). Plus `GET /api/health` as a simple health check.

**Q6. Why is `PATCH /api/user/limit` a PATCH and not a PUT?**

PATCH is meant for partial updates — we're updating a single field of an existing resource. A PUT would normally replace the entire user object, which isn't what we're doing and would require sending the whole resource. That's a REST semantics convention, and it also signals to anyone reading the code that only part of the resource changes.

**Q7. Why does the DELETE endpoint return 204 instead of 200 with a body?**

204 No Content is the standard response for a successful delete — there's nothing meaningful to return, and it indicates the response body is intentionally empty. It also makes the client code cleaner: we just check the response status instead of parsing a body we'd ignore. In this project the client's `request()` wrapper returns `null` for 204s, which is handled fine.

**Q8. How do you prevent SQL injection?**

All queries use parameterized statements — `WHERE id = $1 AND user_id = $2`, values passed as a separate array to the `pg` driver. The driver escapes values so user input is never concatenated into the SQL string. If someone submitted `name = "'; DROP TABLE items;--"`, it would be treated as a literal string, not executed as SQL. I never build queries with `${}` string interpolation of user data.

**Q9. Some routes use `router.use(auth)` while `GET /me` applies auth per-route. What's the difference and why?**

`router.use(auth)` is route-group middleware — it runs for every route defined after it in that router file, so it protects all of `/api/items` and all of `/api/user` with one line. `GET /api/auth/me` needs to be protected too, but the rest of `/api/auth` (register/login) must be public, so I can't apply `use(auth)` to the whole auth router. Instead I pass `auth` as middleware to just that one route. It's the difference between "protect everything in this group" and "protect this specific route."

**Q10. How is data shaped differently between the DB and the client?**

The database uses `snake_case` columns — `calorie_limit`, `password_hash`, `created_at` — while the API responses use `camelCase` — `calorieLimit`. So in routes I map rows to response objects, for example `{ id, username, calorieLimit: user.calorie_limit }`. Importantly, `password_hash` is never selected or returned to the client at all. This gives a clean, consistent API contract decoupled from the DB schema.

---

## 3. Authentication & Security

**Q11. Explain how auth works end-to-end in this project.**

On register, the server checks the username isn't taken, hashes the password with bcrypt at 10 salt rounds, inserts the user, and returns a signed JWT plus the user object. On login, it looks up the user by username and uses `bcrypt.compare` to verify the password. In both cases the client stores the token in localStorage under `tracalorie_token`. On every authenticated request, the `request()` wrapper reads the token and adds an `Authorization: Bearer <token>` header. The server's `auth` middleware verifies the JWT with the secret and sets `req.user = { id: payload.userId }`. On page load, App.jsx calls `getMe()` to validate the stored token; if it fails we clear the token and show the login screen.

**Q12. Why hash passwords with bcrypt instead of storing plaintext?**

Passwords must never be stored in recoverable form — anyone with DB access shouldn't be able to read them. Bcrypt is a deliberately slow, salted hash designed for passwords — the 10 rounds make brute-force expensive. It also uses a unique salt per password, so identical passwords produce different hashes and rainbow tables are useless. I'd also add that we never log or return the hash.

**Q13. What's inside the JWT, and why does it expire after 7 days?**

The payload is just `{ userId }`, signed with `JWT_SECRET` and an `expiresIn: '7d'`. The expiry is a security trade-off: a short expiry limits how long a stolen token remains valid, but too short forces users to re-login constantly. Seven days is a reasonable balance for this app. The signature also prevents tampering — if someone tries to change `userId`, `jwt.verify()` throws and the request gets a 401.

**Q14. Why does the token only contain `userId` and not the username or limit?**

Two reasons. The token should be as small as possible since it's sent on every request. More importantly, claims like the calorie limit or username can go stale — if I put the limit in the token it would be outdated the moment the user changes it. Since it's just an id, every request can fetch fresh data from the DB. That's why `GET /me` and `GET /api/items` both return current data from the database.

**Q15. What are the security gaps in this project?**

Honestly, several. CORS is wide open — `app.use(cors())` allows any origin. There's no rate limiting, so login/register are brute-force targets. No refresh-token rotation — if the 7-day token leaks it's valid the whole time. No Helmet for security headers, no CSRF protection. And one code-level gap: the API only checks that `calories` is a number, so a client could send negative calories even though the UI uses `min={0}`. These are exactly the items I've documented in SECURITY.md as planned improvements.

**Q16. Is storing the JWT in `localStorage` safe?**

It's a known trade-off. localStorage is accessible to any JavaScript running on the page, so if there's an XSS vulnerability, the token can be exfiltrated. The safer pattern is an HttpOnly, Secure, SameSite cookie set by the server, which JavaScript can't read — that's also what would give us built-in CSRF protection with SameSite. I chose localStorage for simplicity here since this is a learning/fullstack-rewrite project, but in a real app I'd move to HttpOnly cookies or at least add a strict CSP.

---

## 4. Database & Schema

**Q17. Describe the database schema.**

Two tables. `users`: `id SERIAL PRIMARY KEY`, `username TEXT UNIQUE NOT NULL`, `password_hash TEXT NOT NULL`, `calorie_limit INTEGER NOT NULL DEFAULT 2000`, and `created_at TIMESTAMPTZ default now()`. `items`: `id SERIAL PRIMARY KEY`, `user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `type TEXT NOT NULL CHECK (type IN ('meal','workout'))`, `name TEXT NOT NULL`, `calories INTEGER NOT NULL`, `created_at TIMESTAMPTZ DEFAULT now()`.

**Q18. What do `SERIAL PRIMARY KEY`, `ON DELETE CASCADE`, and the `CHECK` constraint do?**

`SERIAL PRIMARY KEY` auto-increments the id and makes it the unique row identifier — the app never generates ids manually. `ON DELETE CASCADE` means if a user row is deleted, every item with that `user_id` is deleted automatically, so there's no orphaned data. The `CHECK` constraint enforces at the database level that `type` can only be `'meal'` or `'workout'` — so even a buggy client or API can't insert junk data. The bonus is the DB is the last line of defense.

**Q19. Why does `items` have a foreign key to `users`?**

Because every item belongs to exactly one user — that's the ownership model. The FK enforces referential integrity: an item's `user_id` must point at a real user, and the cascade cleanly handles user deletion. It's also what allows the app to scope every query with `WHERE user_id = $1` using the id from the verified JWT, so one user can never read or delete another user's items.

**Q20. What is connection pooling, and why does the app use a `Pool`?**

Opening a Postgres connection is expensive — it involves TCP + auth handshake. A `pg.Pool` keeps a set of reusable connections. In the route helper `getClient()`, we `pool.connect()` to borrow one, run the query, and `client.release()` in a `finally` block to return it to the pool. If I forget to release, the pool eventually exhausts and the app hangs — which is exactly why every route uses try/catch/finally. It also handles concurrency better than a single client.

**Q21. How does the app scope queries to the current user?**

The `auth` middleware verifies the JWT and sets `req.user = { id: payload.userId }`. Every items/user query then filters by that id — e.g. `DELETE FROM items WHERE id = $1 AND user_id = $2`. So even if I pass someone else's item id, the delete matches zero rows. That's defense in depth: authorization at the query level, not just "hide the button in the UI." One honest gap: `DELETE /:id` returns 204 even if nothing was deleted, so we don't distinguish "not yours" from "not found" — it's idempotent but unobservable.

---

## 5. Frontend / React

**Q22. How is state managed in the React app?**

Plain React hooks — no Redux or context library. `App.jsx` holds the top-level `user`, `loading`, and `error` state, and conditionally renders either `TrackerPage` or `AuthPage`. `TrackerPage` manages its own `meals`, `workouts`, `limit`, filters, and form input state. I used `useMemo` for derived values like total calories, and drill down the `onAdd`/`onDelete`/`onLogout` callbacks to child components. For this app's size it keeps the mental model simple; I'd reach for context or a library only if state grew a lot.

**Q23. How does the app restore a user's session on page refresh?**

On mount, `useEffect` in App.jsx reads the token from localStorage. If there is one, it calls `getMe()` — which hits `GET /api/auth/me` with the Bearer header. If the server returns a valid user, we set it and render the tracker. If the request fails (expired/invalid token), we call `clearToken()` and fall back to the auth screen. The `loading` state shows a spinner while that check runs, so there's no flash of the login screen for an already-authenticated user.

**Q24. Why use `useMemo` for the calorie calculations?**

The calories consumed, burned, and remaining are all derived from `meals`, `workouts`, and `limit`. `useMemo` caches the computed values and only recomputes when one of those dependencies actually changes — so re-renders caused by typing in a filter input don't re-sum the arrays. It's mostly a performance maturity habit: cheap here, but the pattern matters when arrays are large. The `clamp` for the progress bar also keeps the percentage within 0–100.

**Q25. Explain the optimistic update pattern after adding/deleting an item.**

When adding a meal, the form calls `addItem`, which POSTs to `/api/items` and, on success, prepends the returned item to the local `meals` array — so the list updates instantly from the server's response without a refetch. Deleting calls `DELETE /api/items/:id` and filters the id out of local state on success. I say "optimistic" loosely — strictly, true optimistic updates apply the change before the server responds and roll back on failure. Here we wait for success, so it's really just "update local state from the response." Either way, it avoids a full reload and keeps the UI in sync with the single source of truth.

**Q26. How does `user ? <TrackerPage/> : <AuthPage/>` work with the loading state?**

The render logic is: if `loading` is true, show a centered spinner — this is the window where `getMe()` is still validating the stored token. Once loading finishes, there's a definite `user` value: if it exists we render `TrackerPage`, otherwise `AuthPage`. The loading gate matters because otherwise, on refresh, a logged-in user would briefly see the login form before the token check completes — an ugly flash and confusing UX.

---

## 6. General JavaScript / Code Quality

**Q27. What is the `request()` wrapper doing in `api.js`?**

It's a single fetch wrapper that centralizes the HTTP layer. It sets `Content-Type: application/json`, injects the `Authorization: Bearer` header from the token stored in localStorage, stringifies the body, and does `fetch`. On success it parses JSON and returns it (returning `null` for empty 204 bodies). On failure — `!res.ok` — it parses the error payload and **throws it**, so callers can do `err.message`. That means no component ever repeats the fetch boilerplate, and headers/error handling stay consistent in one place. The downside: it couples all calls to localStorage via the auth import, which is fine at this scale.

**Q28. `getClient()` is copy-pasted in all three route files. How would you improve this?**

Extract it into a shared module, say `server/utils/db.js`, and import it wherever needed — one definition, one place to fix pool-connection issues. Even better, I could wrap the whole "connect → query → release" sequence in a helper that takes a query + params and returns the result, so routes don't have to repeat the try/catch/finally scaffolding. And if I added transactions later, that same helper could accept a client and manage commit/rollback. It's a classic DRY refactor that also reduces the chance of leaking pool connections.

**Q29. What would you add to make this production-ready?**

Three buckets. **Correctness:** a real test suite (Jest/Vitest + supertest for the API, React Testing Library for components), centralized request validation using a schema library like zod or express-validator instead of inline checks. **Security:** rate limiting, stricter CORS, Helmet, refresh-token rotation, encrypting env handling. **Ops:** a centralized Express error-handler middleware so unexpected errors log properly with request context, structured logging, maybe a health endpoint that actually checks the DB connection. The current generic `500 {message:'Server error'}` hides a lot.

---

## 7. Career / Experience-level ("Can you build on it?")

**Q30. If users could have categories (breakfast/lunch/dinner), how would your schema and endpoints change?**

Schema: add a `category TEXT NOT NULL CHECK (category IN ('breakfast','lunch','dinner','snack'))` column to `items`. API: add `category` to the `POST /api/items` validation and response, and let `GET /api/items` return items grouped by category (a `categories` object or flat array the client groups). Frontend: add a category selector to `ItemForm`, and render list sections per category. Since existing items already have `type`, you could derive a default category or run a migration to backfill. The key interview point: this is a low-risk, additive change and a great next feature — no migration of existing relationships.

**Q31. How would you add a date dimension so the tracker works per-day?**

Schema: add a `date DATE NOT NULL DEFAULT CURRENT_DATE` column to `items`. Migration options: backfill existing rows with their `created_at::date`, or default to today. API: `GET /api/items` needs a `?date=YYYY-MM-DD` query param, and the query becomes `WHERE user_id=$1 AND date=$2`. Also add a `GET /api/items/dates` (or derive from response) to list which dates have entries so the client can render a date picker/calendar. The daily totals become per-day: intake, burned, remaining per selected date. Bonus: the progress bar and limit can stay as-is because they're already computed client-side per loaded set. The SQL aggregate would be `SUM(calories)` filtered by `type` and `date`.