import { getToken } from './auth';

export async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const token = getToken();

  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (token) {
    opts.headers.Authorization = `Bearer ${token}`;
  }

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw data || { message: res.statusText };
  }

  return data;
}
