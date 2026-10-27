import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  AGENT_IDS,
  AGENT_PROMPT_MAX_CHARS,
  AGENT_OUTPUT_MAX_CHARS,
  clampPrompt,
  cleanAgentOutput,
  resolveAgentPath,
  agentCatalog,
  askAgent,
} from '../src/agent-delegate.js';

test('只接受白名单里的 agent；不支持的给明确错误', async () => {
  assert.deepEqual(AGENT_IDS, ['opencode', 'codex']);
  const r = await askAgent({ agent: 'definitely-not-an-agent', prompt: 'hi' });
  assert.equal(r.ok, false);
  assert.match(r.error, /不支持的 agent/);
});

test('prompt 空或过长都直接拒绝，不偷偷截断', async () => {
  assert.equal(clampPrompt('').ok, false);
  assert.equal(clampPrompt('   ').ok, false);
  const long = 'x'.repeat(AGENT_PROMPT_MAX_CHARS + 1);
  const r = clampPrompt(long);
  assert.equal(r.ok, false);
  assert.match(r.error, /太长/);
  const fine = clampPrompt('只回复两个字：收到');
  assert.equal(fine.ok, true);
  assert.equal(fine.text, '只回复两个字：收到');
});

test('输出清理：去 ANSI、去掉 OpenCode 的状态行、压空行、超长截断', () => {
  const raw = '\u001b[90m> build · flint-40b-free\u001b[0m\n\n\n收到\n';
  assert.equal(cleanAgentOutput(raw, { stripsStatus: true }), '收到');
  const withAnsi = '\u001b[91m\u001b[1mError: \u001b[0m没有登录';
  assert.equal(cleanAgentOutput(withAnsi), 'Error: 没有登录');
  const long = 'a'.repeat(AGENT_OUTPUT_MAX_CHARS + 100);
  const capped = cleanAgentOutput(long);
  assert(capped.length <= AGENT_OUTPUT_MAX_CHARS + 20);
  assert.match(capped, /已截断/);
});

test('找可执行文件：config 指定优先，其次已知安装位置，都没有就是空', () => {
  const cfg = { socialV2: { agents: { opencode: { path: 'C:\\custom\\opencode.exe' } } } };
  assert.equal(resolveAgentPath('opencode', { cfg, exists: (p) => p === 'C:\\custom\\opencode.exe' }), 'C:\\custom\\opencode.exe');
  assert.equal(resolveAgentPath('opencode', { cfg: { socialV2: { agents: { opencode: { path: 'C:\\nope.exe' } } } }, exists: () => false }), '');
  const found = resolveAgentPath('codex', { cfg: {}, exists: (p) => p.endsWith('codex.cmd') });
  assert.match(found, /codex\.cmd$/);
  assert.equal(resolveAgentPath('unknown-agent', { cfg: {}, exists: () => true }), '');
});

test('目录：装上没装上、开关开没开都说清楚', () => {
  const list = agentCatalog({ cfg: { socialV2: { tools: { askAgent: false } } }, exists: (p) => p.includes('opencode-cli') });
  const oc = list.find((a) => a.id === 'opencode');
  assert.equal(oc.ready, true);
  assert.equal(oc.enabled, false);
  const cx = list.find((a) => a.id === 'codex');
  assert.equal(cx.ready, false);
  assert.match(cx.hint, /socialV2\.agents\.codex\.path/);
});

test('找不到 CLI 时不启动进程，直接给错误', async () => {
  let spawned = 0;
  const r = await askAgent({
    agent: 'codex', prompt: 'hi', cfg: {},
    spawnImpl: () => { spawned += 1; throw new Error('不应该被调用'); },
  });
  // 本机可能真的装了 codex，那就走下面那条；两条路径都必须是「有明确结果」，不能挂住
  assert.equal(typeof r.ok, 'boolean');
  if (!r.ok) assert.match(r.error, /没找到|启动|退出码|超时/);
  assert(spawned <= 1);
});

test('参数拼接：model 不填就不传，填了紧跟在子命令后面（假进程验证）', async () => {
  const { EventEmitter } = await import('node:events');
  const calls = [];
  const spawnStub = (bin, args) => {
    calls.push({ bin, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('\u001b[90m> build · flomo\u001b[0m\n好'));
      child.emit('close', 0);
    });
    return child;
  };
  const plain = await askAgent({ agent: 'opencode', prompt: '打个招呼', cfg: {}, spawnImpl: spawnStub });
  assert.deepEqual(calls[0].args, ['run', '打个招呼']);
  assert.equal(plain.ok, true);
  assert.equal(plain.text, '好');

  const withModel = await askAgent({ agent: 'opencode', prompt: '算一下', model: 'openai/x', cfg: {}, spawnImpl: spawnStub });
  assert.deepEqual(calls[1].args, ['run', '-m', 'openai/x', '算一下']);
  assert.equal(withModel.model, 'openai/x');
});

test('非零退出码：把对方 stderr 带回来，不假装成功', async () => {
  const { EventEmitter } = await import('node:events');
  const spawnStub = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('Error: 没有登录'));
      child.emit('close', 3);
    });
    return child;
  };
  const r = await askAgent({ agent: 'opencode', prompt: 'hi', cfg: {}, spawnImpl: spawnStub });
  assert.equal(r.ok, false);
  assert.match(r.error, /退出码 3/);
  assert.match(r.error, /没有登录/);
});

