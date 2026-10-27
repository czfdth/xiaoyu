// 关系图的数据准备：把 facts.json 变成"中心是她/他，四周是事实"的形状。
//
// 布局在服务端算好（固定角度），前端只画：这样没有物理引擎、没有依赖，也不会每次抖。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_FILES } from '../../src/paths.js';
import { loadStore, factsAbout } from '../../src/knowledge-graph.js';

function ageDays(at, now) {
  const t = Number(at);
  if (!Number.isFinite(t)) return null;
  return Math.round(((now - t) / 86400000) * 10) / 10;
}

/**
 * 把事实排成一圈：按谓词分组，每组占一段弧；同一组内按置信度从高到低。
 * @param {Array<{predicate:string, object:string, confidence:number, at:number}>} facts
 */
export function layoutFacts(facts = [], { radius = 150, now = Date.now() } = {}) {
  const groups = new Map();
  for (const f of facts) {
    const key = String(f.predicate ?? '其他');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const ordered = [...groups.entries()]
    .map(([predicate, rows]) => ({ predicate, rows: rows.sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0)) }))
    .sort((a, b) => b.rows.length - a.rows.length);
  const total = ordered.reduce((n, g) => n + g.rows.length, 0) || 1;
  const nodes = [];
  let index = 0;
  for (const group of ordered) {
    for (const row of group.rows) {
      const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
      nodes.push({
        predicate: group.predicate,
        object: String(row.object ?? ''),
        confidence: Number(row.confidence) || 0,
        ageDays: ageDays(row.at, now),
        source: String(row.source ?? ''),
        x: Math.round(Math.cos(angle) * radius),
        y: Math.round(Math.sin(angle) * radius),
        angle: Math.round((angle * 180) / Math.PI),
        index,
      });
      index += 1;
    }
  }
  return { nodes, groups: ordered.map((g) => ({ predicate: g.predicate, count: g.rows.length })), radius };
}

/** 面板用的总览。 */
export function kgView() {
  const store = loadStore(STATE_FILES.facts);
  const now = Date.now();
  const live = store.facts.filter((f) => !f.validTo);
  const stale = store.facts.filter((f) => f.validTo);
  const entities = Object.entries(store.entities).map(([name, info]) => ({
    name,
    type: info.type ?? 'person',
    aliases: info.aliases ?? [],
    facts: factsAbout({ store, name, limit: 200 }).length,
  }));
  const layout = layoutFacts(live, { now });
  return {
    generatedAt: now,
    entities,
    totals: { facts: live.length, stale: stale.length, entities: entities.length },
    layout,
    facts: live
      .map((f) => ({
        subject: f.subject,
        predicate: f.predicate,
        object: f.object,
        confidence: Number(f.confidence) || 0,
        at: Number(f.at) || 0,
        ageDays: ageDays(f.at, now),
        source: String(f.source ?? '').slice(0, 120),
      }))
      .sort((a, b) => a.predicate.localeCompare(b.predicate) || b.confidence - a.confidence),
    staleFacts: stale.slice(-10).map((f) => ({ predicate: f.predicate, object: f.object, validTo: f.validTo })),
  };
}
