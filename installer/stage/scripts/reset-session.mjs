#!/usr/bin/env node
// 定期重置会话（默认每 6 小时），把上下文压回去，省 token 也更快。
//
// 两条保险：
//  · 如果她最近 20 分钟还在说话，跳过这次（别在聊天中途把她记忆清空）
//  · 重置后立刻把私聊/群的唤醒配置写回去，否则会回落默认值
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, ''));
const OWNER = Number(cfg.ownerQQ) || 0;

const token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const base = 'http://127.0.0.1:3100';

const PRIVATE = `private:${OWNER}`;
const GROUP = 'group:1129441439';
const IDLE_GUARD_MS = 20 * 60 * 1000;
const FORCE = process.argv.includes('--force');

const privateCfg = {
  mode: 'active',
  infinite: true,
  triggers: { atMention: true, nameMention: true, question: true, poke: true, anyMessage: true }
};

const groupCfg = {
  mode: 'diving',
  infinite: true,
  batchWindowMs: 1200,
  triggers: {
    atMention: true, nameMention: true, question: true, poke: true, anyMessage: false, probability: 0.25,
    keywords: ['小鱼', '小鲸鱼', '大肥鱼', '鲸鱼', 'deepseek', 'DeepSeek', '在吗', '栗子']
  }
};

const H = { 'x-console-token': token, 'content-type': 'application/json' };

async function post(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const stamp = () => new Date().toLocaleString('zh-CN');

if (!FORCE) {
  try {
    const st = await (await fetch(`${base}/api/socialV2/state?key=${encodeURIComponent(PRIVATE)}`, { headers: H })).json();
    const last = Math.max(Number(st.lastIncomingAt || 0), Number(st.lastAiReplyAt || 0));
    const idleMin = Math.round((Date.now() - last) / 60000);
    if (last && Date.now() - last < IDLE_GUARD_MS) {
      console.log(stamp(), `skip: 她 ${idleMin} 分钟前还在说话`);
      process.exit(0);
    }
    console.log(stamp(), `idle ${idleMin} 分钟，可以重置`);
  } catch (e) {
    console.log(stamp(), 'idle check failed, proceed anyway:', e.message);
  }
}

for (const key of [PRIVATE, GROUP]) {
  try {
    const r = await post('/api/session/reset', { key });
    console.log(stamp(), 'reset', key, r.status);
  } catch (error) {
    console.error(stamp(), 'reset failed', key, error?.message ?? error);
  }
}

for (const [key, cfg] of [[PRIVATE, privateCfg], [GROUP, groupCfg]]) {
  try {
    const r = await post('/api/socialV2/wake-config', { key, config: cfg });
    const w = r.json?.wakeConfig ?? {};
    console.log(stamp(), 'wake-config', key, r.status, 'mode=' + (w.mode ?? '?'), 'anyMessage=' + (w.triggers?.anyMessage ?? '?'));
  } catch (error) {
    console.error(stamp(), 'wake-config failed', key, error?.message ?? error);
  }
}

try {
  fs.writeFileSync(path.join(ROOT, 'state', 'last-session-reset.json'), JSON.stringify({ at: Date.now() }, null, 2), 'utf8');
} catch {}
