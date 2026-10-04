'use strict';

/**
 * Password hashing and policy enforcement.
 *
 * Hashing: bcrypt, cost configurable (default 12). bcrypt is memory-hard and
 * deliberately slow, which is the point — it makes offline cracking expensive.
 *
 * The critical detail is the 72-byte cap. bcrypt hashes only the first 72 bytes
 * of its input and silently ignores the rest, so `correct horse battery staple`
 * and `correct horse battery staple<anything>` produce identical digests. We
 * reject longer inputs instead of accepting a password that is only
 * "as unique as its first 72 bytes".
 */

const bcrypt = require('bcrypt');
const config = require('../config/env');
const { badRequest } = require('./errors');

/**
 * Deny-list of passwords that appear in every breach corpus. A deny-list
 * complements entropy requirements: length and character-class rules do not
 * stop `Password123!`, and this does.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'password123!', 'passw0rd', 'p@ssw0rd',
  '12345678', '123456789', '1234567890', '123456789!', 'qwerty123', 'qwertyuiop',
  'letmein', 'welcome', 'welcome1', 'welcome123', 'admin', 'administrator',
  'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'monkey', 'dragon',
  'trustno1', 'abc123', '11111111', 'iloveu', 'sunshine1', 'master', 'hello',
  'freedom', 'whatever', 'qazwsx', 'superman', 'batman', 'starwars', 'login',
  'changeme', 'secret', 'root', 'toor', 'default', 'guest', 'test', 'test123',
  'user', 'pass', 'temp', 'temp123', 'tracalorie', 'calories', 'diet', 'fitness',
  // Keyboard and service patterns
  'qwerty1!', 'q1w2e3r4', 'zaq12wsx', 'asdfghjk', 'asdfghjkl', '1q2w3e4r',
]);

/** Local-part of an email address; used only to reject credential-as-password. */
function emailLocalPart(email) {
  return String(email).split('@')[0] || '';
}

/**
 * Enforce the password policy.
 * @returns {{ok: true}|{ok: false, message: string}}
 */
function checkPolicy(password, { username, email } = {}) {
  const value = typeof password === 'string' ? password : '';

  if (value.length < config.password.minLength) {
    return {
      ok: false,
      message: `Password must be at least ${config.password.minLength} characters long.`,
    };
  }

  if (value.length > config.password.maxLength) {
    return {
      ok: false,
      message: `Password must be at most ${config.password.maxLength} characters long.`,
    };
  }

  if (Buffer.byteLength(value, 'utf8') > config.password.bcryptMaxBytes) {
    return {
      ok: false,
      message: `Password must be at most ${config.password.bcryptMaxBytes} bytes long.`,
    };
  }

  if (value.length > 1 && /^(\S)\1+$/.test(value)) {
    return { ok: false, message: 'Password must not be a single repeated character.' };
  }

  if (value.length > 2 && /^(ab|abc|abcd|abcde|abcdef)/i.test(value) && new Set(value).size <= 3) {
    return { ok: false, message: 'Password must not be a simple repeating sequence.' };
  }

  const lowered = value.toLowerCase();

  if (COMMON_PASSWORDS.has(lowered)) {
    return {
      ok: false,
      message: 'This password appears in well-known breach lists. Please choose another.',
    };
  }

  if (username && lowered.includes(String(username).toLowerCase())) {
    return { ok: false, message: 'Password must not contain your username.' };
  }

  const local = email && emailLocalPart(email);
  if (local && local.length >= 3 && lowered.includes(local.toLowerCase())) {
    return { ok: false, message: 'Password must not contain your email address.' };
  }

  return { ok: true };
}

function assertPolicy(password, context) {
  const result = checkPolicy(password, context);
  if (!result.ok) {
    throw badRequest(result.message, 'weak_password');
  }
  return true;
}

async function hash(password) {
  return bcrypt.hash(String(password), config.password.bcryptRounds);
}

async function verify(password, hashValue) {
  if (!hashValue) {
    // Still burn comparable CPU so response timing does not reveal whether the
    // account exists.
    await bcrypt.compare(String(password), '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    return false;
  }
  try {
    return await bcrypt.compare(String(password), hashValue);
  } catch {
    return false;
  }
}

module.exports = { checkPolicy, assertPolicy, hash, verify, COMMON_PASSWORDS };
