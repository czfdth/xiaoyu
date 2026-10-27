#!/usr/bin/env node
// 把长时记忆里的句子，用模型转成结构化事实（实体/关系/时间）。
//
// 为什么单独一个脚本：正则抽 33 条只出 1 条（见 knowledge-graph 的实测），
// 但这活只需要"给一批句子，输出 JSON"，跟 extract-memory 的整段归纳是两件事，分开更好测。
//
// 用法：node scripts/extract-facts.mjs            # 处理全部未处理过的
//       node scripts/extract-facts.mjs --dry      # 只打印，不落盘

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, STATE_DIR, STATE_FILES, COMPANION_CONFIG } from '../src/paths.js';
import { readJson } from '../src/state-store.js';
import { loadStore, saveStore, upsertEntity, upsertFact } from '../src/knowledge-graph.js';

const dry = process.argv.includes('--dry');
const logFile = path.join(STATE_DIR, 'facts-extract.log');
const log = (m) => {
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch { /* 无所谓 */ }
  console.log(m);
};

const PROMPT = (lines) => `下面是关于"他"（我的主人/家人）的零散记忆句子。请把它们转成结构化事实。

只输出 JSON，不要解释。格式：
{"entities":[{"name":"他","type":"person","aliases":["爸","栗子"]}],
 "facts":[{"subject":"他","predicate":"在忙","object":"准备考研","quote":"原句片段","confidence":0.8}]}

规则：
- predicate 用简短动词或名词（叫、喜欢、在忙、生日、工作、关系、习惯、怕…）。
- object 要短（不超过 20 字），是能独立看懂的值。
- quote 必须是输入句子里的原文片段，不要改写。
- confidence 0~1：句子明确说"是/叫/喜欢"给 0.8 以上；只是"常要求/有时候"给 0.5 左右。
- 拿不准的宁可不抽。不要编造句子里没有的信息。

句子：
${lines.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;

async function complete(prompt) {
  const companion = readJson(COMPANION_CONFIG, {});
  if (!companion.apiKey) throw new Error('没有模型 API key');
  const base = String(companion.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${companion.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: companion.model || 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`模型 HTTP ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/** 从模型输出里取 JSON（容忍 ```json 包裹和前后杂字）。 */
function parseJson(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('输出里没有 JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

async function main() {
  const cfg = readJson(CONFIG_FILE, {});
  if (!cfg.ownerQQ) throw new Error('尚未设置用户身份');
  const items = readJson(STATE_FILES.longTermMemory, {})?.items ?? [];
  if (!items.length) {
    log('长时记忆是空的，先跑 extract-memory');
    return;
  }
  const store = loadStore(STATE_FILES.facts);
  const known = new Set(store.facts.map((f) => `${f.subject}|${f.predicate}|${f.object}`));
  // 只把"还没变成事实"的句子送进去，省 token
  const lines = items.map((it) => String(it.text ?? '').trim()).filter(Boolean)
    .filter((t) => !store.facts.some((f) => String(f.source ?? '').includes(t.slice(0, 20))));
  if (!lines.length) {
    log(`没有新句子要处理（已有 ${store.facts.length} 条事实）`);
    return;
  }
  log(`送给模型 ${lines.length} 句（已有 ${store.facts.length} 条事实）`);
  const text = await complete(PROMPT(lines.slice(0, 40)));
  const parsed = parseJson(text);
  let added = 0;
  let superseded = 0;
  for (const e of parsed.entities ?? []) {
    if (e?.name) upsertEntity(store, e.name, { type: e.type || 'person', aliases: e.aliases ?? [] });
  }
  for (const f of parsed.facts ?? []) {
    const r = upsertFact(store, {
      subject: f?.subject || '他',
      predicate: f?.predicate,
      object: f?.object,
      source: f?.quote,
      confidence: Number(f?.confidence) || 0.6,
    });
    if (r.added) added += 1;
    superseded += r.superseded;
  }
  if (!dry) saveStore(STATE_FILES.facts, store);
  log(`${dry ? '[演练] ' : ''}新增 ${added} 条事实（顶替 ${superseded}），库里共 ${store.facts.length} 条`);
}

main().catch((error) => {
  log(`FAILED: ${error.message}`);
  process.exitCode = 1;
});
