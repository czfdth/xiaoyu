// 主动搭话的外部驱动器：由计划任务每 10 分钟调用一次。
//
// 为什么不放在桥接里：桥接每次重启都会丢掉 setTimeout，今晚重启十几次，
// 主动检查一次都没跑到。放在外部就没有这个问题——只要机器开着，它就一直在。
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, ''));
const OWNER = Number(cfg.ownerQQ) || 0;

const KEY = `private:${OWNER}`;
const LOG = ROOT + '/state/proactive-nudge.log';

const MIN_IDLE_MS = 4 * 60 * 1000;      // 至少安静 4 分钟
const MIN_SINCE_HER_MS = 6 * 60 * 1000; // 她上次说话至少 6 分钟前
const QUIET_HOURS = [1, 2, 3, 4, 5, 6, 7]; // 深夜不打扰
const PROBABILITY = 0.65;

const tok = fs.readFileSync(ROOT + '/state/console-token', 'utf8').trim();
const H = { 'x-console-token': tok, 'content-type': 'application/json' };

// 成本/频率闸门（config.limits）：每日主动次数 + 每日 token 上限
const limits = cfg.limits || {};
const today = new Date().toISOString().slice(0, 10);
const counterFile = ROOT + '/state/proactive-count.json';
let counter = { day: today, count: 0 };
try { counter = JSON.parse(fs.readFileSync(counterFile, 'utf8')); } catch { /* 第一次 */ }
if (counter.day !== today) counter = { day: today, count: 0 };
if (limits.proactivePerDay && counter.count >= limits.proactivePerDay) {
  log(`skip: 今日主动已达上限 ${limits.proactivePerDay}`);
  process.exit(0);
}
if (limits.dailyTokens) {
  let spent = 0;
  try {
    const dayStart = new Date(`${today}T00:00:00`).getTime();
    for (const line of fs.readFileSync(ROOT + '/state/token-usage.jsonl', 'utf8').split('\n')) {
      if (!line) continue;
      const e = JSON.parse(line);
      if ((e.t || 0) >= dayStart && e.b) spent += (e.b.cacheMiss || 0) + (e.b.cacheHit || 0) + (e.b.cacheWrite || 0) + (e.b.output || 0) + (e.b.reasoning || 0);
    }
  } catch { /* 没账本就不拦 */ }
  if (spent >= limits.dailyTokens) {
    log(`skip: 今日 token ${spent} 已达上限 ${limits.dailyTokens}`);
    process.exit(0);
  }
}

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch {}
}

try {
  const st = await (await fetch(`http://127.0.0.1:3100/api/socialV2/state?key=${encodeURIComponent(KEY)}`, { headers: H })).json();
  const now = Date.now();
  const idleMs = now - Number(st.lastIncomingAt || 0);
  const sinceHer = now - Number(st.lastAiReplyAt || 0);
  const unread = Number(st.unreadCount ?? (Array.isArray(st.unread) ? st.unread.length : 0));
  const hour = new Date().getHours();

  if (QUIET_HOURS.includes(hour)) { log(`skip: quiet hour ${hour}`); process.exit(0); }
  if (unread > 0) { log(`skip: ${unread} unread`); process.exit(0); }
  if (idleMs < MIN_IDLE_MS) { log(`skip: idle ${Math.round(idleMs / 60000)}min`); process.exit(0); }
  if (sinceHer < MIN_SINCE_HER_MS) { log(`skip: she spoke ${Math.round(sinceHer / 60000)}min ago`); process.exit(0); }
  if (Math.random() > PROBABILITY) { log('skip: probability'); process.exit(0); }

  counter.count += 1;
  try { fs.writeFileSync(counterFile, JSON.stringify(counter), 'utf8'); } catch { /* ignore */ }
  const r = await fetch('http://127.0.0.1:3100/api/socialV2/wake', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ key: KEY, reason: 'proactiveCheck' })
  });
  const j = await r.json().catch(() => ({}));
  log(`wake -> ${r.status} ${JSON.stringify(j).slice(0, 100)} | idle ${Math.round(idleMs / 60000)}min`);
} catch (error) {
  log(`error: ${error?.message ?? error}`);
}
