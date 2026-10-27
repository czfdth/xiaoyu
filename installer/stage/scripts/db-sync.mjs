#!/usr/bin/env node
// 把 journal 增量同步进 SQLite 索引（JSONL 仍是唯一真相）。
// 用法：node scripts/db-sync.mjs [--stats]
import path from 'node:path';
import { STATE_DIR, STATE_FILES } from '../src/paths.js';
import { openDb, syncJournal, stats, dailyCounts, closeDb } from '../src/db.js';

const dbFile = path.join(STATE_DIR, 'life.db');
const db = openDb(dbFile);
try {
  const result = syncJournal(db, STATE_FILES.journalDir);
  const s = stats(db);
  console.log(`同步：新增 ${result.inserted} 条（${result.files} 个文件，跳过 ${result.skipped}）`);
  console.log(`库里共 ${s.rows} 条 / ${s.days} 天`);
  if (process.argv.includes('--stats')) {
    for (const row of dailyCounts(db, { days: 7 })) console.log(`  ${row.day}  她 ${row.her}  对方 ${row.other}`);
  }
} finally {
  closeDb(db);
}
