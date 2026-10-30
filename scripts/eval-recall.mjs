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
import { searchAll } from '../gui/server/search.mjs';

const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) || dflt : dflt;
};
const days = num('--days', 7);
const want = num('-n', 25);
const save = args.includes('--save');

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
const rows = [];
for (let d = days; d >= 1; d -= 1) {
  const day = dayKey(Date.now() - d * 86400000);
  for (const r of readJournal(day)) {
    const text = String(r.text ?? '').trim();
    if (text.length < 10 || text.length > 60) continue;
    if (/^\[|^https?:/.test(text)) continue;
    rows.push({ day, at: Number(r.t) || 0, role: r.role, text });
  }
}

// 2) 每条取前 4 个汉字当查询（要求这 4 个字在全文里只出现一次，减少巧合命中）
const queries = [];
const used = new Set();
for (const r of rows) {
  if (queries.length >= want) break;
  const head = r.text.slice(0, 4).replace(/[，。！？、；：""''（）\s]/g, '');
  if (head.length < 3) continue;
  if (used.has(head)) continue;
  const occurrences = r.text.split(head).length - 1;
  if (occurrences !== 1) continue;
  used.add(head);
  queries.push({ query: head, expect: r.text.slice(0, 24), day: r.day, role: r.role });
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
  const r = searchAll(q.query, { limit: 5 });
  lat.push(Number(process.hrtime.bigint() - t0) / 1e6);

  const texts = (r.groups?.journal ?? []).map((x) => String(x.text ?? ''));
  const norm = (s) => s.replace(/…/g, '');
  const found = texts.findIndex((t) => norm(t).includes(norm(q.expect)) || norm(q.expect).includes(norm(t).slice(0, 12)));
  if (found === 0) hit1 += 1;
  if (found >= 0 && found < 3) hit3 += 1;
  if (found >= 0) mrr += 1 / (found + 1);
}

lat.sort((a, b) => a - b);
const p50 = lat[Math.floor(lat.length / 2)] ?? 0;
const n = queries.length;

console.log(`题量 ${n} 条（取自 ${days} 天前的真实消息）`);
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
