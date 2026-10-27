// 自检：不用连 QQ、不用连 DSH，就能回答「这个包在干净目录里能不能自己跑起来」。
//
//   node scripts/self-check.mjs
//
// 检查项：
//   1. src/paths.js 能跑通，首次运行能生成 config.json（含引擎探测）
//   2. 生成的目录/配置结构对
//   3. src/bridge.js --check 通过（不连网、不抢锁）
//   4. bin/status.mjs --json 能出结构化状态
//   5. 两个 MCP server 能被 stdio 拉起来并列出工具
//   6. 源码里没有写死的盘符/老仓库路径
//
// 任何一项失败 → 退出码 1。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const results = [];

// 自检默认针对「当前这份包」。XIAOYU_HOME 指到别处时，config/state 读的是那边 ——
// 不说明的话，「config 里有 engines 段」之类的检查会莫名其妙失败。
if (process.env.XIAOYU_HOME && path.resolve(process.env.XIAOYU_HOME) !== ROOT) {
  console.log(`⚠️  XIAOYU_HOME=${process.env.XIAOYU_HOME}：本次自检读的是那边的数据，不是当前目录`);
}
if (process.env.XIAOYU_SNOWLUMA_LIVE === '1') {
  console.log('⚠️  XIAOYU_SNOWLUMA_LIVE=1：会额外连一次真网关（只读）');
}

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

