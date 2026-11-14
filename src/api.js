import { useEffect, useState } from 'react';
import { API_PATH } from '../shared/constants.js';

let csrfToken = '';
export function setCsrfToken(token) { csrfToken = token || ''; }

export function queryString(filters = {}) {
  return new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value != null)).toString();
}

async function request(path, options = {}) {
  const { body, ...rest } = options;
  const form = body instanceof FormData;
  const response = await fetch(`${API_PATH}${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: { ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
      ...(rest.method && rest.method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}), ...rest.headers },
    body: body == null ? undefined : form ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || `请求未完成（${response.status}）`);
    error.status = response.status;
    error.issues = payload.issues;
    if (response.status === 401 && !['/auth/login', '/auth/session', '/auth/status'].includes(path)) window.dispatchEvent(new Event('session-expired'));
    throw error;
  }
  return response;
}

export async function api(path, options) {
  const response = await request(path, options);
  return response.status === 204 ? {} : response.json();
}

export async function download(path, fallbackName) {
  const response = await request(path);
  const disposition = response.headers.get('Content-Disposition') || '';
  const utfName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let filename = fallbackName;
  try { filename = utfName ? decodeURIComponent(utfName) : disposition.match(/filename="([^"]+)"/i)?.[1] || fallbackName; } catch { /* Use a safe fallback for malformed headers. */ }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useResource(path, refresh = 0) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!path) { setState({ data: null, loading: false, error: null }); return; }
    const controller = new AbortController();
    setState(previous => ({ ...previous, loading: true, error: null }));
    api(path, { signal: controller.signal }).then(data => {
      setState({ data, loading: false, error: null });
    }).catch(error => {
      if (error.name !== 'AbortError') setState({ data: null, loading: false, error });
    });
    return () => controller.abort();
  }, [path, refresh]);
  return state;
}
