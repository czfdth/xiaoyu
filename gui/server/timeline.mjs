// 生活时间流：把这几天真实发生过的事按时间排好。
//
// 数据全是现成的（日记 / 梦 / 说说 / 她的画 / 聊天条数），以前只是从没按时间合并过。
// 只读，不改任何东西。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILES } from '../../src/paths.js';
import { openDb, closeDb } from '../../src/db.js';

const DAY_MS = 86400000;

function dayKey(at) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * @param {{days?: number}} [opts]
 * @returns {{days: Array<{day:string, items:Array<{at:number,kind:string,text:string}>}>}}
 */
export function lifeTimeline({ days = 7 } = {}) {
  const n = Math.max(1, Math.min(30, Number(days) || 7));
  const now = Date.now();
  const from = now - n * DAY_MS;
  const items = [];

  // 日记：一天一篇，时间取文件 mtime
  try {
    for (const name of fs.readdirSync(STATE_FILES.diaryDir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
      const full = path.join(STATE_FILES.diaryDir, name);
      const st = fs.statSync(full);
      if (st.mtimeMs < from) continue;
      const body = fs.readFileSync(full, 'utf8').trim().split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const head = body[0] ?? '';
      items.push({ at: st.mtimeMs, kind: 'diary', text: '写了日记：' + String(head).slice(0, 40) });
    }
  } catch { /* 没日记 */ }

  // 梦
  for (const d of readJsonl(STATE_FILES.dreams)) {
    const at = Number(d?.at) || 0;
    if (!at || at < from) continue;
    items.push({ at, kind: 'dream', text: '做了个梦：' + String(d.dream ?? '').slice(0, 40) });
  }

  // 说说：post id 本身就是毫秒时间戳
  try {
    const qz = readJson(path.join(STATE_DIR, 'qzone-limits.json'), {});
    for (const id of (qz?.posts ?? [])) {
      const at = Number(id);
      if (!Number.isFinite(at) || at < from) continue;
      items.push({ at, kind: 'qzone', text: '发了一条说说' });
    }
  } catch { /* 没记录 */ }

  // 她画的画：按文件时间
  try {
    for (const name of fs.readdirSync(STATE_FILES.images)) {
      if (!/^(draw|sketch)-.*\.png$/i.test(name)) continue;
      const st = fs.statSync(path.join(STATE_FILES.images, name));
      if (st.mtimeMs < from) continue;
      items.push({ at: st.mtimeMs, kind: 'draw', text: '画了一张：' + name.replace(/^(draw|sketch)-/, '').replace(/\.png$/i, '').slice(0, 24) });
    }
  } catch { /* 没图库 */ }

  // 每天的聊天条数（合并成一条，不然时间流会被几百条消息淹没）
  try {
    const db = openDb(path.join(STATE_DIR, 'life.db'));
    try {
      const rows = db.prepare(`
        SELECT day, SUM(CASE WHEN role='her' THEN 1 ELSE 0 END) AS her,
               SUM(CASE WHEN role<>'her' THEN 1 ELSE 0 END) AS other,
               MAX(t) AS last
        FROM journal WHERE t >= ? GROUP BY day
      `).all(now - n * DAY_MS);
      for (const r of rows) {
        items.push({
          at: Number(r.last) || now,
          kind: 'chat',
          text: `聊了 ${Number(r.her) || 0} 条，听他说 ${Number(r.other) || 0} 条`,
        });
      }
    } finally { closeDb(db); }
  } catch { /* 没索引 */ }

  items.sort((a, b) => b.at - a.at);

  const byDay = new Map();
  for (const it of items) {
    const day = dayKey(it.at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(it);
  }
  return {
    days: [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, list]) => ({ day, items: list.slice(0, 30) })),
  };
}
