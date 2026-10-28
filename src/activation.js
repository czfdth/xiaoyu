// 激活扩散：她提起一件事时，相关的事会短暂算得"更热"，过一阵自己凉下去。
//
// 这是"像神经网络"最直接的一层——不是把记忆画成图就完事，
// 而是**调用顺序会影响下次想起什么**。
//
// 规则（刻意简单，可解释）：
//   · 被检索命中：            activation += 0.3
//   · 同主语/同内容的邻居：     activation += 0.1（一次扩散，不再递归）
//   · 每小时衰减：            activation *= 0.98
//   · 上限 1.0，低于 0.02 视为 0（不占文件空间）
//
// 存储：state/memory/activation.json —— 纯派生数据，删掉只是"忘了最近常想什么"，不影响事实本身。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';

const FILE = path.join(STATE_DIR, 'memory', 'activation.json');
const DECAY_PER_HOUR = 0.98;
const HIT_BOOST = 0.3;
const NEIGHBOR_BOOST = 0.1;
const FLOOR = 0.02;

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
    const store = JSON.parse(raw);
    return {
      items: store?.items && typeof store.items === 'object' ? store.items : {},
      updatedAt: Number(store?.updatedAt) || 0,
    };
  } catch {
    return { items: {}, updatedAt: 0 };
  }
}

function save(store) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  } catch { /* 写不进去也不该影响对话 */ }
}

/** 按经过的小时数整体衰减。 */
function decay(items, hours) {
  if (hours <= 0) return items;
  const factor = Math.pow(DECAY_PER_HOUR, hours);
  const out = {};
  for (const [key, value] of Object.entries(items)) {
    const next = Number(value) * factor;
    if (next >= FLOOR) out[key] = Math.round(next * 1000) / 1000;
  }
  return out;
}

function factKey(f) {
  if (f?.ref) return String(f.ref);
  return [f?.subject ?? '', f?.predicate ?? '', f?.object ?? '', Number(f?.at) || 0].join('|');
}

/**
 * 给一批事实升温，并把热度扩散给"同主语"或"同内容"的邻居。
 * @param {object[]} facts 命中的事实（来自 factsAbout 等）
 * @param {{now?: number, neighbors?: object[]}} [opts]
 * @returns {{bumped:number, spread:number}}
 */
export function activate(facts, { now = Date.now(), neighbors = [] } = {}) {
  try {
    if (!Array.isArray(facts) || !facts.length) return { bumped: 0, spread: 0 };
    const store = load();
    const hours = store.updatedAt ? Math.max(0, (now - store.updatedAt) / 3600000) : 0;
    const items = decay(store.items, hours);

    let bumped = 0;
    for (const f of facts) {
      const key = factKey(f);
      if (!key.trim() || key === '||0') continue;
      items[key] = Math.min(1, (Number(items[key]) || 0) + HIT_BOOST);
      bumped += 1;
    }

    // 一次性扩散：同主语的兄弟事实也热一点，但不递归（否则整张图会一起亮起来）
    let spread = 0;
    const subjects = new Set(facts.map((f) => String(f?.subject ?? '')).filter(Boolean));
    for (const n of neighbors) {
      if (!subjects.has(String(n?.subject ?? ''))) continue;
      const key = factKey(n);
      if (!key.trim() || key === '||0') continue;
      items[key] = Math.min(1, (Number(items[key]) || 0) + NEIGHBOR_BOOST);
      spread += 1;
    }

    save({ items, updatedAt: now });
    return { bumped, spread };
  } catch {
    return { bumped: 0, spread: 0 };
  }
}

/**
 * 给候选排序：激活度越高越靠前；没有激活记录的按 0 处理。
 * 返回新数组，不改原对象（除非传 mutate）。
 * @param {object[]} candidates
 * @param {{now?: number}} [opts]
 */
export function rank(candidates, { now = Date.now() } = {}) {
  try {
    if (!Array.isArray(candidates) || !candidates.length) return [];
    const store = load();
    const hours = store.updatedAt ? Math.max(0, (now - store.updatedAt) / 3600000) : 0;
    const items = decay(store.items, hours);
    return candidates
      .map((c) => ({ item: c, heat: Number(items[factKey(c)]) || 0 }))
      .sort((a, b) => b.heat - a.heat)
      .map((x) => x.item);
  } catch {
    return candidates;
  }
}

/** 当前最热的前几条（给面板/调试看）。 */
export function hottest({ limit = 10 } = {}) {
  try {
    const store = load();
    const hours = store.updatedAt ? Math.max(0, (Date.now() - store.updatedAt) / 3600000) : 0;
    const items = decay(store.items, hours);
    return Object.entries(items)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, Number(limit) || 10))
      .map(([key, value]) => ({ key, heat: value }));
  } catch {
    return [];
  }
}
