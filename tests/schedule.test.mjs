// 调度判断的单元测试：纯函数，不启动桥接、不碰磁盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shanghaiHour,
  dayKey,
  shouldSendDailyReport,
  inNightWindow,
  shouldRotateLogs,
} from '../src/schedule.js';

const at = (hour, minute = 0) => new Date(`2026-10-29T00:00:00+08:00`).getTime()
  + hour * 3600000 + minute * 60000;

test('shanghaiHour / dayKey 按上海时区算', () => {
  assert.equal(shanghaiHour(at(9)), 9);
  assert.equal(shanghaiHour(at(23, 30)), 23);
  assert.equal(dayKey(at(0, 30)), '2026-10-29');
});

test('日报：8~23 点之间、当天没发过才发', () => {
  assert.equal(shouldSendDailyReport({ now: at(7), ownerQQ: 1 }).due, false);
  assert.equal(shouldSendDailyReport({ now: at(8), ownerQQ: 1 }).due, true);
  assert.equal(shouldSendDailyReport({ now: at(22, 59), ownerQQ: 1 }).due, true);
  assert.equal(shouldSendDailyReport({ now: at(23), ownerQQ: 1 }).due, false);
  assert.equal(
    shouldSendDailyReport({ now: at(9), lastSentDay: '2026-10-29', ownerQQ: 1 }).due,
    false,
    '当天已发就不该再发',
  );
  assert.equal(shouldSendDailyReport({ now: at(9), ownerQQ: '' }).due, false, '没有收件人不发');
});

test('夜间窗口：23 点后到凌晨 2 点', () => {
  assert.equal(inNightWindow(at(22, 59)), false);
  assert.equal(inNightWindow(at(23)), true);
  assert.equal(inNightWindow(at(1, 59)), true);
  assert.equal(inNightWindow(at(2)), false);
  assert.equal(inNightWindow(at(14)), false);
});

test('日志轮转：5 点后且距上次超过 20 小时', () => {
  assert.equal(shouldRotateLogs({ now: at(4) }), false);
  assert.equal(shouldRotateLogs({ now: at(5, 30) }), true, '从没轮转过就该跑');
  assert.equal(shouldRotateLogs({ now: at(6), lastAt: at(5, 30) }), false, '刚跑过不重复');
  assert.equal(shouldRotateLogs({ now: at(6), lastAt: at(5, 30) - 21 * 3600000 }), true);
});
