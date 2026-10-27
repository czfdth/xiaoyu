// 面板用的「她此刻怎么样」视图：当前值 + 时间序列 + 当天活动。
//
// 数据都在 state/ 里（body.json / mood.json / inner.json / vitals.jsonl / journal/<day>.jsonl），
// 控制台只读不改：她自己的状态由她用工具写，这里不替她编。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_FILES } from '../../src/paths.js';
import { GAUGES, readVitals, bucketActivity } from '../../src/vitals.js';
import { shanghaiDay } from '../../src/autonomy.js';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ageOf(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return null; }
}

/**
 * @param {{hours?:number, day?:string}} [options]
 */
export function vitalsView({ hours = 24, day = '' } = {}) {
  const body = readJson(STATE_FILES.body, {});
  const mood = readJson(STATE_FILES.mood, {});
  const inner = readJson(STATE_FILES.inner, {});
  const now = Date.now();
  const ages = {
    body: ageOf(STATE_FILES.body),
    inner: ageOf(STATE_FILES.inner),
    mood: ageOf(STATE_FILES.mood),
  };
  const series = readVitals(STATE_FILES.vitals, { hours, now });
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : shanghaiDay();
  const messages = readJsonl(path.join(STATE_FILES.journalDir, `${today}.jsonl`));
  const { buckets, stats } = bucketActivity(messages, { now, hours: Math.max(1, Math.min(48, Number(hours) || 24)) });
  return {
    generatedAt: now,
    gauges: GAUGES,
    now: { body, mood, inner, ages },
    series,
    activity: buckets,
    stats: { ...stats, day: today },
  };
}
