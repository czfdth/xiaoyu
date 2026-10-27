import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GAUGES,
  vitalOf,
  changedEnough,
  recordVital,
  readVitals,
  bucketActivity,
  VITALS_MAX_BYTES,
} from '../src/vitals.js';

function tmpFile(name = 'vitals.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-vitals-'));
  return { dir, file: path.join(dir, name) };
}

test('vitalOf：把 0~1 的值夹住，缺字段补 0，mood 截断', () => {
  const v = vitalOf({ sleepy: 1.4, tired: -0.2, hungry: 'x' }, { mood: '还算平静啊真的' }, 123);
  assert.equal(v.sleepy, 1);
  assert.equal(v.tired, 0);
  assert.equal(v.hungry, 0);
  assert.equal(v.cold, 0);
  assert.equal(v.t, 123);
  assert.ok(v.mood.length <= 20);
  assert.deepEqual(GAUGES, ['sleepy', 'tired', 'hungry', 'cold']);
});

test('changedEnough：阈值内不算变化，心情变了算', () => {
  const a = vitalOf({ sleepy: 0.5, tired: 0.5 }, { mood: '平静' });
  const b = vitalOf({ sleepy: 0.51, tired: 0.5 }, { mood: '平静' });
  assert.equal(changedEnough(a, b), false, '0.01 的抖动不该写新行');
  const c = vitalOf({ sleepy: 0.5, tired: 0.5 }, { mood: '有点累' });
  assert.equal(changedEnough(a, c), true, '心情变了要记');
  assert.equal(changedEnough(null, a), true, '第一次永远要记');
});

test('recordVital：值没变不写，变了追加；文件不存在会建', () => {
  const { dir, file } = tmpFile();
  const first = recordVital(file, { sleepy: 0.4 }, { mood: '平静' }, { at: 1000 });
  assert.equal(first.written, true);
  assert.equal(fs.existsSync(file), true);

  const same = recordVital(file, { sleepy: 0.4 }, { mood: '平静' }, { at: 2000 });
  assert.equal(same.written, false, '没变就不写');

  const changed = recordVital(file, { sleepy: 0.8 }, { mood: '平静' }, { at: 3000 });
  assert.equal(changed.written, true);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).sleepy, 0.8);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordVital：文件超过上限会只保留尾部，不会无限长', () => {
  const { dir, file } = tmpFile();
  // 先塞一堆旧行到超过上限
  const big = [];
  for (let i = 0; i < 20000; i += 1) big.push(JSON.stringify({ t: i, sleepy: 0.5, tired: 0.5, hungry: 0, cold: 0, mood: 'x', pad: 'y'.repeat(20) }));
  fs.writeFileSync(file, `${big.join('\n')}\n`, 'utf8');
  assert.ok(fs.statSync(file).size > VITALS_MAX_BYTES);
  recordVital(file, { sleepy: 0.9 }, { mood: '醒了' }, { at: Date.now() });
  assert.ok(fs.statSync(file).size <= VITALS_MAX_BYTES, '写完后应该已经瘦身');
  assert.ok(fs.readFileSync(file, 'utf8').trim().split('\n').length <= 1501);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readVitals：按时间窗过滤、坏行跳过、超量等距抽样且保留首尾', () => {
  const { dir, file } = tmpFile();
  const now = 1_700_000_000_000;
  const lines = ['不是 json', ''];
  for (let i = 0; i < 500; i += 1) {
    lines.push(JSON.stringify({ t: now - (500 - i) * 60000, sleepy: i / 500, tired: 0.5, hungry: 0, cold: 0, mood: 'm' }));
  }
  lines.push(JSON.stringify({ t: now - 48 * 3600 * 1000, sleepy: 0.1, tired: 0.1, hungry: 0, cold: 0, mood: '旧' }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

  const all = readVitals(file, { hours: 24, maxPoints: 120, now });
  assert.equal(all.length, 120, '应该被抽样到 120 个点');
  assert.ok(all[0].t <= all[all.length - 1].t, '按时间正序');
  assert.ok(all[all.length - 1].t === now - 60000, '保留最新的那个点');
  assert.ok(all[0].t === now - 500 * 60000, '保留最老的那个点');
  assert.ok(all.every((p) => p.mood !== '旧'), '48 小时前的点不该出现');

  const few = readVitals(file, { hours: 24, maxPoints: 1000, now });
  assert.equal(few.length, 500);
  assert.deepEqual(readVitals(path.join(dir, 'nope.jsonl'), { hours: 24 }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bucketActivity：按小时分桶、分她/对方、统计最长沉默', () => {
  const now = new Date('2026-10-27T15:30:00+08:00').getTime();
  const t = (h, m) => new Date(`2026-10-27T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`).getTime();
  const messages = [
    { t: t(13, 0), role: 'other' },
    { t: t(13, 1), role: 'her' },
    { t: t(13, 5), role: 'her' },
    { t: t(15, 0), role: 'other' },
    { t: t(15, 20), role: 'her' },
    { t: now - 30 * 3600 * 1000, role: 'other' }, // 24 小时前，不进桶但要进首末时间
  ];
  const { buckets, stats } = bucketActivity(messages, { now, hours: 24 });
  assert.equal(buckets.length, 24);
  const h13 = buckets.find((b) => b.hour === '13:00');
  assert.equal(h13.her, 2);
  assert.equal(h13.other, 1);
  assert.equal(stats.her, 3);
  assert.equal(stats.other, 2, '30 小时前那条在窗口外，不进统计');
  assert.equal(stats.total, 5);
  assert.equal(stats.longestQuietMin, Math.round((t(15, 0) - t(13, 5)) / 60000));
  assert.equal(bucketActivity([], { now }).stats.total, 0);
  assert.equal(bucketActivity(null, { now }).buckets.length, 24);
});