function run(args, opts = {}) {
  const r = spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8', timeout: 60000, ...opts });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

// 1) 初始化 + 首次运行
const init = run(['src/paths.js', '--init', '--json']);
let snap = null;
try { snap = JSON.parse(init.out); } catch { /* 下面记失败 */ }
record('paths.js --init 能跑通', init.status === 0 && Boolean(snap), init.status !== 0 ? init.err.split('\n')[0] : '');

if (snap) {
  record('config.json 存在', snap.configExists === true, snap.config);
  record('state/ 存在', fs.existsSync(snap.dirs.state), snap.dirs.state);
  const e = snap.engines ?? {};
  const found = ['snowluma', 'gptSovits', 'comfyui'].filter((k) => e[k]?.home);
  record('引擎探测有结果', found.length > 0, found.length ? found.join(', ') : '一个都没找到（可以之后手填 config.engines）');
  const cfg = JSON.parse(fs.readFileSync(snap.config, 'utf8').replace(/^\uFEFF/, ''));
  record('config 里有 engines 段', Boolean(cfg.engines && typeof cfg.engines === 'object'),
    cfg.engines ? Object.keys(cfg.engines).length + ' 个键' : '');
}

// 2) bridge 冒烟
const boot = run(['src/bridge.js', '--check']);
record('bridge --check 通过', boot.status === 0, boot.status === 0 ? '' : (boot.err || boot.out).split('\n')[0]);

// 3) 状态面板（机器读）
const status = run(['bin/status.mjs', '--json']);
let st = null;
try { st = JSON.parse(status.out); } catch { /* 下面记失败 */ }
record('status.mjs --json 可用', status.status === 0 && Boolean(st), st ? Object.keys(st.ports).length + ' 个端口' : (status.err || '').split('\n')[0]);

// 4) MCP server 能被拉起来（SDK 在 node_modules 里才测）
try {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  async function probe(script) {
    const transport = new StdioClientTransport({
      command: NODE, args: [script], cwd: ROOT, env: { ...process.env }, stderr: 'ignore',
    });
    const client = new Client({ name: 'self-check', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try { return (await client.listTools()).tools.length; } finally { await client.close(); }
  }
  const n1 = await probe('src/mcp-snowluma-safe.js');
  const n2 = await probe('src/mcp-host-server.js');
  record('MCP server 可启动', n1 > 50 && n2 >= 1, `snowluma ${n1} 个工具 / host ${n2} 个`);
} catch (error) {
  record('MCP server 可启动', false, String(error?.message ?? error).slice(0, 120));
}

// 5) 管家控制台：前端构建物 + 后端接口（用 Fastify inject，不占端口、不起服务）
const distIndex = path.join(ROOT, 'gui', 'dist', 'index.html');
record('管家前端已构建', fs.existsSync(distIndex), distIndex);
try {
  const { buildApp } = await import(pathToFileURL(path.join(ROOT, 'gui', 'server', 'app.mjs')).href);
  const app = await buildApp({ guiDir: path.join(ROOT, 'gui') });
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  const overview = await app.inject({ method: 'GET', url: '/api/overview' });
  const page = await app.inject({ method: 'GET', url: '/' });
  await app.close();
  const ok = health.statusCode === 200 && overview.statusCode === 200 && page.statusCode === 200;
  record('管家接口可用', ok, `health ${health.statusCode} / overview ${overview.statusCode} / index ${page.statusCode}`);
} catch (error) {
  record('管家接口可用', false, String(error?.message ?? error).slice(0, 120));
}

// 6) 首次配对逻辑（纯函数，不写文件）
try {
  const { createPairing, decidePairing } = await import(pathToFileURL(path.join(ROOT, 'src', 'pairing.js')).href);
  const state = createPairing();
  const ok = decidePairing({ hasOwner: false, state, input: state.code }).action === 'pair'
    && decidePairing({ hasOwner: true, state, input: state.code }).action === 'ignore'
    && decidePairing({ hasOwner: false, state: null, input: state.code }).action === 'ignore';
  record('首次配对逻辑可用', ok, `6 位码 ${state.code}`);
} catch (error) {
  record('首次配对逻辑可用', false, String(error?.message ?? error).slice(0, 120));
}

// 7) DSH（大脑）状态可读 —— 没装 DSH 也算通过，只要模块不崩
try {
  const { dshRegistration } = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-discovery.mjs')).href);
  const reg = dshRegistration();
  record('DSH 状态可读取', typeof reg.profile === 'string',
    reg.profile ? `profile ${reg.profile}${reg.registered ? ' · 已注册' : ' · 未注册'}` : '没有 ~/.dsh（可后装）');
} catch (error) {
  record('DSH 状态可读取', false, String(error?.message ?? error).slice(0, 120));
}

// 8) PowerShell 脚本必须带 UTF-8 BOM
// Windows PowerShell 5.1 按 ANSI 读无 BOM 文件，脚本里的中文会把引号撑破（实测踩过）。
const psFiles = [];
for (const dir of ['bin', '.']) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    if (name.endsWith('.ps1')) psFiles.push(path.join(full, name));
  }
}
const badBom = psFiles.filter((file) => {
  try {
    const buf = fs.readFileSync(file);
    return !(buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
  } catch { return true; }
});
record('PowerShell 脚本带 BOM', badBom.length === 0, badBom.map((f) => path.relative(ROOT, f)).join(', '));

// 9) 写死路径扫描（gui 要递归，但跳过 node_modules / 构建产物）
const BAD = /C:[\\/]Users[\\/]|deepseek-harness|[A-Z]:[\\/]{1,2}(ai-voice|MiniMaxH3|ComfyUI|SnowLuma)/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'assets']);
const files = [];
function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full);
    } else if (/\.(js|mjs)$/.test(e.name)) {
      files.push(full);
    }
  }
}
for (const dir of ['src', 'bin', 'gui']) {
  const full = path.join(ROOT, dir);
  if (fs.existsSync(full)) walk(full);
}
const offenders = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (BAD.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
  });
}
record('源码没有写死的盘符路径', offenders.length === 0, offenders.slice(0, 5).join(', '));

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`=== 自检 ${failed.length ? '未通过' : '通过'}：${results.length - failed.length}/${results.length} ===`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  · ' + f.name + (f.detail ? ' — ' + f.detail : ''));
  process.exit(1);
}
