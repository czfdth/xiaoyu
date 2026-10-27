import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, collectMissed, catchUpConversation } from '../src/catch-up.js';

test('textOf：拼文本段、忽略图片，兜底 raw_message', () => {
  assert.equal(textOf({ message: [{ type: 'text', data: { text: '你好' } }, { type: 'image', data: {} }] }), '你好');
  assert.equal(textOf({ raw_message: '  原样  ' }), '原样');
  assert.equal(textOf({ message: [{ type: 'image', data: {} }] }), '');
  assert.equal(textOf(null), '');
});

test('collectMissed：只要比 since 新的、有文字的，按时间正序', () => {
  const rows = [
    { time: 100, message: [{ type: 'text', data: { text: '旧的' } }], sender: { user_id: 1 } },
    { time: 300, message: [{ type: 'text', data: { text: '新的' } }], sender: { user_id: 2, nickname: '他' } },
    { time: 200, message: [{ type: 'image', data: {} }], sender: { user_id: 1 } },
    { time: 400, message: [{ type: 'text', data: { text: '更新' } }], sender: { user_id: 3, card: '数分椰椰' } },
  ];
  const missed = collectMissed(rows, 200 * 1000);
  assert.equal(missed.length, 2);
  assert.deepEqual(missed.map((m) => m.text), ['新的', '更新']);
  assert.equal(missed[1].senderName, '数分椰椰');
  assert.ok(missed[0].at < missed[1].at, '按时间正序');
  assert.deepEqual(collectMissed([], 0), []);
  assert.deepEqual(collectMissed(null, 0), []);
});

test('collectMissed：time 是秒，转成毫秒后和 since 比', () => {
  const rows = [{ time: 1_700_000_000, message: [{ type: 'text', data: { text: 'a' } }] }];
  assert.equal(collectMissed(rows, 1_699_999_999 * 1000).length, 1, '晚一秒要补');
  assert.equal(collectMissed(rows, 1_700_000_001 * 1000).length, 0, '早于水位不补');
});

test('catchUpConversation：群用 group_id、私聊用 user_id，补回的调用 ingest', async () => {
  const calls = [];
  const request = async (action, params) => {
    calls.push({ action, params });
    return { data: { messages: [{ time: 500, message: [{ type: 'text', data: { text: '在吗' } }], sender: { user_id: 9 } }] } };
  };
  const got = [];
  const r = await catchUpConversation({ key: 'group:1', kind: 'group', id: '1', since: 100 * 1000, request, ingest: (m) => got.push(m) });
  assert.equal(r.added, 1);
  assert.equal(calls[0].action, 'get_group_msg_history');
  assert.equal(calls[0].params.group_id, 1);
  assert.equal(got[0].text, '在吗');

  await catchUpConversation({ key: 'private:2', kind: 'private', id: '2', since: 0, request: async (a, p) => {
    calls.push({ action: a, params: p });
    return { messages: [] };
  }, ingest: () => { throw new Error('不该被调用'); } });
  assert.equal(calls[1].action, 'get_friend_msg_history');
  assert.equal(calls[1].params.user_id, 2);
});

test('catchUpConversation：接口报错时返回 error，不抛（不能连累主进程）', async () => {
  const r = await catchUpConversation({
    key: 'group:1', kind: 'group', id: '1', since: 0,
    request: async () => { throw new Error('boom'); },
    ingest: () => {},
  });
  assert.equal(r.added, 0);
  assert.match(r.error, /boom/);
});
