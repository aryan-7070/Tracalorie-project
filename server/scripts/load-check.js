'use strict';

/**
 * Load every server module and report failures.
 *
 * `node --check` only validates one file at a time and misses bad `require`
 * paths, circular imports and top-level throws. This loads the real module
 * graph against a test environment, which is the check that actually catches
 * "works on my machine" deploy failures.
 *
 * Usage: node scripts/load-check.js
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// Populate the minimum a test run needs. config/env.js supplies its own
// test-only fallbacks for the secrets.
process.env.JWT_SECRET ||= 'load-check-only-secret-not-for-production-0000';
process.env.PII_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.BLIND_INDEX_KEY ||= 'load-check-blind-index-key-value';
process.env.PGPASSWORD ||= 'unused';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'test', 'scripts']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js') && !full.endsWith('index.js')) out.push(full);
  }
  return out;
}

const failures = [];
const files = walk(ROOT);

for (const file of files) {
  const rel = path.relative(ROOT, file);
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(file);
    const keys = Object.keys(mod || {});
    console.log(`  ok  ${rel.padEnd(34)} exports: ${keys.length ? keys.join(', ') : '(none)'}`);
  } catch (err) {
    failures.push({ rel, err });
    console.log(`  ERR ${rel.padEnd(34)} ${err.message}`);
  }
}

// The app factory and both entry points are excluded above (index.js starts a
// listener), so exercise them explicitly.
try {
  const { createApp } = require(path.join(ROOT, 'app.js'));
  const app = createApp();
  if (typeof app !== 'function') throw new Error('createApp did not return a function');
  console.log('  ok  app.js                            createApp() built the Express app');
} catch (err) {
  failures.push({ rel: 'app.js', err });
  console.log(`  ERR app.js                            ${err.message}`);
}

console.log('');

if (failures.length) {
  console.error(`Load check FAILED: ${failures.length} module(s) could not load.\n`);
  for (const { rel, err } of failures) {
    console.error(`${rel}\n${err.stack}\n`);
  }
  process.exit(1);
}

console.log(`Load check passed: ${files.length + 1} module(s) loaded cleanly.`);
