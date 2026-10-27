import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyImage, isHerArt, groupWorks, monthKey, monthStats, composeMonthlyReport } from '../gui/server/works-wall.js';

test('classifyImage：画/手绘/动图/梗/表情分开', () => {
  assert.equal(classifyImage('draw-mvmb1kl1-abc.png'), 'draw');
  assert.equal(classifyImage('sketch-mvp5txqv-whale.png'), 'sketch');
  assert.equal(classifyImage('anim-mvnmn6w0.gif'), 'anim');
  assert.equal(classifyImage('梗-001.png'), 'meme');
  assert.equal(classifyImage('卖萌-3.png'), 'sticker');
  assert.equal(isHerArt('draw-a.png'), true);
  assert.equal(isHerArt('梗-001.png'), false);
});

test('groupWorks：按上海月份分桶，她的画和梗图分开，月份倒序', () => {
  const oct = new Date('2026-10-25T12:00:00+08:00').getTime();
  const nov = new Date('2026-11-02T12:00:00+08:00').getTime();
  const files = [
    { name: 'draw-a.png', at: oct },
    { name: 'sketch-b.png', at: oct },
    { name: '梗-c.png', at: oct },
    { name: '卖萌-d.png', at: oct },
    { name: 'draw-e.png', at: nov },
  ];
  const { totals, months } = groupWorks(files);
  assert.equal(totals.art, 3);
  assert.equal(totals.meme, 1);
  assert.equal(totals.sticker, 1);
  assert.equal(totals.all, 5);
  assert.equal(months[0].month, '2026-11', '最新月份在前');
  assert.equal(months[1].month, '2026-10');
  assert.equal(months[1].art.length, 2);
  assert.equal(months[1].meme.length, 1);
  assert.ok(months[1].art[0].at >= months[1].art[1].at, '同月内按时间倒序');
});

test('monthKey：跨月边界按北京时间算', () => {
  assert.equal(monthKey(new Date('2026-10-31T23:30:00+08:00').getTime()), '2026-10');
  assert.equal(monthKey(new Date('2026-11-01T00:30:00+08:00').getTime()), '2026-11');
});

test('monthStats：只数当月，分她说/对方说，找最忙的一天', () => {
  const rows = [
    { t: new Date('2026-10-25T10:00:00+08:00').getTime(), role: 'her' },
    { t: new Date('2026-10-25T10:01:00+08:00').getTime(), role: 'other', sender: '数分椰椰' },
    { t: new Date('2026-10-26T10:00:00+08:00').getTime(), role: 'other', sender: '数分椰椰' },
    { t: new Date('2026-11-02T10:00:00+08:00').getTime(), role: 'her' },
    { t: 'bad', role: 'her' },
  ];
  const stats = monthStats(rows, { month: '2026-10' });
  assert.equal(stats.her, 1);
  assert.equal(stats.other, 2);
  assert.equal(stats.topPeers[0].who, '数分椰椰');
  assert.equal(stats.topPeers[0].count, 2);
  assert.deepEqual(stats.busiestDay, { day: '2026-10-25', count: 2 });
});

test('composeMonthlyReport：有数据分段，空月份也说人话', () => {
  const full = composeMonthlyReport({
    month: '2026-10', herMessages: 1191, otherMessages: 1926,
    topPeers: [{ who: '他', count: 434 }], art: 45, diary: 4,
    busiestDay: { day: '2026-10-25', count: 1781 }, moodTop: '还算平静',
    cost: 47.28, tokens: 1072000000,
  });
  assert.match(full, /2026-10 · 小结/);
  assert.match(full, /说了 1191 条/);
  assert.match(full, /画了 45 张/);
  assert.match(full, /话最多的一天是 2026-10-25（1781 条）/);
  assert.match(full, /¥47.28/);

  const empty = composeMonthlyReport({ month: '2026-09' });
  assert.match(empty, /2026-09 · 小结/);
  assert.match(empty, /几乎没说话/);
});
