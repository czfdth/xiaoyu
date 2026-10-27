import test from 'node:test';
import assert from 'node:assert/strict';
import { pickQuotes, composeChapter, countDays, archiveMonth } from '../src/consolidate.js';

test('pickQuotes：情绪优先，再补最长的，去重且按时间排', () => {
  const rows = [
    { role: 'her', t: 1, text: '好' },
    { role: 'other', t: 2, text: '这是对方说的，不该被挑中' },
    { role: 'her', t: 3, text: '我今天有点累，不太想说话' },
    { role: 'her', t: 4, text: '这条只是比较长而已但没有任何情绪词在里面啊' },
    { role: 'her', t: 5, text: '我怕它又坏掉，一直盯着看' },
    { role: 'her', t: 6, text: '我怕它又坏掉，一直盯着看' },
    { role: 'her', t: 7, text: '今天天气不错，我出去走了走，海风挺凉的' },
  ];
  const picks = pickQuotes(rows, { limit: 4, minLength: 8 });
  assert.equal(picks.length, 4);
  assert.ok(picks.some((p) => p.text.includes('累')), '带情绪的要在里面');
  assert.ok(picks.every((p) => p.text.length >= 8), '太短的不该进');
  assert.equal(new Set(picks.map((p) => p.text)).size, picks.length, '去重');
  assert.deepEqual(picks.map((p) => p.at), [...picks.map((p) => p.at)].sort((a, b) => a - b), '按时间正序');
});

test('pickQuotes：没有她的话就返回空，不靠编', () => {
  assert.deepEqual(pickQuotes([{ role: 'other', t: 1, text: '在吗在吗在吗' }]), []);
  assert.deepEqual(pickQuotes([]), []);
  assert.deepEqual(pickQuotes(null), []);
});

test('composeChapter：有原话、有统计、像人写的回忆录', () => {
  const text = composeChapter({
    month: '2026-10',
    stats: { busiestDay: { day: '2026-10-25', count: 1781 } },
    quotes: [{ at: 1, text: '我怕它又坏掉' }, { at: 2, text: '一起抠脚吧' }],
    totalDays: 4,
    herMessages: 1196,
    otherMessages: 1930,
    topPeers: [{ who: '他', count: 434 }, { who: '数分椰椰', count: 159 }],
  });
  assert.match(text, /^# 关于2026-10 那阵子/);
  assert.match(text, /说了 1196 条/);
  assert.match(text, /大多是和他、数分椰椰说话/);
  assert.match(text, /话最多的那天是 2026-10-25/);
  assert.match(text, /> 我怕它又坏掉/);
  assert.match(text, /只是那天的心情已经不在了/);
});

test('composeChapter：没原话也照样成篇，不空白', () => {
  const text = composeChapter({ month: '2026-09', quotes: [], herMessages: 0, otherMessages: 0 });
  assert.match(text, /这一月我没留下什么话/);
  assert.match(text, /说话的人不多/);
});

test('countDays / archiveMonth：只数当月，归档后删原件', () => {
  const files = ['/x/journal/2026-10-01.jsonl', '/x/journal/2026-10-02.jsonl', '/x/journal/2026-11-01.jsonl'];
  assert.equal(countDays(files, '2026-10'), 2);
  assert.equal(countDays(files, '2026-12'), 0);
  // 演练模式：不写文件、不删原件（这里只验返回值结构）
  const result = archiveMonth([], { archiveDir: '/tmp/nowhere' });
  assert.deepEqual(result, []);
});
