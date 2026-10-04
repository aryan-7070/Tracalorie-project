'use strict';

/**
 * Security headers.
 *
 * Helmet supplies the baseline; the CSP is written to this app's actual surface
 * (same-origin API, no third-party script, no inline eval) rather than left at a
 * permissive default, and `Permissions-Policy` is set by hand because Helmet 8
 * no longer ships a middleware for it.
 *
 * Cross-Origin-Opener-Policy is worth calling out: it stops a hostile page from
 * opening this app in a popup and reading its documents through `window.opener`.
 * That is a real exfiltration path for an app holding health data.
 */

const helmet = require('helmet');
const config = require('../config/env');

/**
 * Deny every powerful browser feature the app does not use. A calorie tracker
 * needs no camera, microphone, geolocation or payment access; if an attacker
 * injects a script, these features should not be available to it.
 */
const DENIED_FEATURES = [
  'accelerometer',
  'autoplay',
  'camera',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'geolocation',
  'gyroscope',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'publickey-credentials-get',
  'screen-wake-lock',
  'usb',
  'xr-spatial-tracking',
];

function securityHeaders() {
  const isDev = !config.isProduction;

  const middleware = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        // Deny by default; every source the app actually needs is listed below.
        // Anything not enumerated here cannot load.
        defaultSrc: ["'none'"],
        // The React automatic JSX runtime needs no inline <script>. Vite's dev
        // server does inject an inline module preload, hence 'unsafe-inline' in
        // development only.
        scriptSrc: isDev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
        // Bootstrap ships its own stylesheet; no remote fonts or trackers.
        styleSrc: isDev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        // Production talks only to its own origin. Development additionally needs
        // the Vite dev server and its HMR websocket.
        connectSrc: isDev ? ["'self'", 'http://localhost:*', 'ws://localhost:*'] : ["'self'"],
        objectSrc: ["'none'"],
        // Clickjacking defence. A "Delete my account" button is a prime target.
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        manifestSrc: ["'self'"],
        // Health data in a URL must not leak to third parties via Referer.
        referrerPolicy: 'no-referrer',
        // null removes the directive, which is what we want over plain HTTP:
        // upgrading a localhost dev URL to https:// just breaks the page.
        upgradeInsecureRequests: isDev ? null : [],
      },
    },
    // Refuse to guess a content type. Without this, a JSON response served
    // alongside user-controlled text can be sniffed as HTML and executed.
    xContentTypeOptions: true,
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    // Remove the header that advertises Express.
    hidePoweredBy: true,
    // COEP would break legitimate cross-origin loads and buys us nothing here.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    originAgentCluster: true,
    xDnsPrefetchControl: { allow: false },
    xDownloadOptions: false,
    // Browsers still honour the legacy filter; set it to 0 to disable, which
    // avoids the filter itself introducing holes.
    xXssProtection: false,
    // HSTS is only meaningful over TLS, so it is production-only.
    hsts: isDev
      ? false
      : { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  });

  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader(
      'Permissions-Policy',
      DENIED_FEATURES.map((f) => `${f}=()`).join(', ')
    );
    middleware(req, res, next);
  };
}

/**
 * HSTS over plain HTTP is actively harmful: the browser will refuse subsequent
 * http:// requests, including to a local dev server. Helmet is configured with
 * `hsts: false` in development, and this is a belt-and-braces removal in case a
 * proxy upstream injects the header.
 */
function conditionalHsts(req, res, next) {
  if (!config.isProduction) res.removeHeader('Strict-Transport-Security');
  return next();
}

module.exports = { securityHeaders, conditionalHsts, DENIED_FEATURES };
