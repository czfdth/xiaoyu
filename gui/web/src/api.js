// 统一的后端调用：错误统一抛 Error(message)，页面只负责提示。

const JSON_HEADERS = { 'content-type': 'application/json' };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: method === 'GET' ? undefined : JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text || res.statusText }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const get = (p) => api(p);
export const put = (p, body) => api(p, { method: 'PUT', body });
export const post = (p, body) => api(p, { method: 'POST', body });
