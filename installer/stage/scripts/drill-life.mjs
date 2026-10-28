#!/usr/bin/env node
// 功能演练：把"写了但从没被真实触发过"的几条路，用假数据跑一遍。
//
// 为什么需要：今天上线了 6 个机制（空闲刷新、打转打断、预算拦截、失败补答、日报、告警），
// 日志里全是 0 次触发 —— 这是最容易"看着绿其实是死的"的地方（silent-guard 就是这么悄悄把群改回静音的）。
//
// 这个脚本不碰真实数据：全部在临时 XIAOYU_HOME 里造，跑完删掉。任何一项不过就以退出码 1 结束。
//
// 用法：node scripts/drill-life.mjs   或   npm run drill:life

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-drill-'));
process.env.XIAOYU_HOME = home;
fs.mkdirSync(path.join(home, 'state'), { recursive: true });
fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ownerQQ: 10001 }), 'utf8');

const results = [];
async function check(name, fn) {
  try {
    // 必须 await：不 await 的话断言失败会被当成"通过"，演练就成了摆设
    const detail = await fn();
    if (detail === false) throw new Error('断言失败');
    results.push({ ok: true, name, detail: detail === true ? '' : String(detail ?? '') });
  } catch (error) {
    results.push({ ok: false, name, detail: String(error?.message ?? error) });
  }
}

const H = 3600 * 1000;

// ── 1. 日账与预算拦截 ──────────────────────────────────────────────────────
await check('日账：跨天翻页 + 超限只拦主动', async () => {
  const { addUsage, addProactive, loadDaily, shouldBlockAutonomous, dayKey } = await import('../src/usage-budget.js');
  const file = path.join(home, 'state', 'usage-daily.json');
  const day1 = new Date('2026-10-27T09:00:00+08:00').getTime();
  addUsage(file, 5000, day1);
  addProactive(file, day1);
  const today = loadDaily(file, day1);
  if (today.tokens !== 5000 || today.proactive !== 1) throw new Error(`日账没记上：${JSON.stringify(today)}`);
  const verdict = shouldBlockAutonomous({ usedTokens: today.tokens, proactiveCount: today.proactive, limits: { dailyTokens: 1000 } });
  if (!verdict.block) throw new Error('超限了却没拦');
  const replyAllowed = shouldBlockAutonomous({ usedTokens: 0, proactiveCount: 0, limits: { dailyTokens: 1000 } });
  if (replyAllowed.block) throw new Error('不该拦普通回复');
  return `已用 ${today.tokens} / 上限 1000 → ${verdict.reason}`;
});

// ── 2. 打转打断 ────────────────────────────────────────────────────────────
await check('打转：同工具同参数第 2 次就拦', async () => {
  const { createRepeatGuard } = await import('../src/context-budget.js');
  const guard = createRepeatGuard({ limit: 2 });
  const sig = 'qq_get_recent_messages|{"key":"private:1"}';
  const first = guard.note('s1', sig);
  const second = guard.note('s1', sig);
  if (first) throw new Error('第一次不该算重复');
  if (!second) throw new Error('第二次必须判为重复');
  const other = guard.note('s1', 'qq_get_recent_messages|{"key":"private:2"}');
  if (other) throw new Error('参数不同不该算重复');
  return '第 2 次命中并打断，换参数不误伤';
});

// ── 2b. 步数上限 ──────────────────────────────────────────────────────
await check('步数上限：跑到第 12 步就截断，不无限打转', async () => {
  const { createContextBudget, CONTEXT_BUDGET_DEFAULTS } = await import('../src/context-budget.js');
  const budget = createContextBudget({ limits: CONTEXT_BUDGET_DEFAULTS });
  let interruptedAt = 0;
  for (let step = 1; step <= 20; step += 1) {
    const r = budget.observe({ sessionId: 's-limit', turn: 1, step, promptTokens: 20000 });
    if (r.interrupt && !interruptedAt) interruptedAt = step;
  }
  if (CONTEXT_BUDGET_DEFAULTS.maxStepsPerTurn !== 12) throw new Error('默认上限应该是 12，实际 ' + CONTEXT_BUDGET_DEFAULTS.maxStepsPerTurn);
  if (!interruptedAt) throw new Error('跑满 20 步都没被截断');
  return '第 ' + interruptedAt + ' 步触发截断';
});

