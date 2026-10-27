// 生命体征：把她每次改写的身体/心情落成一条时间序列，面板才能画趋势。
//
// 之前面板只能显示"当前值"——body.json 里只有最后一次，画不出曲线，也看不出
// "她是越来越困还是缓过来了"。这里只做两件纯函数 + 一个很薄的落盘：
//   · recordVital：值变了就追加一行（不变不写，避免日志噪声）
//   · readVitals：按时间窗读回来并等距抽样（画图不需要几千个点）
//   · bucketActivity：把当天聊天按小时分桶（她说 vs 对方说），给柱状图用

import fs from 'node:fs';
import path from 'node:path';

export const VITALS_MAX_BYTES = 512 * 1024;
export const GAUGES = ['sleepy', 'tired', 'hungry', 'cold'];

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 把当前 body/mood 归一成一条记录（缺字段给 0，别让图断掉）。 */
export function vitalOf(body = {}, mood = {}, at = Date.now()) {
  return {
    t: Number(at) || Date.now(),
    sleepy: num(body.sleepy),
    tired: num(body.tired),
    hungry: num(body.hungry),
    cold: num(body.cold),
    mood: String(mood?.mood ?? body?.mood ?? '').slice(0, 20),
    note: String(body?.note ?? '').slice(0, 80),
  };
}

/** 和上一条相比有没有实质变化（阈值内不算，避免每 60 秒写一行）。 */
export function changedEnough(prev, next, epsilon = 0.02) {
  if (!prev) return true;
  if (String(prev.mood ?? '') !== String(next.mood ?? '')) return true;
  for (const key of GAUGES) {
    if (Math.abs(Number(prev[key] ?? 0) - Number(next[key] ?? 0)) > epsilon) return true;
  }
  return false;
}

/**
 * 追加一条；值没变就什么都不写。
 * @returns {{written:boolean, line?:object}}
 */
export function recordVital(file, body, mood, { at = Date.now(), epsilon = 0.02 } = {}) {
  const next = vitalOf(body, mood, at);
  let prev = null;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length) {
      try { prev = JSON.parse(lines[lines.length - 1]); } catch { prev = null; }
    }
  } catch { /* 文件还不存在 */ }
  if (prev && !changedEnough(prev, next, epsilon)) return { written: false, line: prev };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(next)}\n`, 'utf8');
    // 体积上限：超过就只留最后 1500 行，重写一次（不无限长）
    const st = fs.statSync(file);
    if (st.size > VITALS_MAX_BYTES) {
      const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, `${all.slice(-1500).join('\n')}\n`, 'utf8');
    }
  } catch { return { written: false, line: next }; }
  return { written: true, line: next };
}

/**
 * 读时间窗内的序列，等距抽样到 maxPoints（保留首尾）。
 * 坏行跳过；文件不存在返回空数组。
 */
export function readVitals(file, { hours = 24, maxPoints = 120, now = Date.now() } = {}) {
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((r) => r && Number.isFinite(Number(r.t)));
  } catch { return []; }
  const cutoff = now - Math.max(1, Number(hours) || 24) * 3600 * 1000;
  rows = rows.filter((r) => Number(r.t) >= cutoff).sort((a, b) => a.t - b.t);
  if (rows.length <= maxPoints) {
    return rows.map((r) => ({
      t: Number(r.t), sleepy: num(r.sleepy), tired: num(r.tired),
      hungry: num(r.hungry), cold: num(r.cold), mood: String(r.mood ?? ''),
    }));
  }
  const out = [];
  const step = (rows.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i += 1) {
    const r = rows[Math.round(i * step)];
    out.push({
      t: Number(r.t), sleepy: num(r.sleepy), tired: num(r.tired),
      hungry: num(r.hungry), cold: num(r.cold), mood: String(r.mood ?? ''),
    });
  }
  return out;
}

/**
 * 当天聊天按小时分桶（她说 / 对方说），给柱状图用。
 * @param {Array<{t:number, role?:string}>} messages
 */
export function bucketActivity(messages, { now = Date.now(), hours = 24 } = {}) {
  const span = Math.max(1, Number(hours) || 24);
  const hourMs = 3600 * 1000;
  const endHour = Math.floor(now / hourMs) * hourMs;
  const startHour = endHour - (span - 1) * hourMs;
  const buckets = [];
  // 小时标签固定按北京时间（+08，无夏令时），不能用 getHours()：
  // 那会跟着运行机器的时区变，CI 是 UTC，柱状图就会整体错位（本地过、CI 挂过一次）。
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false });
  for (let i = 0; i < span; i += 1) {
    const at = startHour + i * hourMs;
    buckets.push({ at, hour: `${hourFmt.format(new Date(at))}:00`, her: 0, other: 0 });
  }
  let herCount = 0;
  let otherCount = 0;
  let firstAt = 0;
  let lastAt = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    const t = Number(m?.t);
    if (!Number.isFinite(t)) continue;
    if (!firstAt || t < firstAt) firstAt = t;
    if (t > lastAt) lastAt = t;
    if (t < startHour) continue;
    const idx = Math.min(span - 1, Math.floor((t - startHour) / hourMs));
    if (m.role === 'her') { buckets[idx].her += 1; herCount += 1; } else { buckets[idx].other += 1; otherCount += 1; }
  }
  // 最长沉默：相邻两条（同一天、时间窗内）之间最大间隔
  let longestQuietMs = 0;
  const times = (Array.isArray(messages) ? messages : [])
    .map((m) => Number(m?.t)).filter((t) => Number.isFinite(t) && t >= startHour).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i += 1) longestQuietMs = Math.max(longestQuietMs, times[i] - times[i - 1]);
  return {
    buckets,
    stats: {
      her: herCount,
      other: otherCount,
      total: herCount + otherCount,
      firstAt,
      lastAt,
      longestQuietMin: Math.round(longestQuietMs / 60000),
    },
  };
}
