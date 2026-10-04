# Tracalorie - Full Stack Calorie Tracker

A full-stack web application for tracking daily calorie intake with user authentication and personalized calorie limits.

## Tech Stack

**Frontend:**
- React 18
- Vite
- Bootstrap 5
- React Bootstrap

**Backend:**
- Node.js + Express
- PostgreSQL
- JWT Authentication
- Bcrypt for password hashing

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
│   ├── middleware/        # Auth middleware
│   ├── routes/           # API routes
│   ├── sql/              # Database schema
│   ├── db.js             # Database connection
│   ├── index.js          # Server entry point
│   ├── package.json
│   ├── .env.example
│   └── README.md
└── README.md
```

## Prerequisites

- Node.js (v14 or higher)
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

# Install dependencies
npm install

# Apply the database schema (runs server/sql/init.sql; safe to re-run)
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

```
PORT=5000
JWT_SECRET=your-secret-key-here

# PostgreSQL Connection
PGHOST=localhost
PGPORT=5432
PGDATABASE=tracalorie
PGUSER=postgres
PGPASSWORD=your-password
```

**Important:** Never commit `.env` file. Use `.env.example` as a template.

## Available Scripts

### Server

```bash
npm run setup     # Apply the database schema (idempotent)
npm run dev       # Start with nodemon (development)
npm start         # Start production server
```

### Client

```bash
npm run dev      # Start development server
npm run build    # Build for production
npm run preview  # Preview production build
```

## API Endpoints

### Authentication

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user (requires auth)

### Items (Calorie Entries)

- `GET /api/items` - Get all items (requires auth)
- `POST /api/items` - Create new item (requires auth)
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

### Frontend Deployment (Vercel, Netlify, etc.)

1. Build the client:
   ```bash
   cd client
   npm run build
   ```

2. Deploy the `dist/` folder to your hosting service

3. Configure environment variables for API endpoint

### Backend Deployment (Heroku, Railway, etc.)

1. Set environment variables on your hosting platform
2. Ensure PostgreSQL database is accessible
3. Deploy the `server/` folder

## Security Notes

- Never commit `.env` files
- Always use strong JWT secrets in production
- Use HTTPS in production
- Implement rate limiting for API endpoints
- Validate all user inputs on both client and server

## License

MIT

## Contributing

Feel free to submit issues and enhancement requests!
