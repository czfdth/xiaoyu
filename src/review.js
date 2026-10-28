// 周末回看：周日晚上给她一份"这周你做了什么"的清单，让她有机会停下来想一想。
//
// 只读现有数据，不新增记录，也不替她写感想——清单给到，想说什么是她的事。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILES } from './paths.js';
import { openDb, closeDb } from './db.js';

function dayKey(at) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at));
}

function weekdayShanghai(now) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date(now));
  return name; // Sun / Mon / ...
}

function hourShanghai(now) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date(now)));
}

/** 统计最近 7 天的客观产出。 */
function lastWeek(now) {
  const from = now - 7 * 86400000;
  const out = { her: 0, other: 0, diary: 0, dreams: 0, posts: 0 };
  try {
    const db = openDb(path.join(STATE_DIR, 'life.db'));
    try {
      const rows = db.prepare('SELECT role, COUNT(*) AS c FROM journal WHERE t >= ? GROUP BY role').all(from);
      for (const r of rows) {
        if (r.role === 'her') out.her = Number(r.c) || 0;
        else out.other += Number(r.c) || 0;
      }
    } finally { closeDb(db); }
  } catch { /* 没索引就算了 */ }

  const countLines = (file, since) => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((x) => x && (Number(x.at ?? x.t) || 0) >= since).length;
    } catch { return 0; }
  };
  out.dreams = countLines(STATE_FILES.dreams, from);

  try {
    const qz = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'qzone-limits.json'), 'utf8').replace(/^\uFEFF/, ''));
    out.posts = (qz?.posts ?? []).filter((id) => Number(id) >= from).length;
  } catch { /* 没记录 */ }

  try {
    const dir = STATE_FILES.diaryDir;
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
      if (new Date(name.slice(0, 10) + 'T00:00:00+08:00').getTime() >= from) out.diary += 1;
    }
  } catch { /* 没日记 */ }

  return out;
}

/**
 * 周日 20:00~23:00 返回一段回看提示，其余时间返回空串。
 * @param {{now?: number}} [opts]
 */
export function weeklyReviewLine({ now = Date.now() } = {}) {
  try {
    if (weekdayShanghai(now) !== 'Sun') return '';
    const h = hourShanghai(now);
    if (h < 20 || h >= 23) return '';
    const w = lastWeek(now);
    return [
      '【这周的你】',
      `说了 ${w.her} 条，听他说了 ${w.other} 条`,
      `写了 ${w.diary} 篇日记、${w.dreams} 个梦、${w.posts} 条说说`,
      '（周日晚上，可以想两句这周过得怎么样；不想说也没关系。）',
      '',
      '',
    ].join('\n');
  } catch {
    return '';
  }
}
