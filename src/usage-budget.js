// 每天用量的账：日预算的判定材料。
//
// 为什么单独一份：token 账本是"逐条明细"，日预算要的是"今天一共多少 + 今天主动了几次"，
// 每次都从头扫 5000 行太浪费；这里在事件里累加，按上海日期翻页。
//
// 只做三件事：累计、翻页、判断"还能不能主动"。

import fs from 'node:fs';
import path from 'node:path';

/** 上海时区的 YYYY-MM-DD（跨零点换日按北京时间，不是 UTC）。 */
export function dayKey(at = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date(at));
}

/** 配置归一化：limits 可能是 null。 */
export function normalizeLimits(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const intIn = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  return {
    dailyTokens: intIn(src.dailyTokens, 0, 0, 1_000_000_000),
    proactivePerDay: intIn(src.proactivePerDay, 0, 0, 10_000),
  };
}

export function emptyDay(key = dayKey()) {
  return { day: key, tokens: 0, proactive: 0, updatedAt: 0 };
}

export function loadDaily(file, at = Date.now()) {
  let state = emptyDay(dayKey(at));
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (raw && typeof raw === 'object' && raw.day === state.day) {
      state = {
        day: state.day,
        tokens: Number(raw.tokens) || 0,
        proactive: Number(raw.proactive) || 0,
        updatedAt: Number(raw.updatedAt) || 0,
      };
    } else if (raw && typeof raw === 'object') {
      // 跨天了：只保留历史里最新一天的累计值做参考，不累加
      state.updatedAt = Number(raw.updatedAt) || 0;
    }
  } catch { /* 没有文件就从零开始 */ }
  return state;
}

export function saveDaily(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 写不进去不影响主流程 */ }
}

/** 累加用量；跨天会重置成今天的。返回新的 state。 */
export function addUsage(file, tokens, at = Date.now()) {
  const state = loadDaily(file, at);
  state.tokens += Math.max(0, Number(tokens) || 0);
  state.updatedAt = at;
  saveDaily(file, state);
  return state;
}

/** 记一次主动唤醒。 */
export function addProactive(file, at = Date.now()) {
  const state = loadDaily(file, at);
  state.proactive += 1;
  state.updatedAt = at;
  saveDaily(file, state);
  return state;
}

/**
 * 现在还能不能主动开口。
 * @returns {{block:boolean, reason:string}}
 */
export function shouldBlockAutonomous({ usedTokens = 0, proactiveCount = 0, limits } = {}) {
  const lim = normalizeLimits(limits);
  if (lim.dailyTokens > 0 && usedTokens >= lim.dailyTokens) {
    return { block: true, reason: `今日 token 已用 ${usedTokens}，达到上限 ${lim.dailyTokens}` };
  }
  if (lim.proactivePerDay > 0 && proactiveCount >= lim.proactivePerDay) {
    return { block: true, reason: `今日主动已 ${proactiveCount} 次，达到上限 ${lim.proactivePerDay}` };
  }
  return { block: false, reason: '' };
}
