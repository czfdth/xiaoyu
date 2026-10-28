// 面板接口：她的画（按月）+ 月度小结。
//
// 图片本身走已有的 /api/works/image/:name；这里只负责"分组 + 统计 + 小结文案"。

import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, STATE_FILES, STATE_DIR } from '../../src/paths.js';
import { groupWorks, composeMonthlyReport, monthStats, monthKey, listImageFiles } from './works-wall.js';

const IMAGES = path.join(APP_ROOT, 'images');

function journalRowsForMonth(month) {
  // journal 按天一个文件，先把该月的日子挑出来再读
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(STATE_FILES.journalDir); } catch { return rows; }
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    const day = name.slice(0, 10);
    if (!day.startsWith(month)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(STATE_FILES.journalDir, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  }
  return rows;
}

function diaryCountForMonth(month, dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith(month) && /\.(md|json)$/i.test(n)).length;
  } catch { return 0; }
}

/** 作品墙：她的画 / 表情 / 梗图，按月归拢。 */
export function worksWall({ month = '' } = {}) {
  const files = listImageFiles(IMAGES);
  const grouped = groupWorks(files);
  const pick = month ? grouped.months.filter((m) => m.month === month) : grouped.months;
  return {
    totals: grouped.totals,
    months: grouped.months.map((m) => ({
      month: m.month,
      art: m.art.length,
      sticker: m.sticker.length,
      meme: m.meme.length,
    })),
    selected: month || (grouped.months[0]?.month ?? ''),
    art: pick.flatMap((m) => m.art),
    stickers: pick.flatMap((m) => m.sticker).slice(0, 60),
    memes: pick.flatMap((m) => m.meme).slice(0, 60),
  };
}

/** 月度小结：算 + 存 + 返回文案。 */
export function buildMonthlyReport({ month = '' } = {}) {
  const target = /^\d{4}-\d{2}$/.test(String(month)) ? String(month) : monthKey(Date.now());
  const rows = journalRowsForMonth(target);
  const stats = monthStats(rows, { month: target });
  const files = listImageFiles(IMAGES);
  const art = groupWorks(files).months.find((m) => m.month === target)?.art.length ?? 0;
  const text = composeMonthlyReport({
    month: target,
    herMessages: stats.her,
    otherMessages: stats.other,
    topPeers: stats.topPeers,
    busiestDay: stats.busiestDay,
    art,
    diary: diaryCountForMonth(target, STATE_FILES.diaryDir),
  });
  try {
    fs.mkdirSync(STATE_FILES.opsReports, { recursive: true });
    fs.writeFileSync(path.join(STATE_FILES.opsReports, `month-${target}.md`), `${text}\n`, 'utf8');
  } catch { /* 存不下来也把文案返回 */ }
  return { ok: true, month: target, text, stats, art };
}

/** 读过的小结列表（面板展示用）。 */
export function listReports({ limit = 30 } = {}) {
  let names = [];
  try { names = fs.readdirSync(STATE_FILES.opsReports).filter((n) => /\.md$/i.test(n)); } catch { return []; }
  return names.sort().reverse().slice(0, limit).map((name) => {
    const file = path.join(STATE_FILES.opsReports, name);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* 读不到就空 */ }
    let at = 0;
    try { at = fs.statSync(file).mtimeMs; } catch { /* 忽略 */ }
    return { name, at, text };
  });
}
