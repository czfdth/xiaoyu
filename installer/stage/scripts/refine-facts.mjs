// 让事实更像"知识网络"：谓词收敛到一小组，object 区分「人/群/事」。
// 用法：node scripts/refine-facts.mjs   （会先备份 facts.json）
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILES, COMPANION_CONFIG } from '../src/paths.js';
import { readJson } from '../src/state-store.js';
import { emptyStore, loadStore, saveStore, upsertEntity, upsertFact } from '../src/knowledge-graph.js';

const PREDICATES = ['关系', '称呼', '喜欢', '不喜欢', '要求', '习惯', '在忙', '怕', '想要', '承诺', '给过', '聊过'];
const log = (m) => { try { fs.appendFileSync(path.join(STATE_DIR, 'facts-refine.log'), `${new Date().toISOString()} ${m}\n`); } catch {} console.log(m); };

const PROMPT = (lines) => `把下面关于"他"的记忆句子，转成知识网络中的三元组。

只输出 JSON：
{"facts":[{"subject":"他","predicate":"喜欢","object":"吃鱼","objectType":"thing","quote":"原句片段","confidence":0.8}]}

硬性要求：
- predicate 必须从这 ${PREDICATES.length} 个里选一个：${PREDICATES.join('、')}。不要自造。
- objectType 三选一：person（人）、group（群/账号）、thing（其它）。
- object 要短（不超过 12 字），是能独立看懂的名词或短语；如果原句说的是某个人，就用那个人的名字。
- quote 必须是输入句子的原文片段。
- 一句话如果包含多个事实，拆成多条。
- 拿不准就不抽，绝不编造。

句子：
${lines.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;

async function complete(prompt) {
  const companion = readJson(COMPANION_CONFIG, {});
  if (!companion.apiKey) throw new Error('没有模型 API key');
  const base = String(companion.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
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
  if (!res.ok) throw new Error(`模型 HTTP ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content ?? '';
}

function parseJson(text) {
  const raw = String(text ?? '').trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('没有 JSON');
  return JSON.parse(raw.slice(s, e + 1));
}

const items = readJson(STATE_FILES.longTermMemory, {})?.items ?? [];
if (!items.length) { log('长时记忆是空的'); process.exit(1); }
const lines = items.map((i) => String(i.text ?? '').trim()).filter(Boolean).slice(0, 40);
const text = await complete(PROMPT(lines));
const parsed = parseJson(text);

// 备份旧库，重建（保留实体与别名）
const backup = `${STATE_FILES.facts}.bak-${Date.now()}`;
try { fs.copyFileSync(STATE_FILES.facts, backup); log(`已备份旧库: ${path.basename(backup)}`); } catch {}
const old = loadStore(STATE_FILES.facts);
const store = emptyStore();
for (const [name, info] of Object.entries(old.entities)) upsertEntity(store, name, { type: info.type, aliases: info.aliases });

let added = 0;
for (const f of parsed.facts ?? []) {
  if (!PREDICATES.includes(String(f.predicate))) continue;
  const r = upsertFact(store, {
    subject: f.subject || '他',
    predicate: f.predicate,
    object: f.object,
    source: f.quote,
    confidence: Number(f.confidence) || 0.6,
  });
  if (r.added) added += 1;
}
saveStore(STATE_FILES.facts, store);
log(`${added} 条事实入库；谓词分布：${JSON.stringify(store.facts.reduce((m, f) => (m[f.predicate] = (m[f.predicate] || 0) + 1, m), {}))}`);
