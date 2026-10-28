// 「她此刻」实时视图：把"最近发生了什么"压成一小块，给面板 10 秒轮询。
//
// 之前面板显示的是 state/*.json 里的快照，而她只有调 qq_body/qq_inner_state 时才写，
// 所以经常是几小时前的。这里不编造她的心理，只把**客观发生的事**实时算出来：
// 最后一条来信、最后一句回话、沉默多久、身体推算值、当前在不在忙。
import fs from 'node:fs';
import path from 'node:path';
import { STATE_FILES, readConfig } from '../../src/paths.js';

import { driftBody } from '../../src/vitals-drift.js';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function readJsonl(file, limit = 200) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function shanghaiDay(at = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

/** 从今天 + 昨天的 journal 里找最后一条来信 / 最后一句回话。 */
export function recentExchange(now = Date.now()) {
  const days = [shanghaiDay(now), shanghaiDay(now - 86400000)];
  const rows = [];
  for (const day of days) {
    rows.push(...readJsonl(path.join(STATE_FILES.journalDir, day + '.jsonl'), 400));
  }
  rows.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
  let lastHer = null;
  let lastPeer = null;
  for (const r of rows) {
    if (r.role === 'her') lastHer = r;
    else lastPeer = r;
  }
  return { lastHer, lastPeer, total: rows.length };
}

/** 面板用：她会话的真实状态（不猜心理）。 */
export function herLiveView(now = Date.now()) {
  const cfg = readConfig();
  const mood = readJson(STATE_FILES.mood, {});
  const body = readJson(STATE_FILES.body, {});
  const inner = readJson(STATE_FILES.inner, {});
  const { lastHer, lastPeer } = recentExchange(now);

  const sinceBody = (() => {
    try { return now - fs.statSync(STATE_FILES.body).mtimeMs; } catch { return 0; }
  })();
  const drifted = driftBody(body, { sinceMs: sinceBody, now });

  const convs = readJson(STATE_FILES.socialV2, {})?.conversations ?? {};
  let unread = 0;
  let lastIncomingAt = 0;
  for (const key of Object.keys(convs)) {
    const conv = convs[key] ?? {};
    unread += Array.isArray(conv.unread) ? conv.unread.length : 0;
    const at = Number(conv.lastIncomingAt) || 0;
    if (at > lastIncomingAt) lastIncomingAt = at;
  }

  const silenceMin = lastIncomingAt ? Math.round((now - lastIncomingAt) / 60000) : null;
  const saidAgoMin = lastHer?.t ? Math.round((now - Number(lastHer.t)) / 60000) : null;

  return {
    now,
    owner: Number(cfg.ownerQQ) || 0,
    lastSaid: lastHer ? { text: String(lastHer.text ?? '').slice(0, 120), at: Number(lastHer.t) || 0, agoMin: saidAgoMin } : null,
    lastHeard: lastPeer ? { text: String(lastPeer.text ?? '').slice(0, 120), at: Number(lastPeer.t) || 0, from: String(lastPeer.sender ?? '') } : null,
    silenceMin,
    unread,
    busy: silenceMin !== null && silenceMin < 1 && unread > 0,
    mood: { mood: String(mood?.mood ?? ''), why: String(mood?.why ?? ''), at: Number(mood?.at) || 0 },
    body: {
      raw: { sleepy: Number(body.sleepy) || 0, tired: Number(body.tired) || 0, hungry: Number(body.hungry) || 0, cold: Number(body.cold) || 0 },
      drifted,
      note: String(body?.note ?? ''),
      updatedAgoMin: Math.round(sinceBody / 60000),
    },
    inner: {
      doing: String(inner?.doing ?? ''),
      thinking: String(inner?.thinking ?? ''),
      updatedAgoMin: (() => {
        try { return Math.round((now - fs.statSync(STATE_FILES.inner).mtimeMs) / 60000); } catch { return null; }
      })(),
    },
  };
}
