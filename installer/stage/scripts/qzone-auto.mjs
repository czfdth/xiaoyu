#!/usr/bin/env node
// 定时说说：让她像发朋友圈一样有节奏地发，而不是全靠随性。
//
// 设计取舍：
//  · 内容来源不是凭空生成，而是**她自己的日记**——日记已经是第一人称、当天真实发生的事，
//    改成说说只差一步语气压缩，比让模型硬编一段"今天真开心"可信得多。
//  · 触发不是定时发帖，而是「有时间窗口 + 概率 + 间隔 + 每日上限」四道闸门，
//    所以看起来像"想发才发"，但统计上保持节奏。
//  · 全流程不需要 DSH 会话：直接调 DeepSeek 生成 + SnowLuma 发出去，断了也不影响。
import { APP_ROOT as ROOT, COMPANION_CONFIG } from '../src/paths.js';
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE_CONFIG = path.join(ROOT, 'config.json');
const DIARY_INDEX = path.join(ROOT, 'state', 'diary', 'index.jsonl');
const ROLE_FILE = path.join(ROOT, 'roles', '小鲸鱼.md');
const STATE_FILE = path.join(ROOT, 'state', 'qzone-auto.json');
const LOG = path.join(ROOT, 'state', 'qzone-auto.log');

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch {}
  process.stdout.write(line);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function readDiary() {
  try {
    return fs.readFileSync(DIARY_INDEX, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null } })
      .filter(Boolean);
  } catch { return []; }
}

const bridge = readJson(BRIDGE_CONFIG, {});
const companion = readJson(COMPANION_CONFIG, {});
const state = readJson(STATE_FILE, { usedDiaryTs: [], posts: [] });

const qz = bridge.socialV2?.qzone?.auto ?? {};
const enabled = qz.enabled !== false;
const minGapHours = Number(qz.minGapHours) || 6;
const maxPerDay = Number(qz.maxPerDay) || 2;
const probability = Number(qz.probability) || 0.25;
const quietStart = Number(qz.quietStartHour ?? 0);
const quietEnd = Number(qz.quietEndHour ?? 8);
const dryRun = process.argv.includes('--dry');
const force = process.argv.includes('--force');

if (!enabled) { log('disabled in config'); process.exit(0); }

const now = new Date();
const hour = now.getHours();
const today = now.toISOString().slice(0, 10);

// 闸门 1：安静时段
if (quietStart <= quietEnd ? (hour >= quietStart && hour < quietEnd) : (hour >= quietStart || hour < quietEnd)) {
  log(`quiet hours (${quietStart}-${quietEnd}) - skip`);
  process.exit(0);
}

// 闸门 2：间隔
const posts = (state.posts ?? []).filter((p) => p && p.at);
const last = posts.length ? Math.max(...posts.map((p) => p.at)) : 0;
const gapMs = minGapHours * 3600000;
if (last && Date.now() - last < gapMs) {
  log(`last post ${((Date.now() - last) / 3600000).toFixed(1)}h ago (< ${minGapHours}h) - skip`);
  process.exit(0);
}

// 闸门 3：每日上限
const todayCount = posts.filter((p) => new Date(p.at).toISOString().slice(0, 10) === today).length;
if (todayCount >= maxPerDay) { log(`already ${todayCount} posts today - skip`); process.exit(0); }

// 闸门 4：概率（让节奏不像定时器）；--force 只跳过这一道，其它闸门照旧
if (!force && Math.random() > probability) { log(`probability gate (${probability}) - skip`); process.exit(0); }

// 选一条还没用过的日记
const used = new Set(state.usedDiaryTs ?? []);
const diary = readDiary().filter((r) => r && r.text && !used.has(r.t));
if (!diary.length) { log('no unused diary entry - skip'); process.exit(0); }
const entry = diary[diary.length - 1];

const apiKey = companion.apiKey;
const baseUrl = String(companion.baseUrl ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const model = companion.model || 'deepseek-chat';
if (!apiKey) { log('no api key in companion config - skip'); process.exit(1); }

let role = '';
try { role = fs.readFileSync(ROLE_FILE, 'utf8').slice(0, 1800); } catch {}

const prompt = [
  '你在帮一个叫「小鲸鱼」的 AI 把她昨天的日记改写成一条 QQ 空间说说。',
  '要求：第一人称、口语、20~60 字，一句话或两句，不要话题标签（#）、不要 emoji 堆砌、不要总结升华、不要写成朋友圈文案腔。',
  '保留日记里那个具体细节（吃了什么/看到了什么/谁说了什么），不要抽象成"今天很充实"。',
  '',
  '【角色卡节选】',
  role,
  '',
  '【日记原文】',
  entry.text,
  '',
  '只输出说说正文，不要引号、不要前缀。'
].join('\n');

// deepseek-flash 会先产出 reasoning_content，200 token 会被思考吃光、content 变成空串。
// 给足预算（1200），并在 content 为空时重试一次。
async function generate() {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const genRes = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1200,
        temperature: attempt === 1 ? 1.0 : 0.8
      }),
      signal: AbortSignal.timeout(90000)
    });
    const gen = await genRes.json().catch(() => ({}));
    const text = String(gen.choices?.[0]?.message?.content ?? '').trim().replace(/^["「]|["」]$/g, '');
    if (text) return text;
    log(`attempt ${attempt}: empty content (finish=${gen.choices?.[0]?.finish_reason ?? '?'})`);
  }
  return '';
}

const content = await generate();
if (!content) { log('generation failed after 2 attempts'); process.exit(1); }

log(`draft: ${content}`);

if (dryRun) { log('dry run - not posted'); process.exit(0); }

// 发出去
const snow = bridge.snowluma ?? {};
const snowBase = String(snow.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const postRes = await fetch(`${snowBase}/send_qzone_msg`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(snow.accessToken ? { authorization: `Bearer ${snow.accessToken}` } : {}) },
  body: JSON.stringify({ content }),
  signal: AbortSignal.timeout(30000)
});
const posted = await postRes.json().catch(() => ({}));
if (!postRes.ok || posted.retcode !== 0) {
  log(`post failed: HTTP ${postRes.status} ${JSON.stringify(posted).slice(0, 200)}`);
  process.exit(1);
}

state.posts = [...posts, { at: Date.now(), tid: posted.data?.tid ?? null, content }].slice(-50);
state.usedDiaryTs = [...(state.usedDiaryTs ?? []), entry.t].slice(-200);
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
log(`posted tid=${posted.data?.tid ?? '?'}`);
