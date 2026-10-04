'use strict';

/**
 * Zero-dependency syntax and security hygiene check.
 *
 * Parses every server-side .js file (catching syntax errors before a deploy
 * does) and asserts invariants a plain linter would not:
 *
 *   - no `SELECT *`              (defeats index-only scans and leaks columns)
 *   - no interpolated SQL values (SQL injection)
 *   - no stray `console.*`       (bypasses redaction in the structured logger)
 *   - no hardcoded secrets
 *
 * On the SQL rule: interpolating a *column-list constant* is safe, interpolating
 * a *value* is an injection. The two are not reliably distinguishable by
 * pattern, so rather than guess, every interpolated SQL call site must carry an
 * explicit `lint:sql-safe <reason>` annotation. The check fails when the
 * annotation is absent — forcing a human decision at each site and documenting
 * the reasoning for whoever reads the file later.
 *
 * A full ESLint + eslint-plugin-security setup is the right long-term answer;
 * this keeps CI dependency-light and targets the mistakes that actually matter
 * in this codebase.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist']);

// Files where the flagged constructs are intentional.
const ALLOW = {
  // CLI tools: stdout is their purpose.
  'migrate.js': ['console', 'secret'],
  'scripts/generate-secrets.js': ['console', 'secret'],
  // This file contains the patterns it searches for, as string literals.
  'scripts/lint-syntax.js': ['console', 'select-star', 'sql-interpolation', 'secret'],
  'scripts/load-check.js': ['console', 'secret'],
  // Test-environment fixtures only; never reachable in production.
  'config/env.js': ['secret'],
};

const SAFE_SQL_ANNOTATION = /lint:sql-safe\b/;

// Matches a query call whose first argument is a template literal, including
// multi-line ones. The template body is captured so we can inspect `${`.
const SQL_CALL = /(?:\bquery|\.query)\s*\(\s*`([^`]*)`/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const problems = [];
const files = walk(ROOT);

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const source = fs.readFileSync(file, 'utf8');
  const allowed = new Set(ALLOW[rel] || []);

  // 1. Parse check — the highest-value check, since a syntax error is a
  //    guaranteed deploy failure.
  try {
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename: file });
  } catch (err) {
    problems.push(`${rel}:${err.lineNumber || '?'} syntax error — ${err.message}`);
    continue;
  }

  const lines = source.split(/\r?\n/);
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const report = (lineNo, message) => problems.push(`${rel}:${lineNo} ${message}`);

  // 2. Per-line rules.
  lines.forEach((line, i) => {
    const at = i + 1;

    if (!allowed.has('select-star') && /SELECT\s+\*/i.test(line)) {
      report(at, 'SELECT * — list columns explicitly');
    }

    if (!allowed.has('console') && /console\.(log|info|warn|error|debug)\s*\(/.test(line)) {
      report(at, 'console.* — use the structured logger (lib/logger.js) so redaction applies');
    }

    if (!allowed.has('secret')) {
      const secretish = /(?:secret|password|apiKey|api_key)\s*[:=]\s*['"][^'"]{12,}['"]/i.exec(line);
      if (secretish) {
        report(at, `possible hardcoded secret — ${secretish[0].slice(0, 60)}…`);
      }
    }
  });

  // 3. Interpolated SQL, across line boundaries.
  if (!allowed.has('sql-interpolation')) {
    SQL_CALL.lastIndex = 0;
    let match;
    while ((match = SQL_CALL.exec(source)) !== null) {
      if (!match[1].includes('${')) continue;

      const startLine = lineAt(match.index);
      // The annotation may sit on one of the lines just above the call, which is
      // where a reader would naturally put the justification.
      const lookback = lines.slice(Math.max(0, startLine - 5), startLine).join('\n');

      if (!SAFE_SQL_ANNOTATION.test(lookback)) {
        report(
          startLine,
          'interpolated SQL without justification — add `/* lint:sql-safe <reason> */` if the ' +
            'interpolation is a static column-list constant, otherwise use a $n placeholder'
        );
      }
    }
  }
}

if (problems.length) {
  console.error(`\nLint failed (${problems.length} problem(s)):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`Lint passed: ${files.length} file(s) checked.`);
