// 建/更新语义索引：把她的旧聊天、长期记忆、日记、知识、梦做成 bge-m3 向量。
//
// 用法：
//   node scripts/build-semantic-index.mjs            # 增量（只算新增/改过的）
//   node scripts/build-semantic-index.mjs --rebuild  # 全部重算
//   node scripts/build-semantic-index.mjs --days=365 # 往前多少天的聊天（默认 90）
//
// 依赖本机 Ollama 在跑、并且有 bge-m3（`ollama list` 能看到）。没装/没开就什么都不改，退出码 1。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, STATE_FILES } from '../src/paths.js';
import {
  SEMANTIC_MODEL_DEFAULT,
  SEMANTIC_BASE_DEFAULT,
  embedTexts,
  loadIndex,
  saveIndex,
  SEMANTIC_INDEX_VERSION,
} from '../src/semantic-index.js';

const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
const days = Math.max(1, Math.min(3650, Number((args.find((a) => a.startsWith('--days=')) ?? '').split('=')[1]) || 90));
const model = (args.find((a) => a.startsWith('--model=')) ?? '').split('=')[1] || SEMANTIC_MODEL_DEFAULT;
const baseUrl = (args.find((a) => a.startsWith('--base=')) ?? '').split('=')[1] || SEMANTIC_BASE_DEFAULT;
const outFile = path.join(STATE_DIR, 'semantic-index.json');
const log = (msg) => console.log(msg);
const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 收集要索引的条目：id 稳定（同一条内容重跑不会重复）。 */
function collect() {
  const items = [];
  const cutoff = Date.now() - days * 86400000;

  // 1) 聊天流水（按天一个文件）
  try {
    const dir = STATE_FILES.journalDir;
    for (const name of fs.readdirSync(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      const day = m[1];
      if (Date.parse(`${day}T00:00:00+08:00`) < cutoff) continue;
      const rows = readJsonl(path.join(dir, name));
      rows.forEach((row, i) => {
        const text = String(row.text ?? row.plain ?? '').trim();
        if (text.length < 4) return;
        items.push({
          id: `j:${day}:${i}`,
          kind: 'journal',
          day,
          key: String(row.key ?? ''),
          who: row.role === 'her' ? '她' : '对方',
          text: text.slice(0, 500),
          at: Number(row.t) || 0,
        });
      });
    }
  } catch { /* 没有 journal 就没有 */ }

  // 2) 长期记忆
  try {
    const mem = JSON.parse(fs.readFileSync(STATE_FILES.longTermMemory, 'utf8').replace(/^\uFEFF/, ''));
    for (const item of mem.items ?? []) {
      const text = String(item.text ?? '').trim();
      if (!text) continue;
      items.push({ id: `m:${item.id}`, kind: 'memory', day: '', key: '', who: '记忆', text: text.slice(0, 500), at: Number(item.createdAt) || 0 });
    }
  } catch { /* 没有记忆就没有 */ }

  // 3) 日记索引
  // 事实层：每条事实一句话（"他 在忙：准备考研"），这样"他生日几号"这种问法也能被向量召回
  try {
    const facts = JSON.parse(fs.readFileSync(STATE_FILES.facts, 'utf8').replace(/^\uFEFF/, ''))?.facts ?? [];
    for (const f of facts) {
      if (f.validTo) continue; // 失效的旧值不索引，免得搜出互相矛盾的两条
      const text = `${f.subject} ${f.predicate}：${f.object}`;
      items.push({
        id: `f:${f.subject}:${f.predicate}:${f.object}`,
        kind: 'fact',
        day: f.at ? new Date(Number(f.at)).toISOString().slice(0, 10) : '',
        key: '',
        who: '事实',
        text: text.slice(0, 500),
        at: Number(f.at) || Date.now(),
      });
    }
  } catch { /* 还没有事实层就跳过 */ }

  for (const row of readJsonl(STATE_FILES.diaryIndex)) {
    const text = `${row.title ?? ''}。${row.text ?? ''}`.trim();
    if (text.length < 4) continue;
    items.push({ id: `d:${row.t ?? row.day}`, kind: 'diary', day: String(row.day ?? ''), key: '', who: '日记', text: text.slice(0, 800), at: Number(row.t) || 0 });
  }

  // 4) 知识库
  for (const row of readJsonl(STATE_FILES.knowledgeIndex)) {
    const text = `${row.title ?? ''}。${row.text ?? ''}`.trim();
    if (text.length < 4) continue;
    items.push({ id: `k:${row.id ?? hashOf(text)}`, kind: 'knowledge', day: '', key: '', who: '知识', text: text.slice(0, 800), at: Number(row.createdAt) || 0 });
  }

  // 5) 梦
  readJsonl(STATE_FILES.dreams).forEach((row, i) => {
    const text = String(row.dream ?? '').trim();
    if (text.length < 4) return;
    items.push({ id: `z:${row.at ?? i}`, kind: 'dream', day: row.at ? new Date(row.at).toISOString().slice(0, 10) : '', key: '', who: '梦', text: text.slice(0, 800), at: Number(row.at) || 0 });
  });

  return items;
}

const started = Date.now();
const items = collect();
log(`收集到 ${items.length} 条（最近 ${days} 天）`);

const previous = rebuild ? { entries: [] } : loadIndex(outFile);
const reuse = new Map(previous.entries.map((e) => [e.id, e]));
const next = [];
const pending = [];
for (const item of items) {
  const hash = hashOf(`${item.text}|${item.who}`);
  const old = reuse.get(item.id);
  if (old && old.hash === hash && old.vec?.length === previous.dim) {
    next.push({ ...item, hash, vec: old.vec });
  } else {
    pending.push({ ...item, hash });
  }
}
log(`复用 ${next.length} 条，需要新算 ${pending.length} 条`);

if (pending.length) {
  const vectors = await embedTexts({
    texts: pending.map((p) => `${p.who}：${p.text}`),
    model,
    baseUrl,
    log,
  });
  if (vectors.length !== pending.length) {
    log('算向量失败：Ollama 没开、没装 bge-m3，或者模型不匹配。索引没有改动。');
    process.exitCode = 1;
  } else {
    pending.forEach((p, i) => next.push({ ...p, vec: vectors[i] }));
  }
}

if (!process.exitCode) {
  const dim = next.find((e) => e.vec?.length)?.vec.length ?? 0;
  const saved = saveIndex(outFile, { version: SEMANTIC_INDEX_VERSION, model, dim, generatedAt: Date.now(), entries: next });
  log(`索引已写入 ${outFile}`);
  log(`条目 ${saved.entries}，维度 ${dim}，文件 ${(saved.bytes / 1024 / 1024).toFixed(1)} MB，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const byKind = next.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc; }, {});
  log(`分布：${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
}
