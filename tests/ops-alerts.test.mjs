import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAlertCenter, classifyError, backupAge, ALERT_DEFAULTS } from '../src/alerts.js';
import { dayKey, normalizeLimits, loadDaily, addUsage, addProactive, shouldBlockAutonomous } from '../src/usage-budget.js';
import { driftBody, driftDelta, DRIFT_DEFAULTS } from '../src/vitals-drift.js';
import { addPending, takePending, peekPending, pendingHint, PENDING_MAX_PER_KEY } from '../src/pending-answers.js';

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-ops-'));
  return { dir, file: path.join(dir, name) };
}

test('classifyError：余额/上下文/其它分别归类', () => {
  assert.equal(classifyError('Insufficient Balance (request_id: x)'), 'balance');
  assert.equal(classifyError('This model maximum context length is 1048576 tokens'), 'contextOverflow');
  assert.equal(classifyError('DeepSeek Messages stream: tool input is invalid JSON'), 'agentErrors');
  assert.equal(classifyError(''), 'agentErrors');
});

test('告警：连续 3 次才报，冷却期内不重复，冷却过了再报', () => {
  const { dir, file } = tmp('alerts.json');
  const fired = [];
  const center = createAlertCenter({ file, now: () => T, onFire: (a) => fired.push(a) });
  let T = 1_000_000;
  assert.equal(center.report('agentErrors', 'e1').fired, false);
  assert.equal(center.report('agentErrors', 'e2').fired, false);
  const third = center.report('agentErrors', 'e3');
  assert.equal(third.fired, true);
  assert.equal(third.alert.count, 3);
  assert.equal(fired.length, 1);

  // 冷却期内：即使继续报也不重复
  T += 60_000;
  assert.equal(center.report('agentErrors', 'e4').fired, false);
  assert.equal(fired.length, 1);

  // 冷却结束后需要重新攒够阈值
  T += ALERT_DEFAULTS.agentErrors.cooldownMs + 1000;
  assert.equal(center.report('agentErrors', 'e5').fired, false);
  assert.equal(center.report('agentErrors', 'e6').fired, false);
  assert.equal(center.report('agentErrors', 'e7').fired, true);
  assert.equal(fired.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('告警：余额这类一次就报；active 只在冷却期内可见；重启后冷却仍有效', () => {
  const { dir, file } = tmp('alerts.json');
  let T = 5_000_000;
  const center = createAlertCenter({ file, now: () => T });
  const r = center.report('balance', 'Insufficient Balance');
  assert.equal(r.fired, true);
  assert.equal(center.active().length, 1);
  assert.equal(center.active()[0].level, 'error');

  // 重新建一个（模拟桥接重启）：读回同一个文件，冷却还在
  const again = createAlertCenter({ file, now: () => T });
  assert.equal(again.report('balance', 'Insufficient Balance').fired, false, '重启不该让冷却失效');
  assert.equal(again.active().length, 1);

  // 冷却过期后 active 清空
  T += ALERT_DEFAULTS.balance.cooldownMs + 1;
  assert.equal(again.active().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backupAge：没有备份返回 Infinity，有就返回最新那个的年龄', () => {
  const { dir } = tmp('x');
  assert.equal(backupAge(dir).ageMs, Infinity);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-bk-'));
  fs.writeFileSync(path.join(dir2, 'xiaoyu-20261027-041000.zip'), 'x');
  fs.writeFileSync(path.join(dir2, 'other.zip'), 'x');
  const info = backupAge(dir2, { now: Date.now() + 3600_000 });
  assert.match(info.latest, /^xiaoyu-/);
  assert.ok(info.ageMs >= 3600_000 - 5000, '年龄应该是一小时左右');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('日账：按上海日期记账，跨天自动清零', () => {
  const { dir, file } = tmp('usage.json');
  const day1 = new Date('2026-10-27T10:00:00+08:00').getTime();
  const day2 = new Date('2026-10-28T01:00:00+08:00').getTime();
  assert.equal(dayKey(day1), '2026-10-27');
  assert.equal(dayKey(day2), '2026-10-28', '凌晨 1 点算第二天');

  addUsage(file, 1000, day1);
  addUsage(file, 500, day1);
  assert.equal(loadDaily(file, day1).tokens, 1500);
  addProactive(file, day1);
  assert.equal(loadDaily(file, day1).proactive, 1);

  // 跨天：昨天的数不该带过来
  assert.equal(loadDaily(file, day2).tokens, 0);
  assert.equal(loadDaily(file, day2).proactive, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('日预算：到线只拦主动，不影响回复；0 表示不限', () => {
  assert.deepEqual(normalizeLimits(null), { dailyTokens: 0, proactivePerDay: 0 });
  assert.deepEqual(normalizeLimits({ dailyTokens: -5, proactivePerDay: '3' }), { dailyTokens: 0, proactivePerDay: 3 });

  assert.equal(shouldBlockAutonomous({ usedTokens: 10, proactiveCount: 0, limits: {} }).block, false);
  const overTokens = shouldBlockAutonomous({ usedTokens: 200, proactiveCount: 0, limits: { dailyTokens: 100 } });
  assert.equal(overTokens.block, true);
  assert.match(overTokens.reason, /token/);
  const overProactive = shouldBlockAutonomous({ usedTokens: 0, proactiveCount: 3, limits: { proactivePerDay: 3 } });
  assert.equal(overProactive.block, true);
  assert.match(overProactive.reason, /主动/);
});

test('身体漂移：宽限期内不动，之后按小时涨，封顶 0.95', () => {
  const now = new Date('2026-10-27T15:00:00+08:00').getTime();
  const base = { sleepy: 0.3, tired: 0.3, hungry: 0.3, cold: 0.3 };

  const fresh = driftBody(base, { sinceMs: 10 * 60 * 1000, now });
  assert.deepEqual({ s: fresh.sleepy, t: fresh.tired }, { s: 0.3, t: 0.3 }, '刚写过就完全信她');

  const fourHours = driftBody(base, { sinceMs: 4 * 3600 * 1000, now });
  assert.ok(fourHours.sleepy > 0.3, '困应该涨了');
  assert.ok(fourHours.tired > 0.3);
  assert.ok(fourHours.hungry > 0.3);

  const long = driftBody({ sleepy: 0.9 }, { sinceMs: 48 * 3600 * 1000, now });
  assert.equal(long.sleepy, DRIFT_DEFAULTS.max, '封顶');
  assert.ok(long.hungry >= DRIFT_DEFAULTS.max, '饿也会到顶');

  const night = driftBody(base, { sinceMs: 2 * 3600 * 1000, now: new Date('2026-10-28T02:00:00+08:00').getTime() });
  assert.ok(night.sleepy > driftBody(base, { sinceMs: 2 * 3600 * 1000, now }).sleepy, '深夜更困');
});

test('身体漂移：没写过的字段给个中性起点，delta 只标出明显差异', () => {
  const now = Date.now();
  const d = driftBody({}, { sinceMs: 3 * 3600 * 1000, now });
  assert.ok(d.sleepy >= 0.3 && d.sleepy <= 0.95);
  assert.equal(typeof d.drifts, 'number');

  const delta = driftDelta({ sleepy: 0.3 }, { sleepy: 0.55, tired: 0.3 });
  assert.equal(delta.sleepy, 0.25);
  assert.equal(delta.tired, undefined, '差异太小不标');
});

test('待补队列：同一条不重复，每个会话最多 5 条，取走即清空', () => {
  let state = {};
  state = addPending(state, 'private:1', { at: 1000, reason: 'invalid JSON', texts: ['你现在的状态怎么样'] });
  state = addPending(state, 'private:1', { at: 1000, reason: 'invalid JSON', texts: ['你现在的状态怎么样'] });
  assert.equal(peekPending(state, 'private:1').length, 1, '同一条不重复记');

  for (let i = 0; i < 10; i += 1) {
    state = addPending(state, 'private:1', { at: 2000 + i, reason: `e${i}`, texts: [`msg${i}`] });
  }
  assert.equal(peekPending(state, 'private:1').length, PENDING_MAX_PER_KEY);

  const taken = takePending(state, 'private:1');
  assert.equal(taken.list.length, PENDING_MAX_PER_KEY);
  assert.equal(peekPending(taken.state, 'private:1').length, 0, '取走即清空');
  assert.equal(takePending(taken.state, 'private:1').list.length, 0);
});

test('待补提示：带上"几分钟前"和失败原因，不像新消息', () => {
  const hint = pendingHint([{ at: Date.now() - 12 * 60000, reason: 'invalid JSON', texts: ['在吗'] }]);
  assert.match(hint, /补答/);
  assert.match(hint, /12 分钟前/);
  assert.match(hint, /invalid JSON/);
  assert.match(hint, /别当成刚发生的/);
  assert.equal(pendingHint([]), '');
  assert.equal(pendingHint(null), '');
});
