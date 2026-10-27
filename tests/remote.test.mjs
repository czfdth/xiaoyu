import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, signSession, verifySession, isLoopback, MIN_PASSWORD } from '../gui/server/remote.js';

test('口令哈希：正确口令通过，错误口令不通过，同一口令两次哈希不同', () => {
  const a = hashPassword('correct horse battery');
  const b = hashPassword('correct horse battery');
  assert.notEqual(a, b, '每次要换 salt');
  assert.equal(verifyPassword('correct horse battery', a), true);
  assert.equal(verifyPassword('correct horse battery', b), true);
  assert.equal(verifyPassword('wrong password!!', a), false);
  assert.equal(verifyPassword('', a), false);
  assert.equal(verifyPassword('x', ''), false);
  assert.ok(MIN_PASSWORD >= 12);
});

test('会话：签名能用、能验证、过期失效、乱改失效', () => {
  const now = Date.now();
  const s = signSession(now);
  assert.equal(verifySession(s, now), true);
  assert.equal(verifySession(s, now + 8 * 86400000), false, '7 天后过期');

  const [exp, nonce, mac] = s.split('.');
  assert.equal(verifySession(`${Number(exp) + 1000}.${nonce}.${mac}`, now), false, '改过期时间要失效');
  assert.equal(verifySession(`${exp}.${nonce}.${'0'.repeat(mac.length)}`, now), false, '改签名要失效');
  assert.equal(verifySession('', now), false);
  assert.equal(verifySession('abc', now), false);
});

test('isLoopback：只有本机地址算本机', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) assert.equal(isLoopback(h), true, h);
  for (const h of ['192.168.1.5', '10.0.0.2', 'example.com', '']) assert.equal(isLoopback(h), false, h);
});
