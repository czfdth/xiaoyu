// 关系网络：把她记住的人、事、物连成一张网，而不是「他」为中心的一圈射线。
//
// 布局在服务端算（确定性的力导向），前端只画：这样刷新不会抖，也不用带 d3。
// 节点 = 实体/对象；边 = 一条事实（subject —predicate→ object）。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_FILES } from '../../src/paths.js';
import { loadStore, resolveEntity } from '../../src/knowledge-graph.js';

const W = 820;
const H = 620;

function ageDays(at, now) {
  const t = Number(at);
  if (!Number.isFinite(t)) return null;
  return Math.round(((now - t) / 86400000) * 10) / 10;
}

/**
 * 把事实铺成节点/边。
 * 人的名字（他/她/小鱼/栗子…）优先当人节点，其余对象也建节点（叶子节点多，网络才像网络）。
 */
export function buildNetwork(store, { now = Date.now() } = {}) {
  const facts = (store.facts ?? []).filter((f) => !f.validTo);
  const nodes = new Map();
  const edges = [];
  const touch = (label, type) => {
    const id = String(label ?? '').trim();
    if (!id) return null;
    if (!nodes.has(id)) nodes.set(id, { id, label: id, type, degree: 0, facts: 0 });
    return nodes.get(id);
  };

  // 实体登记：实体名 + 别名都指向同一个节点（别名显示在括号里）
  const aliasOf = new Map();
  for (const [name, info] of Object.entries(store.entities ?? {})) {
    touch(name, info.type ?? 'person');
    for (const alias of info.aliases ?? []) aliasOf.set(alias, name);
  }

  for (const f of facts) {
    const subject = resolveEntity(store, f.subject) || f.subject;
    const object = String(f.object ?? '').trim();
    if (!object) continue;
    const s = touch(subject, 'person');
    const o = touch(aliasOf.get(object) ?? object, guessType(object));
    // 谓词也做成节点（"要求""承诺""聊过"…）：这样点与点之间是两层连接、有共享枢纽，
    // 画出来才像知识网络，而不是从"他"放射出几十根射线。
    const hub = touch(`·${String(f.predicate ?? '')}`, 'predicate');
    if (!s || !o || !hub) continue;
    s.degree += 1;
    o.degree += 1;
    hub.degree += 1;
    s.facts += 1;
    o.facts += 1;
    hub.facts += 1;
    edges.push({
      source: s.id,
      target: hub.id,
      predicate: String(f.predicate ?? ''),
      confidence: Number(f.confidence) || 0,
      ageDays: ageDays(f.at, now),
      kind: 'subject',
    });
    edges.push({
      source: hub.id,
      target: o.id,
      predicate: String(f.predicate ?? ''),
      confidence: Number(f.confidence) || 0,
      ageDays: ageDays(f.at, now),
      kind: 'object',
    });
  }
  return { nodes: [...nodes.values()], edges };
}

function guessType(label) {
  const t = String(label ?? '');
  if (/群|QQ|号/.test(t)) return 'group';
  if (/画|图|书|日记/.test(t)) return 'thing';
  if (/^(他|她|小鱼|栗子|爸|妈|数分|inside)/.test(t)) return 'person';
  return 'thing';
}

/**
 * 力导向布局（Fruchterman-Reingold 的简化版）。确定性：初始位置按索引均匀铺开。
 * @param {Array} nodes
 * @param {Array} edges
 */
export function forceLayout(nodes, edges, { iterations = 300, width = W, height = H } = {}) {
  const list = nodes.map((n, i) => ({
    ...n,
    x: width / 2 + Math.cos((i / Math.max(1, nodes.length)) * Math.PI * 2) * (width / 3),
    y: height / 2 + Math.sin((i / Math.max(1, nodes.length)) * Math.PI * 2) * (height / 3),
    vx: 0,
    vy: 0,
  }));
  const byId = new Map(list.map((n) => [n.id, n]));
  const k = Math.sqrt((width * height) / Math.max(1, list.length)) * 0.55;
  let temp = width / 10;

  for (let step = 0; step < iterations; step += 1) {
    // 排斥（所有节点两两）
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        if (dist < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist = 0.02; }
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    // 吸引（边）
    for (const e of edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx; a.vy -= fy;
      b.vx += fx; b.vy += fy;
    }
    // 向心 + 限速
    for (const n of list) {
      n.vx += (width / 2 - n.x) * 0.012;
      n.vy += (height / 2 - n.y) * 0.012;
      const speed = Math.hypot(n.vx, n.vy) || 0.01;
      const capped = Math.min(speed, temp);
      n.x += (n.vx / speed) * capped;
      n.y += (n.vy / speed) * capped;
      n.x = Math.min(width - 40, Math.max(40, n.x));
      n.y = Math.min(height - 30, Math.max(30, n.y));
      n.vx = 0;
      n.vy = 0;
    }
    temp = Math.max(0.5, temp * 0.97);
  }

  return list.map((n) => ({
    id: n.id, label: n.label, type: n.type, degree: n.degree, facts: n.facts,
    x: Math.round(n.x), y: Math.round(n.y),
    r: Math.round(6 + Math.min(12, n.degree * 1.6)),
  }));
}

/** 面板用的总览。 */
export function kgView() {
  const store = loadStore(STATE_FILES.facts);
  const now = Date.now();
  const live = store.facts.filter((f) => !f.validTo);
  const stale = store.facts.filter((f) => f.validTo);
  const network = buildNetwork(store, { now });
  const positioned = forceLayout(network.nodes, network.edges);
  const byId = new Map(positioned.map((n) => [n.id, n]));
  const entities = Object.entries(store.entities).map(([name, info]) => ({
    name,
    type: info.type ?? 'person',
    aliases: info.aliases ?? [],
    facts: live.filter((f) => f.subject === name).length,
  }));
  return {
    generatedAt: now,
    entities,
    totals: {
      facts: live.length,
      stale: stale.length,
      entities: entities.length,
      nodes: positioned.length,
      edges: network.edges.length,
    },
    network: {
      width: W,
      height: H,
      nodes: positioned,
      edges: network.edges
        .filter((e) => byId.has(e.source) && byId.has(e.target))
        .map((e) => ({ ...e, x1: byId.get(e.source).x, y1: byId.get(e.source).y, x2: byId.get(e.target).x, y2: byId.get(e.target).y })),
    },
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
