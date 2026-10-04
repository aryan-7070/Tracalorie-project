/**
 * HTTP client.
 *
 * Owns the entire conversation with the API's security mechanisms, so no
 * component ever has to think about them:
 *
 *  1. Cookies, not tokens. The server sets httpOnly cookies; this client never
 *     sees, stores or transmits the access token. Nothing sensitive lives in
 *     localStorage, so an XSS cannot read it out.
 *
 *  2. CSRF. Because the access token rides on an automatically-attached cookie,
 *     the browser will send it on cross-site requests. We echo a double-submit
 *     token in `X-CSRF-Token` on every mutating call. `SameSite=Strict` is the
 *     primary defence; this is the layer beneath it.
 *
 *  3. Silent refresh. A 401 with `token_expired` triggers one refresh and one
 *     retry, transparent to the caller. Concurrent 401s share a single refresh
 *     promise, so a page issuing six parallel requests does not fire six
 *     refreshes — which would trip refresh-token reuse detection and sign the
 *     user out.
 *
 *  4. Terminal auth failure. When the session is genuinely dead
 *     (`session_revoked`, `token_epoch_mismatch`, `refresh_token_reuse`), we
 *     stop retrying and notify listeners so the app can return to the sign-in
 *     screen instead of looping.
 */

/** Notified when the session can no longer be recovered. */
const authFailureListeners = new Set();

export function onAuthFailure(listener) {
  authFailureListeners.add(listener);
  return () => authFailureListeners.delete(listener);
}

function notifyAuthFailure(reason) {
  authFailureListeners.forEach((fn) => {
    try {
      fn(reason);
    } catch {
      // A broken listener must not prevent the others from running.
    }
  });
}

const CSRF_COOKIE_SUFFIX = 'csrf_token';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let csrfToken = null;
/** In-flight refresh, shared so parallel 401s trigger exactly one refresh. */
let refreshPromise = null;

/**
 * Read the CSRF token from the non-httpOnly cookie.
 *
 * The cookie is named `${prefix}csrf_token`, where prefix is `__Host-` in
 * production and empty elsewhere. Scanning by suffix avoids hard-coding the
 * server's COOKIE_PREFIX on the client, which would be a needless coupling.
 */
function readCsrfCookie() {
  if (typeof document === 'undefined') return null;

  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name.endsWith(CSRF_COOKIE_SUFFIX)) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

function currentCsrfToken() {
  return csrfToken || readCsrfCookie();
}

/** Adopt a token the server sent in a response body. */
export function setCsrfToken(token) {
  if (typeof token === 'string' && token.length >= 16) csrfToken = token;
}

export function clearCsrfToken() {
  csrfToken = null;
}

/**
 * In-flight bootstrap, shared for the same reason as refresh: several parallel
 * mutations on a cold session should not each request a token.
 */
let csrfBootstrapPromise = null;

/**
 * Obtain a CSRF token when we do not have one yet.
 *
 * `issueCsrfCookie` sets the cookie on any response, but the very first request
 * a user ever makes is a mutating one (login or register) and it arrives with
 * no token to echo — which the server correctly rejects. So before any
 * mutating call we make sure a token exists, fetching the unauthenticated
 * bootstrap endpoint if necessary.
 */
async function ensureCsrfToken() {
  if (currentCsrfToken()) return currentCsrfToken();

  if (!csrfBootstrapPromise) {
    csrfBootstrapPromise = fetch('/api/auth/csrf', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = await res.json().catch(() => null);
        setCsrfToken(body?.csrfToken);
        return body?.csrfToken || null;
      })
      .catch(() => null)
      .finally(() => {
        csrfBootstrapPromise = null;
      });
  }

  return csrfBootstrapPromise;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'unknown', details, requestId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** True for errors caused by the user's own input, which are safe to show inline. */
  get isUserError() {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

/** Error codes from which retrying could succeed. */
const RETRYABLE = new Set(['token_expired']);
/** Codes that mean the session is unrecoverable; retrying would loop forever. */
const TERMINAL = new Set([
  'session_revoked',
  'session_invalid',
  'session_expired',
  'token_epoch_mismatch',
  'refresh_token_reuse',
  'account_inactive',
  'account_missing',
  'refresh_token_invalid',
  'refresh_token_missing',
]);

function parseError(res, body) {
  const envelope = body?.error;
  return new ApiError(
    envelope?.message || body?.message || `Request failed with status ${res.status}`,
    {
      status: res.status,
      code: envelope?.code || 'unknown',
      details: envelope?.details,
      requestId: body?.error?.requestId || res.headers.get('X-Request-ID'),
    }
  );
}

/**
 * Perform a refresh. Single-flight: concurrent callers await the same promise,
 * which is what keeps the server's reuse detection from firing on a burst of
 * parallel requests.
 */
async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      // Refresh is itself a mutating request, so it needs a CSRF header. Bootstrapping
      // here covers the case where the session died before any token existed.
      await ensureCsrfToken();

      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          // The refresh call is itself a mutating request, so it needs a CSRF
          // header too. It must not go through `request`, or a failure here
          // would recurse into another refresh attempt.
          ...(currentCsrfToken() ? { 'X-CSRF-Token': currentCsrfToken() } : {}),
        },
      });

      const body = res.status === 204 ? null : await res.json().catch(() => null);

      if (!res.ok) {
        throw parseError(res, body);
      }

      return body;
    })().finally(() => {
      // Clear on settle so a later 401 can start a fresh attempt.
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

async function rawRequest(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const opts = {
    method,
    // Sends the httpOnly session cookies. Required or nothing authenticates.
    credentials: 'include',
    headers: { Accept: 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  };

  if (body !== undefined) opts.headers['Content-Type'] = 'application/json';

  if (MUTATING_METHODS.has(method.toUpperCase())) {
    // Bootstrap first if this is a cold session, so the very first login or
    // registration carries a token instead of being rejected.
    await ensureCsrfToken();
    const token = currentCsrfToken();
    if (token) opts.headers['X-CSRF-Token'] = token;
  }

  const res = await fetch(path, opts);

  // 204 and 205 carry no body.
  if (res.status === 204 || res.status === 205) {
    if (res.headers.get('X-Request-ID')) {
      // Surface the id even on empty responses, for support/debugging.
      opts.lastRequestId = res.headers.get('X-Request-ID');
    }
    return null;
  }

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) throw parseError(res, parsed);

  // Any endpoint that establishes or refreshes a session returns the current
  // CSRF token, so adopt it and stay in sync after a rotation.
  if (parsed && typeof parsed.csrfToken === 'string') setCsrfToken(parsed.csrfToken);

  return parsed;
}

async function request(path, options = {}) {
  try {
    return await rawRequest(path, options);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;

    // Not an auth problem, or not one we can fix by refreshing.
    if (err.status !== 401) throw err;
    if (TERMINAL.has(err.code)) {
      clearCsrfToken();
      notifyAuthFailure(err.code);
      throw err;
    }
    if (!RETRYABLE.has(err.code)) throw err;

    // Exactly one refresh + one retry. If the retry fails it propagates, so a
    // broken session cannot loop.
    let refreshed;
    try {
      refreshed = await refreshAccessToken();
    } catch (refreshErr) {
      clearCsrfToken();
      notifyAuthFailure(refreshErr.code || 'refresh_failed');
      throw refreshErr;
    }

    if (refreshed?.csrfToken) setCsrfToken(refreshed.csrfToken);

    return rawRequest(path, options);
  }
}

export { request, refreshAccessToken };
