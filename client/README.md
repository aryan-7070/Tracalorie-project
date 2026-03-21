# Tracalorie Client

React frontend for the Tracalorie calorie tracking application.

## Setup

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

The application will be available at `http://localhost:3000`

## Scripts

```bash
npm run dev      # Start development server with Vite
npm run build    # Build for production
npm run preview  # Preview production build locally
```

## Project Structure

```
src/
├── components/
│   ├── AuthPage.jsx       # Login/Register page
│   └── TrackerPage.jsx    # Main tracker interface
├── services/
│   ├── api.js            # HTTP request utility
│   └── auth.js           # Authentication service
├── styles/
│   ├── AuthPage.css
│   ├── TrackerPage.css
│   └── styles.css
├── App.jsx               # Main app component
└── main.jsx              # Entry point
```

## Features

- User authentication (login/register)
- Add calorie entries
- Delete calorie entries
- View daily calorie summary
- Set personalized calorie limits
- Responsive design with Bootstrap

## API Integration

The client communicates with the backend API at `/api`. In development, requests are proxied to `http://localhost:5000` via Vite's proxy configuration.

### Environment Configuration

For production deployments, update the API endpoint in `vite.config.js` or use environment variables.

## Dependencies

- **react** - UI library
- **react-dom** - React DOM rendering
- **bootstrap** - CSS framework
- **react-bootstrap** - Bootstrap components for React

## Development

### Running with Backend

Make sure the backend server is running on `http://localhost:5000`:

```bash
# Terminal 1 - Backend
cd ../server
npm run dev

# Terminal 2 - Frontend
npm run dev
```

### Building for Production

```bash
npm run build
```

This creates an optimized build in the `dist/` folder ready for deployment.

## Deployment

### Vercel

```bash
npm install -g vercel
vercel
```

### Netlify

```bash
npm install -g netlify-cli
netlify deploy --prod --dir=dist
```

### Manual Deployment

1. Build the project: `npm run build`
2. Upload the `dist/` folder to your web server
3. Configure your server to serve `index.html` for all routes (SPA routing)

## Troubleshooting

### API Connection Issues

- Ensure backend server is running on `http://localhost:5000`
- Check browser console for CORS errors
- Verify API endpoint in `vite.config.js`

### Build Issues

- Clear `node_modules` and reinstall: `rm -rf node_modules && npm install`
- Clear Vite cache: `rm -rf dist && npm run build`

## License

MIT