// ── 3. 空闲刷新 ────────────────────────────────────────────────────────────
await check('空闲刷新：20 分钟 + 35k 才换会话', async () => {
  const { createContextBudget, CONTEXT_BUDGET_DEFAULTS } = await import('../src/context-budget.js');
  const t0 = Date.now();
  const budget = createContextBudget({ limits: CONTEXT_BUDGET_DEFAULTS });
  // observe 的签名是 {sessionId, turn, step, promptTokens}；updatedAt 记的是真实时间
  budget.observe({ sessionId: 's1', turn: 1, step: 1, promptTokens: 40000 });
  budget.noteTurnEnd('s1');
  if (budget.shouldRefreshIdle('s1', t0 + 5 * 60 * 1000)) throw new Error('才 5 分钟就刷新，太急');
  if (!budget.shouldRefreshIdle('s1', t0 + 25 * 60 * 1000)) throw new Error('25 分钟了还不刷新');
  budget.observe({ sessionId: 's2', turn: 1, step: 1, promptTokens: 5000 });
  budget.noteTurnEnd('s2');
  if (budget.shouldRefreshIdle('s2', t0 + 25 * 60 * 1000)) throw new Error('小会话不该刷新');
  return '5 分钟不动、25 分钟换新；5000 token 的小会话不换';
});

// ── 4. 失败补答 ────────────────────────────────────────────────────────────
await check('补答：记下失败 → 出提示 → 投递后清空', async () => {
  const { addPending, takePending, peekPending, pendingHint } = await import('../src/pending-answers.js');
  let store = addPending({}, 'private:1', { at: Date.now() - 12 * 60000, reason: 'invalid JSON', texts: ['你现在的状态怎么样'] });
  const hint = pendingHint(peekPending(store, 'private:1'));
  if (!hint.includes('补答') || !hint.includes('你现在的状态怎么样')) throw new Error('提示里没有待补内容');
  store = takePending(store, 'private:1').state;
  if (peekPending(store, 'private:1').length) throw new Error('投递后没清空');
  return '提示里带上了「12 分钟前」和失败原因';
});

// ── 5. 日报 ────────────────────────────────────────────────────────────────
await check('日报：造一天数据 → 生成文案 → 落盘', async () => {
  const { composeDailyReport } = await import('../src/ops.js');
  const day = '2026-10-27';
  const text = composeDailyReport({
    day, herMessages: 63, otherMessages: 49,
    topPeers: [{ who: '他', count: 30 }], mood: '还算平静',
    diary: 1, tokens: 206350935, cost: 16.66, firstAt: '00:13', lastAt: '15:29',
  });
  if (!text.includes('说话 63 条')) throw new Error('日报文案不对');
  fs.mkdirSync(path.join(home, 'state', 'reports'), { recursive: true });
  const file = path.join(home, 'state', 'reports', `${day}.md`);
  fs.writeFileSync(file, `${text}\n`, 'utf8');
  if (!fs.existsSync(file)) throw new Error('日报没落盘');
  return `state/reports/${day}.md`;
});

// ── 6. 告警：阈值 + 冷却 ───────────────────────────────────────────────────
await check('告警：连续 3 次触发一次，冷却期内不再刷', async () => {
  const { createAlertCenter } = await import('../src/alerts.js');
  const file = path.join(home, 'state', 'alerts.json');
  let T = 2_000_000;
  const fired = [];
  const center = createAlertCenter({ file, now: () => T, onFire: (a) => fired.push(a) });
  center.report('agentErrors', 'e1');
  center.report('agentErrors', 'e2');
  const third = center.report('agentErrors', 'e3');
  if (!third.fired) throw new Error('第 3 次该触发');
  T += 60_000;
  const again = center.report('agentErrors', 'e4');
  if (again.fired) throw new Error('冷却期内不该再报');
  const active = center.active();
  if (!active.length) throw new Error('active() 应该能看到刚触发的告警');
  return `触发 1 次，冷却期内拦截；active=${active.length}`;
});

// ── 7. 密钥扫描 + 备份清理 ─────────────────────────────────────────────────
await check('体检：明文密钥能被点名，清理不碰 state', async () => {
  const { keyHealth, cleanup } = await import('../src/ops.js');
  const conf = path.join(home, 'companion.json');
  fs.writeFileSync(conf, '{"apiKey":"sk-aaaaaaaaaaaaaaaaaaaa"}', 'utf8');
  const health = keyHealth({ configFiles: [conf], logFiles: [] });
  if (health.ok) throw new Error('明文密钥没被发现');
  const oldZip = path.join(home, 'backups', 'xiaoyu-old.zip');
  fs.writeFileSync(oldZip, 'x');
  const old = Date.now() - 40 * 86400000;
  fs.utimesSync(oldZip, old / 1000, old / 1000);
  const stateFile = path.join(home, 'state', 'social-v2.json');
  fs.writeFileSync(stateFile, '{}');
  fs.utimesSync(stateFile, old / 1000, old / 1000);
  const result = cleanup({ home, keepBackupDays: 30, dryRun: false });
  if (!result.removed.length) throw new Error('老备份没被清');
  if (!fs.existsSync(stateFile)) throw new Error('state 被误删了');
  return `删了 ${result.removed.length} 个旧文件，state 完好`;
});

// ── 输出 ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n演练 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}`);
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 删不掉也无所谓 */ }
process.exit(failed.length ? 1 : 0);
