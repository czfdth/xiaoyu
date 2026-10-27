// @ts-check
// 统一的后端调用：错误统一抛 Error(message)，页面只负责提示。
// 另外对登记在契约里的接口做一次形状检查：字段漂移时 console.warn 点名，
// 不再让页面静默显示 undefined（只警告不抛——契约是护栏，不是拦路虎）。

import { CONTRACT, shapeErrors } from '../../shared/contract.mjs';

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * 调一个后端接口。
 * @template T
 * @param {string} path 以 / 开头的接口路径（不含 /api）
 * @param {{method?: string, body?: unknown}} [options]
 * @returns {Promise<T>}
 */
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
  // 契约守卫：登记的接口返回字段对不上时，控制台点名（不影响页面渲染）
  const route = `/api${String(path).split('?')[0]}`;
  const declared = CONTRACT[route];
  if (declared?.response && data && typeof data === 'object') {
    const errs = shapeErrors(data, declared.response);
    if (errs.length) console.warn('[契约]', path, errs.join('；'));
  }
  return data;
}

/**
 * @template T
 * @param {string} p
 * @returns {Promise<T>}
 */
export const get = (p) => api(p);
export const put = (p, body) => api(p, { method: 'PUT', body });
export const post = (p, body) => api(p, { method: 'POST', body });
