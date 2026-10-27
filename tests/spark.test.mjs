import test from 'node:test';
import assert from 'node:assert/strict';
import { seriesToPath, sparkBounds } from '../gui/web/src/lib/spark.js';

test('seriesToPath：少于两个点返回空串（面板会显示"刚开始记录"）', () => {
  assert.equal(seriesToPath([], 'sleepy'), '');
  assert.equal(seriesToPath([{ sleepy: 0.5 }], 'sleepy'), '');
  assert.equal(seriesToPath(null, 'sleepy'), '');
});

test('seriesToPath：首点用 M、其余用 L，横轴均匀铺满 0~100', () => {
  const d = seriesToPath([{ sleepy: 0 }, { sleepy: 1 }, { sleepy: 0.5 }], 'sleepy', { width: 100, height: 34 });
  const parts = d.split(' ');
  assert.equal(parts.length, 3);
  assert.ok(parts[0].startsWith('M0.00,'));
  assert.ok(parts[1].startsWith('L50.00,'));
  assert.ok(parts[2].startsWith('L100.00,'));
  // y = height - value*height：0 值贴底、1 值贴顶
  assert.ok(parts[0].endsWith(',34.00'));
  assert.ok(parts[1].endsWith(',0.00'));
});

test('seriesToPath：值会被夹到 0~1，脏数据不会把线画到框外', () => {
  const d = seriesToPath([{ sleepy: -2 }, { sleepy: 3 }, { sleepy: 'x' }], 'sleepy');
  const ys = d.split(' ').map((p) => Number(p.split(',')[1]));
  assert.deepEqual(ys, [34, 0, 34]);
  assert.ok(d.split(' ').every((p) => /^[ML]-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(p)));
});

test('seriesToPath：缺字段按 0 处理，不会 NaN', () => {
  const d = seriesToPath([{ sleepy: 0.4 }, {}], 'sleepy');
  assert.ok(!d.includes('NaN'), d);
});

test('sparkBounds：纵轴固定 0~1，只统计有值的字段', () => {
  const b = sparkBounds([{ sleepy: 0.2 }, { sleepy: 0.8, tired: null }], ['sleepy', 'tired']);
  assert.equal(b.min, 0);
  assert.equal(b.max, 1);
  assert.equal(b.count, 2);
});
