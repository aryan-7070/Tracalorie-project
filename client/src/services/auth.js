/**
 * Authentication service.
 *
 * Note what is absent: no token is stored, read or returned. The access token
 * lives in an httpOnly cookie that JavaScript cannot see. The only credential
 * material the client handles is the CSRF token, which is not secret — it is
 * deliberately readable so it can be echoed back in a header.
 */

import { request, refreshAccessToken, clearCsrfToken } from './api';

/** Fetch the signed-in user. Doubles as a cheap session probe on app boot. */
export async function getMe() {
  const result = await request('/api/auth/me');
  return result.user;
}

export async function login(username, password) {
  return request('/api/auth/login', { method: 'POST', body: { username, password } });
}

export async function register({ username, password, email, displayName }) {
  return request('/api/auth/register', {
    method: 'POST',
    // Omit empty optional fields entirely: the server's schema is strict and
    // would reject an explicit null for an optional string.
    body: {
      username,
      password,
      ...(email ? { email } : {}),
      ...(displayName ? { displayName } : {}),
    },
  });
}

export async function logout() {
  try {
    await request('/api/auth/logout', { method: 'POST' });
  } finally {
    // Clear local CSRF state even if the network call failed, so the next
    // sign-in starts clean.
    clearCsrfToken();
  }
}

/** Revoke every other session. Keeps the current device signed in. */
export async function logoutEverywhere() {
  return request('/api/auth/logout-all', { method: 'POST' });
}

export async function changePassword(currentPassword, newPassword) {
  return request('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}

export async function updateProfile(changes) {
  return request('/api/auth/profile', { method: 'PATCH', body: changes });
}

/** Proactively refresh, e.g. before a long idle period. */
export async function refresh() {
  return refreshAccessToken();
}

// --- Security & privacy ---------------------------------------------------

export async function getSecurityOverview() {
  return request('/api/security/overview');
}

export async function getSessions() {
  return request('/api/security/sessions');
}

export async function revokeSession(sessionUuid) {
  return request(`/api/security/sessions/${sessionUuid}`, { method: 'DELETE' });
}

export async function getAuditLog({ days = 30, limit = 50, offset = 0 } = {}) {
  return request(`/api/security/audit?days=${days}&limit=${limit}&offset=${offset}`);
}

export async function verifyAuditChain() {
  return request('/api/security/audit/verify');
}

export async function getFindings() {
  return request('/api/security/findings');
}

export async function resolveFinding(id) {
  return request(`/api/security/findings/${id}/resolve`, { method: 'POST' });
}

/**
 * Download the user's data export.
 *
 * Uses a plain anchor rather than fetch: the response is an attachment, and
 * letting the browser handle the download avoids buffering the whole export in
 * memory. The URL carries only the format — never a credential.
 */
export function downloadDataExport(format = 'json') {
  const url = `/api/security/export?format=${encodeURIComponent(format)}`;
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function archiveToCloud() {
  return request('/api/security/export/archive', { method: 'POST' });
}

export async function deleteAccount(password, confirmation) {
  return request('/api/security/account', {
    method: 'DELETE',
    body: { password, confirmation },
  });
}

// --- Tracking (unchanged surface, new transport) -------------------------

export const getItems = () => request('/api/items');
export const addItem = (item) => request('/api/items', { method: 'POST', body: item });
export const deleteItem = (id) => request(`/api/items/${id}`, { method: 'DELETE' });
export const deleteAllItems = () => request('/api/items', { method: 'DELETE' });

export const getFoods = () => request('/api/foods');
export const addFood = (food) => request('/api/foods', { method: 'POST', body: food });
export const deleteFood = (id) => request(`/api/foods/${id}`, { method: 'DELETE' });

export const getStats = () => request('/api/stats');
export const setCalorieLimit = (calorieLimit) =>
  request('/api/user/limit', { method: 'PATCH', body: { calorieLimit } });
