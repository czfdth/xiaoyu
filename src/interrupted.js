// 没做完的回合：断联、打断、崩溃之后，她不该装作什么都没发生。
//
// 场景：一轮跑到 12 步被上下文预算打断，或者桥接重启把回合丢了——
// 她不知道那件事做完了没有，下次醒来应该被提醒一句。
//
// 数据：state/interrupted.jsonl，只追加。读取时只取 6 小时内、未处理过的。
// 边界：只提示"有这么一回事"，不替她编造做完了什么。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';

const FILE = path.join(STATE_DIR, 'interrupted.jsonl');
const MAX_AGE_MS = 6 * 3600 * 1000;

/** 记一条"这轮没做完"。 */
export function recordInterrupted({ key, sessionId, steps, reason = 'context-budget', now = Date.now() } = {}) {
  try {
    if (!key) return;
    fs.appendFileSync(FILE, JSON.stringify({
      at: now, key: String(key), sessionId: String(sessionId ?? ''), steps: Number(steps) || 0, reason,
    }) + '\n', 'utf8');
  } catch { /* 记不下来也不该影响对话 */ }
}

function readAll() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

/** 把超过 6 小时的旧记录清掉（避免文件无限长）。 */
function prune(now) {
  try {
    const keep = readAll().filter((r) => now - (Number(r.at) || 0) <= MAX_AGE_MS);
    fs.writeFileSync(FILE, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
  } catch { /* 忽略 */ }
}

/**
 * 给提示词用的一句话；没有未完成的回合就返回空串。
 * @param {{key?: string, now?: number}} [opts]
 */
export function interruptedLine({ key = '', now = Date.now() } = {}) {
  try {
    const rows = readAll().filter((r) => {
      if (now - (Number(r.at) || 0) > MAX_AGE_MS) return false;
      return key ? String(r.key) === String(key) : true;
    });
    if (!rows.length) return '';
    prune(now);
    const last = rows[rows.length - 1];
    const mins = Math.max(1, Math.round((now - (Number(last.at) || now)) / 60000));
    return '【上次没做完】' + mins + ' 分钟前，你有一轮话被打断（' + (last.reason === 'context-budget' ? '步数到上限' : last.reason) + '）。\n'
      + '（如果那件事还没交代清楚，先把它收个尾；已经过去了就别翻旧账。）\n\n';
  } catch {
    return '';
  }
}
