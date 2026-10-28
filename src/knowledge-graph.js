// 事实层：把「关于他是谁、在忙什么、喜欢什么」从 33 条自然语句，变成可以按实体查的结构。
//
// 为什么不直接用向量库：向量擅长"找原话"，但回答不了"他生日几号""他上次说的那个同事叫什么"，
// 也分不清「他 / 爸 / 栗子」是不是同一个人。这里只做最小的一层：实体（含别名）+ 事实（带时间、来源、置信度）。
//
// 刻意不引入图数据库：她的实体几百个、事实几千条，一个 JSON 就够；
// 真正的瓶颈是抽取质量，所以每条事实都必须带 source（原话）和 confidence，宁可少、不可编。

import fs from 'node:fs';
import path from 'node:path';

export const FACT_LIMIT = 4000;

/** 空库结构。 */
export function emptyStore() {
  return { entities: {}, facts: [] };
}

export function loadStore(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return {
      entities: raw?.entities && typeof raw.entities === 'object' ? raw.entities : {},
      facts: Array.isArray(raw?.facts) ? raw.facts : [],
    };
  } catch {
    return emptyStore();
  }
}

export function saveStore(file, store) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const trimmed = { ...store, facts: (store.facts ?? []).slice(-FACT_LIMIT) };
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 登记一个实体（含别名）。别名指回同一个实体名。 */
export function upsertEntity(store, name, { type = 'person', aliases = [] } = {}) {
  const key = String(name ?? '').trim();
  if (!key) return store;
  const prev = store.entities[key] ?? { type, aliases: [] };
  const merged = new Set([...(prev.aliases ?? []), ...aliases.map((a) => String(a).trim()).filter(Boolean)]);
  store.entities[key] = { type: prev.type ?? type, aliases: [...merged] };
  return store;
}

/** 实体名或别名 → 规范名（查不到就原样返回）。 */
export function resolveEntity(store, name) {
  const raw = String(name ?? '').trim();
  if (!raw) return '';
  if (store.entities[raw]) return raw;
  for (const [canonical, info] of Object.entries(store.entities)) {
    if ((info.aliases ?? []).includes(raw)) return canonical;
  }
  return raw;
}

/**
 * 写入一条事实。一对一的谓词（关系/称呼/在忙）出现新值时旧值标 validTo（**不删**，保留历史）；
 * 多值谓词（喜欢/要求/承诺…）各自独立，不互相顶替。
 * @returns {{added:boolean, superseded:number}}
 */
// 天然多值的谓词：喜欢的东西不止一个、承诺不止一件。
// 一开始一律按"一个谓词一个值"处理，结果 60 条事实被顶到只剩 16 条（线上实测踩到）。
const MULTI_VALUED = new Set(['喜欢', '不喜欢', '要求', '承诺', '聊过', '给过', '想要', '怕', '习惯', '常要求', '常让', '会说']);

export function upsertFact(store, { subject, predicate, object, at = Date.now(), source = '', confidence = 0.6 } = {}) {
  const s = resolveEntity(store, subject);
  const p = String(predicate ?? '').trim();
  const o = String(object ?? '').trim();
  if (!s || !p || !o) return { added: false, superseded: 0 };
  const existing = store.facts.find((f) => f.subject === s && f.predicate === p && f.object === o && !f.validTo);
  if (existing) {
    existing.lastSeenAt = at;
    existing.confidence = Math.max(Number(existing.confidence) || 0, Number(confidence) || 0);
    return { added: false, superseded: 0 };
  }
  let superseded = 0;
  // 新事实的"身份"。旧事实被替代时记下它，才能把"以前是 A、后来变成 B"串成时间线。
  const ref = `${s}|${p}|${o}|${at}`;
  if (!MULTI_VALUED.has(p)) {
    for (const f of store.facts) {
      if (f.subject === s && f.predicate === p && !f.validTo) {
        f.validTo = at;
        f.supersededBy = ref;
        superseded += 1;
      }
    }
  }
  store.facts.push({
    subject: s, predicate: p, object: o,
    at, lastSeenAt: at, source: String(source ?? '').slice(0, 200),
    confidence: Math.min(1, Math.max(0, Number(confidence) || 0.6)),
    // validFrom：这件事从什么时候开始为真。老数据没这个字段，读的时候当 undefined 处理。
    validFrom: at,
    ref,
  });
  return { added: true, superseded };
}

/**
 * 查某个实体的事实（默认只要仍然有效的，按时间倒序）。
 * @param {{store:object, name:string, since?:number, limit?:number, includeStale?:boolean}} options
 */
export function factsAbout({ store, name, since = 0, limit = 5, includeStale = false }) {
  const canonical = resolveEntity(store, name);
  const rows = (store.facts ?? []).filter((f) => {
    if (f.subject !== canonical) return false;
    if (!includeStale && f.validTo) return false;
    if (since && Number(f.at) < since) return false;
    return true;
  });
  rows.sort((a, b) => Number(b.at) - Number(a.at));
  return rows.slice(0, Math.max(1, Number(limit) || 5));
}

/** 提示词里的那一小段（没事实就返回空串，绝不硬凑）。 */
export function factsHint(rows, { max = 4 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, max);
  if (!list.length) return '';
  const lines = list.map((f) => `- ${f.predicate}：${f.object}${f.source ? `（原话：${String(f.source).slice(0, 40)}）` : ''}`);
  return `【关于他】你记得的这些（不是他刚说的，别当成新消息）：\n${lines.join('\n')}\n\n`;
}

/**
 * 从已有的长时记忆语句里抽事实（启发式，不调用模型）。
 * 只处理"他/我"开头的句子——这类句子里主语最明确；抽不出来就跳过，不硬编。
 */
export function factsFromSentences(items = [], { at = Date.now() } = {}) {
  const out = [];
  const rules = [
    { re: /^(?:他|我爸|爸)(?:叫|名字是)\s*([^\s，。；]+)/, predicate: '叫', as: 'object' },
    { re: /^(?:他|我爸|爸)(?:是|做|干)\s*([^\s，。；]+)/, predicate: '是', as: 'object' },
    { re: /^(?:他|我爸|爸)(?:喜欢|爱|爱吃|爱吃)\s*([^\s，。；]+)/, predicate: '喜欢', as: 'object' },
    { re: /^(?:他|我爸|爸)(?:在|正在)(?:准备|忙|做|学)\s*([^\s，。；]+)/, predicate: '在忙', as: 'object' },
    { re: /^(?:他|我爸|爸)的?(生日|年纪|工作|学校|专业)(?:是|在)?\s*([^\s，。；]+)/, predicate: '资料', as: 'object' },
  ];
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item?.text ?? '').trim();
    if (!text) continue;
    // 「他叫我小鱼」说的是她的名字，不是关于他的事实，跳过（实测这条会被误解成『他=我小鱼』）
    if (/^(?:他|爸|我爸)(?:叫|喊)我/.test(text)) continue;
    for (const rule of rules) {
      const hit = text.match(rule.re);
      if (!hit) continue;
      const object = (hit[2] ?? hit[1] ?? '').trim();
      if (!object || object.length > 30) break;
      out.push({
        subject: '他',
        predicate: rule.predicate === '资料' ? String(hit[1]) : rule.predicate,
        object,
        at: Number(item?.lastSeenAt) || Number(item?.createdAt) || at,
        source: text.slice(0, 200),
        confidence: 0.55,
      });
      break;
    }
  }
  return out;
}
