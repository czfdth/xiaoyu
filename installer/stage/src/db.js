// 结构化存储：JSONL 继续做"唯一真相"，SQLite 只做查询索引。
//
// 为什么不全量换库：state/ 里的 JSON 已经跑了几个月、有备份、有恢复演练，
// 贸然迁移风险大于收益。真正难受的是"按会话查历史"和"按天统计"——这两类查询
// 用 sqlite 建索引就够了，JSONL 仍然一行一行追加、随时能读能 grep。
//
// 用 Node 内置的 node:sqlite（Node 22+），零依赖。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

/** 打开（或建）数据库；幂等。 */
export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS journal (
      key TEXT, t INTEGER, role TEXT, sender TEXT, text TEXT, day TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_journal_key_t ON journal(key, t);
    CREATE INDEX IF NOT EXISTS idx_journal_day ON journal(day);
    CREATE TABLE IF NOT EXISTS usage_day (
      day TEXT, key TEXT, model TEXT,
      steps INTEGER, hit INTEGER, miss INTEGER, out INTEGER,
      PRIMARY KEY (day, key, model)
    );
    CREATE TABLE IF NOT EXISTS daily (
      day TEXT PRIMARY KEY, her INTEGER, other INTEGER, tokens INTEGER, cost REAL
    );
  `);
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
  return db;
}

function metaGet(db, key) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key);
  return row?.v ?? '';
}

function metaSet(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(key, String(value));
}

/**
 * 增量把 journal 灌进库：每个文件记一个"已同步到第几行"的水位。
 * @returns {{inserted:number, files:number, skipped:number}}
 */
export function syncJournal(db, journalDir) {
  let names = [];
  try { names = fs.readdirSync(journalDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort(); }
  catch { return { inserted: 0, files: 0, skipped: 0 }; }

  const insert = db.prepare('INSERT INTO journal (key, t, role, sender, text, day) VALUES (?, ?, ?, ?, ?, ?)');
  let inserted = 0;
  let files = 0;
  let skipped = 0;

  for (const name of names) {
    const file = path.join(journalDir, name);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { continue; }
    const marker = `journal:${name}`;
    const done = Number(metaGet(db, marker)) || 0;
    if (lines.length <= done) { skipped += 1; continue; }
    files += 1;
    db.exec('BEGIN');
    try {
      for (const line of lines.slice(done)) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const t = Number(row?.t);
        if (!Number.isFinite(t)) continue;
        insert.run(
          String(row?.key ?? ''),
          t,
          String(row?.role ?? ''),
          String(row?.sender ?? ''),
          String(row?.text ?? ''),
          name.slice(0, 10),
        );
        inserted += 1;
      }
      metaSet(db, marker, String(lines.length));
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
    }
  }
  return { inserted, files, skipped };
}

/** 按会话查最近的记录（给 MCP 工具/排查用）。 */
export function journalQuery(db, { key = '', since = 0, limit = 50 } = {}) {
  const rows = key
    ? db.prepare('SELECT key, t, role, sender, text FROM journal WHERE key = ? AND t >= ? ORDER BY t DESC LIMIT ?').all(key, Number(since) || 0, Number(limit) || 50)
    : db.prepare('SELECT key, t, role, sender, text FROM journal WHERE t >= ? ORDER BY t DESC LIMIT ?').all(Number(since) || 0, Number(limit) || 50);
  return rows.map((r) => ({ key: r.key, t: Number(r.t), role: r.role, sender: r.sender, text: r.text }));
}

/** 每天说了多少（她 / 对方），给面板和日报用。 */
export function dailyCounts(db, { days = 30 } = {}) {
  return db.prepare(`
    SELECT day,
           SUM(CASE WHEN role = 'her' THEN 1 ELSE 0 END) AS her,
           SUM(CASE WHEN role <> 'her' THEN 1 ELSE 0 END) AS other
    FROM journal GROUP BY day ORDER BY day DESC LIMIT ?
  `).all(Number(days) || 30).map((r) => ({ day: r.day, her: Number(r.her) || 0, other: Number(r.other) || 0 }));
}

export function stats(db) {
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM journal').get()?.n) || 0;
  const days = Number(db.prepare('SELECT COUNT(DISTINCT day) AS n FROM journal').get()?.n) || 0;
  return { rows: total, days, version: SCHEMA_VERSION };
}

export function closeDb(db) {
  try { db.close(); } catch { /* 已经关了 */ }
}

/**
 * 把 token 账本增量聚合进库（按 天/会话/模型）。
 * 面板每次统计就不用再扫几千行 JSONL 了。
 * @returns {{rows:number, skipped:boolean}}
 */
export function syncTokens(db, file) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return { rows: 0, skipped: true }; }
  const marker = 'tokens:' + path.basename(file);
  const done = Number(metaGet(db, marker)) || 0;
  if (lines.length <= done) return { rows: 0, skipped: true };

  const upsert = db.prepare(`
    INSERT INTO usage_day (day, key, model, steps, hit, miss, out)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(day, key, model) DO UPDATE SET
      steps = steps + 1,
      hit = hit + excluded.hit,
      miss = miss + excluded.miss,
      out = out + excluded.out
  `);

  const dayOf = (at) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  let rows = 0;
  db.exec('BEGIN');
  try {
    for (const line of lines.slice(done)) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.k !== 'turn' || !row.b) continue;
      const at = Number(row.t);
      if (!Number.isFinite(at)) continue;
      upsert.run(
        dayOf(at),
        String(row.key ?? ''),
        String(row.model ?? ''),
        Number(row.b.cacheHit) || 0,
        Number(row.b.cacheMiss) || 0,
        Number(row.b.output) || 0,
      );
      rows += 1;
    }
    metaSet(db, marker, String(lines.length));
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    return { rows: 0, skipped: false };
  }
  return { rows, skipped: false };
}

/** 按天汇总（panel 用）：步数 / prompt / 输出 / 估算花费。 */
export function usageByDay(db, { days = 7 } = {}) {
  return db.prepare(`
    SELECT day, SUM(steps) AS steps, SUM(hit) AS hit, SUM(miss) AS miss, SUM(out) AS out
    FROM usage_day GROUP BY day ORDER BY day DESC LIMIT ?
  `).all(Number(days) || 7).map((r) => ({
    day: r.day,
    steps: Number(r.steps) || 0,
    prompt: (Number(r.hit) || 0) + (Number(r.miss) || 0),
    output: Number(r.out) || 0,
    cost: Math.round((((Number(r.hit) || 0) * 0.02 + (Number(r.miss) || 0) * 1 + (Number(r.out) || 0) * 4) / 1e6) * 100) / 100,
  }));
}
