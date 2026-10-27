// Token 花费视图：把 state/token-usage.jsonl 折成「按天 / 按会话」两块给控制台。
//
// 为什么单独一个模块：桥接只负责记账（一行一步），控制台只负责读；把折算逻辑放在
// 服务端而不是前端，是因为价目表（峰谷/节假日/模型）在 src/model-prices.js 里，
// 前端不该重复实现一遍计价。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, readConfig } from '../../src/paths.js';
import { resolvePriceTable, priceUsage, normalizeUsage, ZERO_BUCKETS, addBuckets } from '../../src/model-prices.js';

const FILE = path.join(STATE_DIR, 'token-usage.jsonl');

function readRows(maxLines = 40000) {
  try {
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 最近花费概览。
 * @param {{days?: number, sessions?: number}} [options]
 */
export function tokenOverview({ days = 7, sessions = 12 } = {}) {
  const cfg = readConfig();
  const table = resolvePriceTable(cfg.pricing);
  const rows = readRows();
  const byDay = new Map();
  const bySession = new Map();
  const modelOf = new Map();
  let firstAt = 0;
  let lastAt = 0;
  let steps = 0;
  let coldStarts = 0;
  let coldMiss = 0;

  for (const line of rows) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    // 「base」是会话累计基线快照，混进来会把同一步重复计一次。
    if (e.k !== 'turn' || !e.b) continue;
    const at = Number(e.t) || 0;
    if (!at) continue;
    const buckets = normalizeUsage(e.b);
    const total = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite + buckets.output;
    if (!total) continue;
    steps += 1;
    if (!firstAt || at < firstAt) firstAt = at;
    if (at > lastAt) lastAt = at;

    // 冷启动：回合第一步就带着一大截「未命中」。这类步骤几乎都是缓存过期（空闲超过缓存 TTL）
    // 之后的第一步 —— 整段旧上下文按未命中价重读，单价是命中的几十倍，是花费的真正主因。
    if (Number(e.step) === 1 && buckets.cacheMiss >= 5000) {
      coldStarts += 1;
      coldMiss += buckets.cacheMiss;
    }

    const day = dayKey(at);
    const dayEntry = byDay.get(day) ?? { day, steps: 0, buckets: { ...ZERO_BUCKETS }, models: new Set() };
    dayEntry.steps += 1;
    dayEntry.buckets = addBuckets(dayEntry.buckets, buckets);
    if (e.model) dayEntry.models.add(String(e.model));
    byDay.set(day, dayEntry);

    const key = String(e.key || '（未归属）');
    const s = bySession.get(key) ?? {
      key,
      sessions: new Set(),
      turns: new Set(),
      steps: 0,
      buckets: { ...ZERO_BUCKETS },
      lastPrompt: 0,
      lastAt: 0,
    };
    if (e.sid) s.sessions.add(String(e.sid));
    if (e.sid && Number.isFinite(Number(e.turn))) s.turns.add(`${e.sid}#${e.turn}`);
    s.steps += 1;
    s.buckets = addBuckets(s.buckets, buckets);
    const prompt = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
    if (at >= s.lastAt) {
      s.lastAt = at;
      s.lastPrompt = prompt;
    }
    bySession.set(key, s);
    if (e.model) modelOf.set(String(e.model), (modelOf.get(String(e.model)) || 0) + 1);
  }

  const dominantModel = [...modelOf.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || cfg.dsh?.model || 'deepseek-flash';

  const dayRows = [...byDay.values()]
    .map((entry) => {
      // 用当天中午计价：峰谷档位按天看会抖，中午能代表这一天的常态价。
      const at = Date.parse(`${entry.day}T12:00:00+08:00`);
      const cost = priceUsage(entry.buckets, { model: dominantModel, at, table }).cost.total;
      const input = entry.buckets.cacheMiss + entry.buckets.cacheHit + entry.buckets.cacheWrite;
      return {
        day: entry.day,
        steps: entry.steps,
        prompt: input,
        cacheHit: entry.buckets.cacheHit,
        cacheMiss: entry.buckets.cacheMiss,
        output: entry.buckets.output,
        hitRate: input > 0 ? entry.buckets.cacheHit / input : 0,
        cost,
        models: [...entry.models],
      };
    })
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-Math.max(1, days));

  const totals = dayRows.reduce((acc, d) => ({
    steps: acc.steps + d.steps,
    prompt: acc.prompt + d.prompt,
    cacheHit: acc.cacheHit + d.cacheHit,
    cacheMiss: acc.cacheMiss + d.cacheMiss,
    output: acc.output + d.output,
    cost: acc.cost + d.cost,
  }), { steps: 0, prompt: 0, cacheHit: 0, cacheMiss: 0, output: 0, cost: 0 });

  const sessionRows = [...bySession.values()]
    .map((s) => ({
      key: s.key,
      sessions: s.sessions.size,
      turns: s.turns.size,
      steps: s.steps,
      prompt: s.buckets.cacheMiss + s.buckets.cacheHit + s.buckets.cacheWrite,
      lastPrompt: s.lastPrompt,
      lastAt: s.lastAt,
      cost: priceUsage(s.buckets, { model: dominantModel, at: s.lastAt || Date.now(), table }).cost.total,
    }))
    .sort((a, b) => b.prompt - a.prompt)
    .slice(0, Math.max(1, sessions));

  const context = cfg.socialV2?.context ?? {};
  return {
    generatedAt: Date.now(),
    model: dominantModel,
    firstAt,
    lastAt,
    totals: {
      ...totals,
      hitRate: totals.prompt > 0 ? totals.cacheHit / totals.prompt : 0,
      avgPromptPerStep: totals.steps > 0 ? Math.round(totals.prompt / totals.steps) : 0,
      coldStarts,
      coldMiss,
      // 冷启动吃掉了多少「未命中」：这个比例高，说明该压上下文了，而不是该少说话。
      coldShare: totals.cacheMiss > 0 ? coldMiss / totals.cacheMiss : 0,
    },
    days: dayRows,
    sessions: sessionRows,
    budget: {
      maxStepsPerTurn: Number(context.maxStepsPerTurn ?? 30),
      rotatePromptTokens: Number(context.rotatePromptTokens ?? 80000),
      rotateMinTurns: Number(context.rotateMinTurns ?? 5),
    },
  };
}
