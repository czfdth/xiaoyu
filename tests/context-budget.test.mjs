import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_BUDGET_DEFAULTS,
  normalizeContextBudget,
  createContextBudget,
} from '../src/context-budget.js';

test('预算配置默认值可直接用，非法值不放大成无限制', () => {
  assert.equal(normalizeContextBudget({}).maxStepsPerTurn, CONTEXT_BUDGET_DEFAULTS.maxStepsPerTurn);
  assert.equal(normalizeContextBudget().rotatePromptTokens, CONTEXT_BUDGET_DEFAULTS.rotatePromptTokens);
  assert.equal(normalizeContextBudget({ maxStepsPerTurn: 'abc' }).maxStepsPerTurn, CONTEXT_BUDGET_DEFAULTS.maxStepsPerTurn);
  assert.equal(normalizeContextBudget({ maxStepsPerTurn: -5 }).maxStepsPerTurn, 0);
  assert.equal(normalizeContextBudget({ rotatePromptTokens: '60000' }).rotatePromptTokens, 60000);
  assert.equal(normalizeContextBudget(null).rotateMinTurns, CONTEXT_BUDGET_DEFAULTS.rotateMinTurns);
});

test('单回合步数到上限才打断，且同一回合只打断一次', () => {
  const budget = createContextBudget({ limits: { maxStepsPerTurn: 5 } });
  const hit = [];
  for (let step = 1; step <= 8; step += 1) {
    const r = budget.observe({ sessionId: 's1', turn: 3, step, promptTokens: 1000 });
    if (r.interrupt) hit.push(step);
  }
  assert.deepEqual(hit, [5], '第 5 步打断一次，之后不再重复打断');
});

test('新回合重新计数，上一回合的打断标记不会沿用', () => {
  const budget = createContextBudget({ limits: { maxStepsPerTurn: 3 } });
  assert.equal(budget.observe({ sessionId: 's1', turn: 1, step: 3 }).interrupt, true);
  assert.equal(budget.observe({ sessionId: 's1', turn: 2, step: 3 }).interrupt, true);
  assert.equal(budget.observe({ sessionId: 's1', turn: 2, step: 1 }).interrupt, false);
});

test('上限为 0 表示不打断', () => {
  const budget = createContextBudget({ limits: { maxStepsPerTurn: 0 } });
  for (let step = 1; step <= 200; step += 1) {
    assert.equal(budget.observe({ sessionId: 's1', turn: 1, step }).interrupt, false);
  }
});

test('回合结束累计回合数，并按最新 prompt 大小判定轮换', () => {
  const budget = createContextBudget({ limits: { rotatePromptTokens: 50000, rotateMinTurns: 2 } });
  budget.observe({ sessionId: 's1', turn: 1, step: 1, promptTokens: 120000 });
  assert.equal(budget.shouldRotate('s1'), false, '回合太少时即便 prompt 很大也不轮换');
  assert.equal(budget.noteTurnEnd('s1').turns, 1);
  budget.observe({ sessionId: 's1', turn: 2, step: 1, promptTokens: 120000 });
  budget.noteTurnEnd('s1');
  assert.equal(budget.shouldRotate('s1'), true);
  assert.match(budget.rotateReason('s1'), /120000/);
  assert.match(budget.rotateReason('s1'), /2 回合/);
});

test('prompt 没超阈值不轮换；阈值 0 表示关闭轮换', () => {
  const small = createContextBudget({ limits: { rotatePromptTokens: 50000, rotateMinTurns: 1 } });
  small.observe({ sessionId: 's1', turn: 1, step: 1, promptTokens: 49999 });
  small.noteTurnEnd('s1');
  assert.equal(small.shouldRotate('s1'), false);

  const off = createContextBudget({ limits: { rotatePromptTokens: 0, rotateMinTurns: 1 } });
  off.observe({ sessionId: 's1', turn: 1, step: 1, promptTokens: 900000 });
  off.noteTurnEnd('s1');
  assert.equal(off.shouldRotate('s1'), false);
});

test('未观测过的会话不产生统计，forget 后清零', () => {
  const budget = createContextBudget();
  assert.equal(budget.stats('nope'), null);
  assert.equal(budget.shouldRotate('nope'), false);
  assert.equal(budget.noteTurnEnd('nope'), null);
  budget.observe({ sessionId: 's1', turn: 1, step: 2, promptTokens: 100 });
  assert.equal(budget.stats('s1').steps, 2);
  budget.forget('s1');
  assert.equal(budget.stats('s1'), null);
  assert.equal(budget.size(), 0);
});

test('非法/缺失字段不污染统计', () => {
  const budget = createContextBudget({ limits: { maxStepsPerTurn: 5 } });
  assert.equal(budget.observe({}).interrupt, false);
  assert.equal(budget.observe({ sessionId: 's1' }).steps, 0);
  const r = budget.observe({ sessionId: 's1', turn: 'x', step: 'y', promptTokens: 'z' });
  assert.equal(r.interrupt, false);
  assert.equal(budget.stats('s1').promptTokens, 0);
});

test('重启后按账本回填：老会话不用再等满 20 回合才够轮换条件', () => {
  const budget = createContextBudget({ limits: { rotatePromptTokens: 80000, rotateMinTurns: 20 } });
  // 模拟桥接刚起来：内存里没有采样，直接断言此时不轮换
  assert.equal(budget.shouldRotate('s-old'), false);
  budget.seed('s-old', { promptTokens: 772554, turns: 316, turn: 351 });
  assert.equal(budget.shouldRotate('s-old'), true, '回填后立刻满足轮换条件');
  assert.match(budget.rotateReason('s-old'), /316 回合/);
  const s = budget.stats('s-old');
  assert.equal(s.promptTokens, 772554);
  assert.equal(s.turns, 316);
  assert.equal(s.turn, 351);
});

test('回填只补不减：更小的历史值不会覆盖已有统计', () => {
  const budget = createContextBudget({ limits: { rotatePromptTokens: 50000, rotateMinTurns: 2 } });
  budget.observe({ sessionId: 's1', turn: 9, step: 1, promptTokens: 90000 });
  budget.noteTurnEnd('s1');
  budget.noteTurnEnd('s1');
  budget.seed('s1', { promptTokens: 1000, turns: 1 });
  const s = budget.stats('s1');
  assert.equal(s.promptTokens, 90000);
  assert.equal(s.turns, 2);
});
