import { reactive } from 'vue';
import { get } from './api.js';

export const store = reactive({
  overview: null,
  overviewError: '',
  loadingOverview: false,
  toasts: [],
  lastRefresh: 0,
});

let toastId = 0;

export function toast(message, type = 'ok', ms = 3200) {
  const id = ++toastId;
  store.toasts.push({ id, message, type });
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === id);
    if (i >= 0) store.toasts.splice(i, 1);
  }, ms);
}

export function toastError(error) {
  toast(String(error?.message ?? error), 'err', 5200);
}

export async function refreshOverview({ silent = false } = {}) {
  if (!silent) store.loadingOverview = true;
  try {
    store.overview = await get('/overview');
    store.overviewError = '';
    store.lastRefresh = Date.now();
  } catch (error) {
    store.overviewError = String(error?.message ?? error);
    if (!silent) toastError(error);
  } finally {
    store.loadingOverview = false;
  }
}

// 页面里常用的格式化
export function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  return `${Math.floor(diff / 86400e3)} 天前`;
}

export function fmtTime(ts) {
  if (!ts) return '';
  return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false });
}

export function fmtClock(ts) {
  if (!ts) return '';
  return new Date(Number(ts)).toLocaleTimeString('zh-CN', { hour12: false });
}

export function pct(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}
