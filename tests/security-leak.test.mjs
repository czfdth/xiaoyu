import test from 'node:test';
import assert from 'node:assert/strict';
import { SENSITIVE_RE, looksLikeAgentLeak } from '../src/sensitive.js';

test('编码代理串台会被识别', () => {
  const leaked = '当前目录：`C:\\Users\\best\\ai-her`（workspace-write，审批 ask）。是否要做点什么？';
  assert.equal(looksLikeAgentLeak(leaked), true);
  assert.equal(looksLikeAgentLeak('AI agent powered by DeepSeek Harness'), true);
});

test('正常聊天不会误判成串台', () => {
  assert.equal(looksLikeAgentLeak('今天好累，想你了'), false);
  assert.equal(looksLikeAgentLeak('我去跟画册耗着，你有空喊我'), false);
  assert.equal(looksLikeAgentLeak('工作区里那盆绿萝该浇水了'), false);
});

test('路径仍由敏感信息规则兜底', () => {
  assert.equal(SENSITIVE_RE.test('C:\\Users\\best\\ai-her'), true);
  assert.equal(SENSITIVE_RE.test('token=abcdef123456'), true);
  assert.equal(SENSITIVE_RE.test('今天好累，想你了'), false);
});
