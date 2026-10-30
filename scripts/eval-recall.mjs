#!/usr/bin/env node
// 检索评估：她到底记不记得住。
//
// 以前只能靠感觉判断"记忆好不好用"。这个脚本从真实聊天记录里自动出题：
//   · 取 N 天前、长度合适、内容有区分度的一条消息
//   · 用它的前 4 个汉字当查询
//   · 看检索结果里能不能把那条消息找回来
//
// 指标：recall@1 / recall@3 / MRR / p50 延迟。
// 用法：
//   node scripts/eval-recall.mjs                 # 生成题目并评估
//   node scripts/eval-recall.mjs --save          # 同时把题目存到 eval/queries.jsonl
//   node scripts/eval-recall.mjs --days 14 -n 30

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILES } from '../src/paths.js';
import { searchAllHybrid } from '../gui/server/search.mjs';

const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) || dflt : dflt;
};
const days = num('--days', 7);
const want = num('-n', 25);
const save = args.includes('--save');
const strArg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? String(args[i + 1] ?? '') : '';
};
const fromDay = strArg('--from');   // YYYY-MM-DD，可只给一个
const toDay = strArg('--to');

function readJournal(day) {
  const file = path.join(STATE_FILES.journalDir, day + '.jsonl');
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const dayKey = (at) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(at));

// 1) 出题：取 days 天前之后的消息，跳过太短的
// 取哪几天的记录：--from/--to 优先，否则最近 days 天（不含今天）
const targets = [];
if (fromDay || toDay) {
  const all = fs.readdirSync(STATE_FILES.journalDir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .map((n) => n.slice(0, 10))
    .sort();
  for (const day of all) {
    if (fromDay && day < fromDay) continue;
    if (toDay && day > toDay) continue;
    targets.push(day);
  }
} else {
  for (let d = days; d >= 1; d -= 1) targets.push(dayKey(Date.now() - d * 86400000));
}

const rows = [];
for (const day of targets) {
  for (const r of readJournal(day)) {
    const text = String(r.text ?? '').trim();
    if (text.length < 10 || text.length > 60) continue;
    if (/^\[|^https?:/.test(text)) continue;
    rows.push({ day, at: Number(r.t) || 0, role: r.role, text });
  }
}

// 2) 出题：清洗噪声 → 取 4 字窗口 → 要求这个窗口在全语料里出现 ≤2 次
//    以前的取法是"前 4 个字 + 原文唯一"，结果出来一堆「@小鱼」「你快去」这种高频词，
//    recall 虚高到 88%。真正有区分度的查询应该是在整个语料里都很罕见的片段。
function cleanForQuery(text) {
  return String(text ?? '')
    .replace(/\[图片\]|\[表情\]|\[视频\]|\[语音\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/[^\u4e00-\u9fa5]/g, '')   // 只留中文
    .trim();
}

const corpus = rows.map((r) => cleanForQuery(r.text)).join('');
const countInCorpus = (gram) => {
  let n = 0;
  let i = corpus.indexOf(gram);
  while (i >= 0) { n += 1; i = corpus.indexOf(gram, i + 1); }
  return n;
};

const queries = [];
const used = new Set();
for (const r of rows) {
  if (queries.length >= want) break;
  const clean = cleanForQuery(r.text);
  if (clean.length < 8) continue;

  let picked = '';
  // 从中间开始找，跳过前缀（"你快去""你发几"这种开头常常是高频短语）
  for (let i = 2; i + 4 <= clean.length; i += 1) {
    const gram = clean.slice(i, i + 4);
    if (used.has(gram)) continue;
    if (countInCorpus(gram) > 2) continue;   // 全语料最多出现两次
    picked = gram;
    break;
  }
  if (!picked) continue;

  used.add(picked);
  queries.push({
    query: picked,
    expect: clean.slice(0, 28),
    day: r.day,
    role: r.role,
  });
}

if (!queries.length) {
  console.error('没有足够的历史消息出题（先聊几天，或用 --days 放大范围）');
  process.exit(1);
}

// 3) 评估
const lat = [];
let hit1 = 0;
let hit3 = 0;
let mrr = 0;

for (const q of queries) {
  const t0 = process.hrtime.bigint();
  const r = await searchAllHybrid(q.query, { limit: 5 });
  lat.push(Number(process.hrtime.bigint() - t0) / 1e6);

  const texts = (r.groups?.journal ?? []).map((x) => String(x.text ?? ''));
  // 比对前统一只留中文：检索返回的是原文（带标点/emoji），expect 是清洗过的，
  // 直接 includes 会因为标点差异全部失配（这就是第一版掉到 12% 的原因）。
  const norm = (s) => String(s).replace(/[^一-龥]/g, '');
  const found = texts.findIndex((t) => norm(t).includes(norm(q.expect)) || norm(q.expect).includes(norm(t).slice(0, 12)));
  if (found === 0) hit1 += 1;
  if (found >= 0 && found < 3) hit3 += 1;
  if (found >= 0) mrr += 1 / (found + 1);
}

lat.sort((a, b) => a - b);
const p50 = lat[Math.floor(lat.length / 2)] ?? 0;
const n = queries.length;

console.log(`题量 ${n} 条（范围 ${fromDay || ('最近 ' + days + ' 天')} ~ ${toDay || '今天'}）`);
console.log(`recall@1  ${((hit1 / n) * 100).toFixed(0)}%`);
console.log(`recall@3  ${((hit3 / n) * 100).toFixed(0)}%`);
console.log(`MRR       ${(mrr / n).toFixed(3)}`);
console.log(`p50       ${p50.toFixed(1)} ms`);

if (save) {
  const dir = path.join(process.cwd(), 'eval');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'queries.jsonl');
  fs.writeFileSync(file, queries.map((q) => JSON.stringify(q)).join('\n') + '\n', 'utf8');
  console.log(`题目已存：${path.relative(process.cwd(), file)}（${n} 条）`);
}
