'use strict';

/**
 * Express application factory.
 *
 * Exported separately from the HTTP listener so tests can mount the app
 * in-process via supertest without binding a port.
 *
 * Middleware order is load-bearing and reads outside-in:
 *   1. trust proxy          — so req.ip is meaningful for rate limiting
 *   2. security headers     — set before anything can respond
 *   3. CORS                 — reject disallowed origins before doing work
 *   4. request context      — assign an id every later layer can log
 *   5. body parsers         — bounded size
 *   6. rate limits          — before any handler allocates resources
 *   7. CSRF cookie          — every response carries a token
 *   8. routes
 *   9. static client build  — after the API, so it can never shadow a route
 *  10. 404 then error handler — terminal, so nothing escapes
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const config = require('./config/env');
const { securityHeaders, conditionalHsts } = require('./middleware/securityHeaders');
const { corsMiddleware } = require('./middleware/cors');
const { requestContext } = require('./middleware/requestContext');
const { trustProxy, clientIp } = require('./middleware/clientIp');
const { globalLimiter } = require('./middleware/rateLimit');
const { issueCsrfCookie, verifyCsrf } = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { healthcheck } = require('./db');
const { auditBase } = require('./routes/auth');
const audit = require('./lib/audit');

function createApp() {
  const app = express();

  // Required for correct client IPs behind a load balancer. Set explicitly
  // rather than left at Express's default of false.
  app.set('trust proxy', trustProxy);

  // Never advertise the framework. Helmet removes the header; this disables
  // Express's own advertising too.
  app.disable('x-powered-by');

  // Query parsing is a real attack surface: deeply nested or array-style
  // params have historically caused DoS in the qs parser. Cap both.
  app.set('query parser', 'simple');
  app.set('etag', 'strong');

  app.use(securityHeaders());
  app.use(conditionalHsts);
  app.use(corsMiddleware);
  app.use(requestContext);
  app.use((req, res, next) => {
    // Convenient for audit records and the rate limiter, computed once.
    req.clientIp = clientIp(req);
    next();
  });

  app.use(express.json({ limit: config.bodyLimit, strict: true }));
  app.use(express.urlencoded({ extended: false, limit: config.bodyLimit }));

  app.use(cookieParser());

  app.use(globalLimiter);

  // --- Health endpoints, unauthenticated and before CSRF -----------------
  // The liveness probe must stay cheap and must not touch the audit log on
  // every poll, or the probe itself becomes a log-volume problem.
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'tracalorie-api', env: config.nodeEnv, uptime: process.uptime() });
  });

  app.get('/api/health/ready', async (req, res) => {
    try {
      const db = await healthcheck();
      res.json({ ok: true, database: db });
    } catch (err) {
      // 503 tells the orchestrator to stop routing traffic here, which is the
      // point of a readiness probe as distinct from a liveness probe.
      req.log.error('readiness.failed', { err });
      res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
  });

  app.use(issueCsrfCookie);

  // CSRF is checked after the cookie is issued (so a first request has a token
  // to echo) and before any mutating route handler.
  app.use(verifyCsrf);

  // --- Routes ------------------------------------------------------------
  const { router: authRouter } = require('./routes/auth');
  const { router: securityRouter } = require('./routes/security');

  app.use('/api/auth', authRouter);
  app.use('/api/security', securityRouter);
  app.use('/api/items', require('./routes/items'));
  app.use('/api/foods', require('./routes/foods'));
  app.use('/api/user', require('./routes/users'));
  app.use('/api/stats', require('./routes/stats'));
  app.use('/api/recipes', require('./routes/recipes'));

  // --- Static client build, when one is present ---------------------------
  // Serving the built SPA from this process keeps the browser on a single
  // origin, which is what allows the session cookies to stay SameSite=strict
  // and keep their __Host- prefix. Mounted after the API routes so an unknown
  // /api path still gets a JSON 404 rather than the app shell.
  //
  // Guarded on existence so a checkout with no client build still boots as a
  // pure API (that is how the dev workflow runs the client through Vite).
  const clientDist = path.join(__dirname, '..', 'client', 'dist');

  if (fs.existsSync(clientDist)) {
    // Vite fingerprints everything under /assets, so those are immutable for a
    // year. index.html is not fingerprinted, so caching it would pin browsers
    // to a manifest pointing at bundles a deploy has already deleted.
    app.use(
      express.static(clientDist, {
        index: false,
        maxAge: '1y',
        immutable: true,
        setHeaders(res, filePath) {
          if (path.basename(filePath) === 'index.html') {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );

    // SPA fallback: the router owns its own paths, so a deep link such as
    // /security has no file on disk and must resolve to the app shell. /api is
    // excluded so that the 404 handler below keeps returning JSON.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path === '/api' || req.path.startsWith('/api/')) return next();
      // Set here rather than via express.static's setHeaders: that hook never
      // sees this response, and sendFile() would otherwise fall back to its own
      // weak `max-age=0` instead of an explicit no-cache for the shell.
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
  }

  // --- Terminal handlers --------------------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
