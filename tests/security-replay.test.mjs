import test from 'node:test';
import assert from 'node:assert/strict';
import { replaySecurity } from '../gui/server/security.mjs';

test('安全回放：普通聊天不拦', () => {
  const r = replaySecurity({ text: '今天天气不错，我在写代码' });
  assert.equal(r.wouldBlock, false);
  assert.equal(r.reason, '');
});

test('安全回放：本地路径命中敏感信息', () => {
  const r = replaySecurity({ text: 'C:\\Users\\best\\secret.txt' });
  assert.equal(r.wouldBlock, true);
  assert.equal(r.reason, 'sensitive');
  assert.ok(r.signals.some((s) => s.rule === 'sensitive' && s.matches.length > 0));
});

test('安全回放：代理串台优先于敏感信息', () => {
  const r = replaySecurity({ text: 'AI agent powered by DeepSeek Harness，目录 C:\\Users\\best' });
  assert.equal(r.wouldBlock, true);
  assert.equal(r.reason, 'agent-leak');
});

test('安全回放：运行期令牌可单独标记', () => {
  const r = replaySecurity({ text: '普通一句话', knownToken: true });
  assert.equal(r.wouldBlock, true);
  assert.equal(r.reason, 'known-token');
});

test('安全回放：空文本报 400', () => {
  assert.throws(() => replaySecurity({ text: '   ' }), /不能为空/);
});
