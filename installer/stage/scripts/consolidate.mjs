#!/usr/bin/env node
// 记忆沉淀：把 N 天前的 journal 流水变成一章回忆录，原文归档成 .gz。
//
// 用法：
//   node scripts/consolidate.mjs              # 默认处理 30 天前的，跑完就归档
//   node scripts/consolidate.mjs --days=30 --dry-run
//   node scripts/consolidate.mjs --month=2026-10 --force   # 指定月份（调试用）

import fs from 'node:fs';
import path from 'node:path';
import { STATE_FILES } from '../src/paths.js';
import { pickQuotes, composeChapter, countDays, archiveMonth } from '../src/consolidate.js';
import { monthStats } from '../gui/server/works-wall.js';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const days = Number(args.get('days')) > 0 ? Number(args.get('days')) : 30;
const dryRun = args.get('dry-run') === 'true';
const forceMonth = String(args.get('month') ?? '');
const force = args.get('force') === 'true';

const journalDir = STATE_FILES.journalDir;
const memoirDir = STATE_FILES.memoirDir;
const archiveDir = path.join(path.dirname(journalDir), 'journal-archive');

function listJournalFiles() {
  try {
    return fs.readdirSync(journalDir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .sort()
      .map((n) => path.join(journalDir, n));
  } catch { return []; }
}

function nextChapterNumber() {
  let max = 0;
  try {
    for (const name of fs.readdirSync(memoirDir)) {
      const m = name.match(/^第(\d+)章/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* 还没有回忆录 */ }
  return max + 1;
}

function readRows(files) {
  const rows = [];
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  }
  return rows;
}

const cutoff = Date.now() - days * 86400000;
const files = listJournalFiles();
const eligible = files.filter((file) => {
  const day = path.basename(file).slice(0, 10);
  if (forceMonth) return day.startsWith(forceMonth);
  if (force) return true;
  return Number(new Date(`${day}T00:00:00+08:00`)) < cutoff;
});

if (!eligible.length) {
  console.log(`没有需要沉淀的（${days} 天前，共 ${files.length} 天记录）。`);
  process.exit(0);
}

const byMonth = new Map();
for (const file of eligible) {
  const month = path.basename(file).slice(0, 7);
  if (!byMonth.has(month)) byMonth.set(month, []);
  byMonth.get(month).push(file);
}

let chapterNo = nextChapterNumber();
const written = [];
for (const [month, monthFiles] of byMonth) {
  const rows = readRows(monthFiles);
  const stats = monthStats(rows, { month });
  const quotes = pickQuotes(rows, { limit: 6 });
  const text = composeChapter({
    month,
    stats,
    quotes,
    totalDays: countDays(monthFiles, month),
    herMessages: stats.her,
    otherMessages: stats.other,
    topPeers: stats.topPeers,
  });
  const name = `第${String(chapterNo).padStart(2, '0')}章-${month}.md`;
  const target = path.join(memoirDir, name);
  if (!dryRun) {
    fs.mkdirSync(memoirDir, { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
  }
  const archived = archiveMonth(monthFiles, { archiveDir, dryRun });
  const bytes = archived.reduce((n, a) => n + a.bytes, 0);
  written.push({ month, name, days: monthFiles.length, quotes: quotes.length, bytes });
  console.log(`${dryRun ? '[演练] ' : ''}${month} → ${name}（${monthFiles.length} 天，${quotes.length} 句原话，归档 ${Math.round(bytes / 1024)}KB）`);
  chapterNo += 1;
}

if (dryRun) {
  console.log('\n这是演练，什么都没写、没删。去掉 --dry-run 才真的执行。');
} else if (written.length) {
  console.log(`\n完成：新增 ${written.length} 章，原文已归档到 state/journal-archive/。`);
}
