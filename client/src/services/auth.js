import { request } from './api';

const STORAGE_TOKEN_KEY = 'tracalorie_token';

export function setToken(token) {
  localStorage.setItem(STORAGE_TOKEN_KEY, token);
}

export function getToken() {
  return localStorage.getItem(STORAGE_TOKEN_KEY);
}

export function clearToken() {
  localStorage.removeItem(STORAGE_TOKEN_KEY);
}

export async function login(username, password) {
  return request('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
}

export async function register(username, password) {
  return request('/api/auth/register', {
    method: 'POST',
    body: { username, password },
  });
}

export async function getMe() {
  const result = await request('/api/auth/me');
  return result.user;
}
