let csrf = '';
export const setCsrf = value => { csrf = value || ''; };
export async function api(path, options = {}) {
  const { body, ...rest } = options;
  const response = await fetch(`/gongyingshangpingji/api${path}`, { credentials: 'same-origin', ...rest, headers: { ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(rest.method && rest.method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) }, body: body instanceof FormData ? body : body == null ? undefined : JSON.stringify(body) });
  if (!response.ok) { const value = await response.json().catch(() => ({})); const error = Object.assign(new Error(value.error || '请求失败'), { status: response.status }); if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('rating-expired')); throw error; }
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response;
}
export async function download(path) {
  const response = await api(path), url = URL.createObjectURL(await response.blob());
  const disposition = response.headers.get('content-disposition') || '';
  const name = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const a = document.createElement('a'); a.href = url; a.download = name ? decodeURIComponent(name) : '供应商评级_V1.xlsx'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
