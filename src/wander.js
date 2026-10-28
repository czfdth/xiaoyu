// 走神：她偶尔会"忽然想起"一件真发生过的事。
//
// 设计边界（重要）：**不编造**。所有候选都来自真实数据——旧的聊天记录、她记下的事实。
// 随机只决定"想起什么"，不决定"发生过什么"。
//
// 独立成文件而不是塞进 bridge.js：bridge 已经 14000 行，塞进去只能靠字符串补丁，
// 而今天所有补丁事故都出在转义上。这里 exports 一个纯函数，bridge 只加一行调用。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILES } from './paths.js';
import { openDb, closeDb } from './db.js';

const TWO_DAYS = 2 * 86400000;

function readFacts() {
  try {
    const raw = fs.readFileSync(STATE_FILES.facts, 'utf8').replace(/^\uFEFF/, '');
    const store = JSON.parse(raw);
    return Array.isArray(store?.facts) ? store.facts : [];
  } catch {
    return [];
  }
}

function pickOldJournal(now, limit = 40) {
  const cutoff = now - TWO_DAYS;
  const db = openDb(path.join(STATE_DIR, 'life.db'));
  try {
    // 用 (t/cutoff) 做加权：越近的越容易被挑到，但老的也在池子里
    return db.prepare(
      'SELECT t, role, text FROM journal WHERE t < ? AND length(text) BETWEEN 8 AND 80 ORDER BY (t * 1.0 / ?) DESC LIMIT ?',
    ).all(cutoff, cutoff, limit);
  } finally {
    closeDb(db);
  }
}

/**
 * @param {{now?: number, chance?: number}} [opts]
 * @returns {string} 要拼进提示词的一段话；没触发时返回空字符串
 */
export function wanderLine({ now = Date.now(), chance = 0.12 } = {}) {
  try {
    if (Math.random() > chance) return '';

    const pool = [];
    try {
      for (const r of pickOldJournal(now)) {
        pool.push({ kind: 'journal', at: Number(r.t) || 0, role: r.role, text: String(r.text ?? '') });
      }
    } catch { /* 没索引就只用事实 */ }

    for (const f of readFacts().slice(-30)) {
      if (!f?.object) continue;
      pool.push({ kind: 'fact', at: Number(f.at) || 0, role: '', text: `${f.subject ?? '你'} ${f.predicate ?? ''} ${f.object}` });
    }

    if (!pool.length) return '';

    const pick = pool[Math.floor(Math.random() * pool.length)];
    const days = pick.at ? Math.max(1, Math.round((now - pick.at) / 86400000)) : 0;
    const ago = days ? `${days} 天前` : '以前';
    const who = pick.kind === 'fact' ? '' : (pick.role === 'her' ? '你自己说过：' : '你说过：');
    const body = String(pick.text).slice(0, 60);

    return `【忽然想起】${ago}${who}${body}\n（不用刻意提，想到了就顺口说一句，没想到就放着。）\n\n`;
  } catch {
    return '';
  }
}
