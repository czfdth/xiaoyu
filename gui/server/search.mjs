// 全局搜索：在她的记忆里找东西（聊天记录 / 事实 / 日记 / 知识库）。
//
// 之前没有任何入口——3000 多条对话只能自己翻 JSONL。这里给面板一个统一的 search。
// 刻意不引入 FTS5：node:sqlite 的 FTS 支持不稳定，而数据量（万级）用 LIKE 完全够。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILES } from '../../src/paths.js';
import { openDb, closeDb } from '../../src/db.js';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

/** LIKE 里的 % 和 _ 是通配符：不转义的话，搜 "%" 会返回全部记录（安全审查 P1-09）。 */
function escapeLike(input) {
  // 用 '!' 当转义符：反斜杠要同时穿过 JS 字符串和 SQL 字面量，太难写对。
  return String(input ?? '').replace(/[!%_]/g, (ch) => '!' + ch);
}

function snippet(text, q, radius = 40) {
  const s = String(text ?? '');
  const at = s.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return s.slice(0, radius * 2);
  const from = Math.max(0, at - radius);
  const to = Math.min(s.length, at + q.length + radius);
  return (from > 0 ? '…' : '') + s.slice(from, to) + (to < s.length ? '…' : '');
}

/** 聊天记录（走 SQLite，一次查询就够）。 */
function searchJournal(q, limit) {
  const dbFile = path.join(STATE_DIR, 'life.db');
  let db = null;
  try {
    db = openDb(dbFile);
    const rows = db.prepare(`
      SELECT day, t, role, text FROM journal
      WHERE text LIKE ? ESCAPE '!'
      -- 按命中位置和长度排序：以前按时间倒序，命中的那条可能排到第 50 位（评估 recall 只有 52%）。
      ORDER BY instr(text, ?) ASC, length(text) ASC, t DESC LIMIT ?
    `).all(`%${escapeLike(q)}%`, q, limit);
    return rows.map((r) => ({
      kind: 'journal',
      at: Number(r.t) || 0,
      day: r.day,
      who: r.role === 'her' ? '她' : '对方',
      text: snippet(r.text, q),
      raw: String(r.text ?? '').slice(0, 400),
    }));
  } catch {
    return [];
  } finally {
    if (db) { try { closeDb(db); } catch { /* 忽略 */ } }
  }
}

/** 事实层（她记得的关于你的事）。 */
function searchFacts(q, limit) {
  const store = readJson(STATE_FILES.facts, { facts: [] });
  const list = Array.isArray(store.facts) ? store.facts : [];
  const lower = q.toLowerCase();
  return list
    .filter((f) => `${f.subject ?? ''} ${f.predicate ?? ''} ${f.object ?? ''}`.toLowerCase().includes(lower))
    .slice(0, limit)
    .map((f) => ({
      kind: 'fact',
      at: Number(f.at) || 0,
      text: `${f.subject ?? '?'} · ${f.predicate ?? '?'} · ${f.object ?? '?'}`,
      confidence: Number(f.confidence) || 0,
      source: String(f.source ?? ''),
    }));
}

/** 日记（按天一个 md，直接全文匹配）。 */
function searchDiary(q, limit) {
  const dir = STATE_FILES.diaryDir;
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().reverse(); } catch { return out; }
  for (const name of names) {
    if (out.length >= limit) break;
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      if (text.toLowerCase().includes(q.toLowerCase())) {
        out.push({ kind: 'diary', day: name.slice(0, 10), at: 0, text: snippet(text, q, 50) });
      }
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

/** 知识库（她自己存的资料，一行一条 JSONL）。 */
function searchKnowledge(q, limit) {
  let list = [];
  try {
    list = fs.readFileSync(STATE_FILES.knowledgeIndex, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
  const lower = q.toLowerCase();
  return list
    .filter((k) => `${k.title ?? ''} ${k.text ?? ''} ${(k.tags ?? []).join(' ')}`.toLowerCase().includes(lower))
    .slice(0, limit)
    .map((k) => ({ kind: 'knowledge', at: Number(k.at) || 0, text: String(k.title ?? ''), raw: snippet(k.text ?? '', q) }));
}

/**
 * 在她的一切里找。
 * @param {string} q 关键词
 * @param {{limit?:number}} [opts]
 */
export function searchAll(q, { limit = 20, includeJournal = true } = {}) {
  const query = String(q ?? '').trim();
  if (query.length < 1) return { query, groups: {}, total: 0 };
  const per = Math.max(3, Math.min(30, limit));

  const groups = {
    // 聊天记录最敏感：默认能搜，但工具层会按配置关掉它（安全审查 P0-03）
    journal: includeJournal ? searchJournal(query, per) : [],
    fact: searchFacts(query, per),
    diary: searchDiary(query, Math.min(per, 10)),
    knowledge: searchKnowledge(query, Math.min(per, 10)),
  };
  const total = Object.values(groups).reduce((n, arr) => n + arr.length, 0);
  return { query, groups, total };
}

/**
 * 混合检索：先走 LIKE（快，几十毫秒），命中太少时补一路语义检索（慢，约 4 秒）。
 *
 * 为什么有条件：查询向量要现算（bge-m3 在 CPU 上单条约 4 秒），
 * 每条搜索都等它不可接受；但只靠 LIKE 时，recall@1 只有 56%。
 * 折中：LIKE 命中 < 3 条才补语义——难查的才付这个代价。
 *
 * @param {string} q
 * @param {{limit?:number, includeJournal?:boolean, semantic?:boolean}} [opts]
 */
export async function searchAllHybrid(q, { limit = 20, includeJournal = true, semantic = true } = {}) {
  const base = searchAll(q, { limit, includeJournal });
  const journalCount = base.groups?.journal?.length ?? 0;
  if (!semantic || !includeJournal || journalCount >= 3) return base;

  try {
    const { semanticSearch } = await import('../../src/semantic-index.js');
    const { STATE_FILES } = await import('../../src/paths.js');
    const hits = await semanticSearch({
      query: q,
      file: STATE_FILES.semanticIndex,
      k: Math.max(3, Math.min(10, limit)),
      kinds: ['journal', 'memory', 'diary', 'knowledge', 'fact'],
      minScore: 0.5,
    });
    if (!hits.length) return base;

    const seen = new Set((base.groups.journal ?? []).map((x) => String(x.raw ?? x.text ?? '')));
    const merged = [...(base.groups.journal ?? [])];
    for (const h of hits) {
      const text = String(h.text ?? '');
      if (!text || seen.has(text)) continue;
      seen.add(text);
      merged.push({
        kind: 'journal',
        at: Number(h.at) || 0,
        who: '',
        text,
        raw: text,
        score: Number(h.score) || 0,
        via: 'semantic',
      });
      if (merged.length >= limit) break;
    }
    const groups = { ...base.groups, journal: merged.slice(0, limit) };
    const total = Object.values(groups).reduce((n, arr) => n + arr.length, 0);
    return { ...base, groups, total };
  } catch {
    return base;   // 语义检索失败就用 LIKE 的结果，不影响可用性
  }
}
