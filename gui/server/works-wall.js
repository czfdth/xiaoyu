// 「她的画」：把 images/ 里的东西按"是不是她画的"分开，并按月归拢。
//
// 现状：617 张里 488 张是梗图表情（DeepSeek娘台词图），真正她画的是 draw-* / sketch-* / anim-*。
// 之前全混在一个列表里，看不出"她这一个月画了什么"，所以这里先分类再按月排。

import fs from 'node:fs';
import path from 'node:path';

/** 文件名的前缀 → 类别。 */
export function classifyImage(name) {
  const n = String(name ?? '');
  if (/^draw-/.test(n)) return 'draw';
  if (/^sketch-/.test(n)) return 'sketch';
  if (/^anim-/.test(n)) return 'anim';
  if (/^(梗|meme)/.test(n)) return 'meme';
  return 'sticker';
}

/** 是不是"她画的"（画/手绘/动图），表情和梗图不算。 */
export function isHerArt(name) {
  return ['draw', 'sketch', 'anim'].includes(classifyImage(name));
}

/** 上海时区的 YYYY-MM。 */
export function monthKey(at) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).format(new Date(at));
}

/**
 * 把图片列表归成「月份 → 她的画 / 表情 / 梗图」。
 * @param {{name:string, at:number, size?:number}[]} files
 */
export function groupWorks(files = []) {
  const months = new Map();
  const totals = { art: 0, sticker: 0, meme: 0, all: 0 };
  for (const file of files) {
    const kind = classifyImage(file.name);
    const bucket = isHerArt(file.name) ? 'art' : (kind === 'meme' ? 'meme' : 'sticker');
    totals[bucket] += 1;
    totals.all += 1;
    const key = monthKey(file.at ?? Date.now());
    if (!months.has(key)) months.set(key, { month: key, art: [], sticker: [], meme: [] });
    months.get(key)[bucket].push({ ...file, kind });
  }
  const list = [...months.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
  for (const m of list) {
    for (const key of ['art', 'sticker', 'meme']) m[key].sort((a, b) => b.at - a.at);
  }
  return { totals, months: list };
}

/**
 * 月度小结文案。数据都由调用方从 journal / 画 / 日记 / 账本里取好。
 * @param {{month:string, herMessages?:number, otherMessages?:number, topPeers?:Array, art?:number,
 *          diary?:number, moodTop?:string, cost?:number, tokens?:number, busiestDay?:{day:string,count:number}}} data
 */
export function composeMonthlyReport(data = {}) {
  const month = String(data.month ?? '');
  const her = Number(data.herMessages) || 0;
  const other = Number(data.otherMessages) || 0;
  const lines = [`【${month} · 小结】`];
  const peers = Array.isArray(data.topPeers) ? data.topPeers.filter((p) => p && p.count > 0).slice(0, 3) : [];
  lines.push(`这个月说了 ${her} 条，被搭话 ${other} 条${peers.length ? `；主要和 ${peers.map((p) => `${p.who}（${p.count}）`).join('、')} 聊` : ''}`);
  if (Number(data.art) > 0) lines.push(`画了 ${data.art} 张`);
  if (Number(data.diary) > 0) lines.push(`写了 ${data.diary} 篇日记`);
  if (data.busiestDay?.day) lines.push(`话最多的一天是 ${data.busiestDay.day}（${data.busiestDay.count} 条）`);
  if (data.moodTop) lines.push(`最常出现的情绪：${data.moodTop}`);
  if (Number(data.cost) > 0) lines.push(`花了 ≈ ¥${Number(data.cost).toFixed(2)}（${Math.round((Number(data.tokens) || 0) / 10000)} 万 token）`);
  if (!her && !other) lines.push('这个月她几乎没说话。');
  return lines.join('\n');
}

/** 从一批 journal 行里数出月度统计（纯函数，方便测）。 */
export function monthStats(rows = [], { month }) {
  const out = { month, her: 0, other: 0, peers: new Map(), days: new Map(), moods: new Map() };
  for (const row of rows) {
    const at = Number(row?.t);
    if (!Number.isFinite(at) || monthKey(at) !== month) continue;
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(at));
    out.days.set(day, (out.days.get(day) || 0) + 1);
    if (row.role === 'her') { out.her += 1; continue; }
    out.other += 1;
    const who = String(row.sender || (String(row.key).startsWith('group:') ? '群里' : '他')).slice(0, 12);
    out.peers.set(who, (out.peers.get(who) || 0) + 1);
  }
  const busiest = [...out.days.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    month,
    her: out.her,
    other: out.other,
    topPeers: [...out.peers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([who, count]) => ({ who, count })),
    busiestDay: busiest ? { day: busiest[0], count: busiest[1] } : null,
  };
}

/** 读一个目录的图片清单（给 worksWall 用）。 */
export function listImageFiles(dir, { extensions = /\.(png|jpe?g|webp|gif)$/i, limit = 2000 } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!extensions.test(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, at: st.mtimeMs, size: st.size });
    } catch { /* 跳过读不到的 */ }
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.at - a.at);
}
