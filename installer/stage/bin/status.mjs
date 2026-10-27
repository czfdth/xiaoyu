// 小鱼 · 状态面板（命令行版）
//
// 路径全部来自 src/paths.js：不再写死 qq-bridge / C:\Users\...。
// 用法：
//   node bin/status.mjs          人看
//   node bin/status.mjs --json   给 GUI / 脚本解析

import fs from 'node:fs';
import net from 'node:net';
import {
  snapshot,
  PORTS,
  STATE_FILES,
  readConfig,
  configExists,
} from '../src/paths.js';

const wantJson = process.argv.includes('--json');
const P = snapshot();

function portOpen(p) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port: p });
    s.setTimeout(600);
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.on('timeout', () => { s.destroy(); res(false); });
  });
}

/** 本地日期（原来的 toISOString() 是 UTC，中国时区零点到八点会算成昨天）。 */
function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}
function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
}
function countFiles(dir, re) {
  try { return fs.readdirSync(dir).filter((f) => re.test(f)).length; } catch { return 0; }
}

function lastHerLine() {
  for (const offset of [0, -1]) {
    const file = `${STATE_FILES.journalDir}/${localDay(offset)}.jsonl`;
    try {
      const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const hers = rows.filter((r) => r.role === 'her');
      if (!hers.length) continue;
      const t = hers[hers.length - 1];
      return `${new Date(t.t).toLocaleTimeString('zh-CN')}  ${String(t.text || '').slice(0, 50)}`;
    } catch { /* 今天没有就看昨天 */ }
  }
  return '';
}

const ports = {};
for (const [name, port] of Object.entries(PORTS)) ports[name] = await portOpen(port);

const inner = readJson(STATE_FILES.inner);
const body = readJson(STATE_FILES.body);
const cfg = readConfig();

// 配置提醒：装完能跑，但白名单/密钥没填就不会回消息 —— 这才是新手最容易卡住的地方。
const warnings = [];
if (!configExists()) warnings.push('还没有 config.json（先跑 node src/paths.js --init）');
if (!cfg.ownerQQ) warnings.push('ownerQQ 没填：审批、管理命令、封闭模式都不可用');
if (!(cfg.allow?.private ?? []).length && !(cfg.allow?.groups ?? []).length) {
  warnings.push('allow 白名单是空的：她不会回任何消息');
}
if (!(cfg.snowluma?.accessToken ?? '')) warnings.push('snowluma.accessToken 没填：连不上 QQ 网关');

const out = {
  ports,
  engines: P.engines,
  capabilities: P.capabilities,
  config: { file: P.config, exists: P.configExists, warnings },
  her: { inner, body, last: lastHerLine() },
  counts: {
    memoir: countFiles(STATE_FILES.memoirDir, /\.md$/),
    diary: countFiles(STATE_FILES.diaryDir, /\.md$/),
    dream: countLines(STATE_FILES.dreams),
    fantasy: countLines(STATE_FILES.fantasies),
    memory: countLines(STATE_FILES.longTermMemory),
  },
};

if (wantJson) {
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

const NAMES = { gateway: 'QQ 网关', gatewayWs: 'QQ WS', tts: '声音', comfyui: '画图', bridge: '大脑', gui: '管家' };
const PORT_LIST = ['gateway', 'gatewayWs', 'tts', 'comfyui', 'bridge'];
const mark = (ok) => (ok ? '✅' : '❌');

console.log('\n=== 小鱼 · 状态面板 ===\n');
for (const k of PORT_LIST) {
  console.log(`${mark(ports[k])}  ${String(PORTS[k]).padEnd(5)} ${NAMES[k] ?? k}`);
}

console.log('\n--- 引擎 ---');
console.log(`${mark(Boolean(P.capabilities.snowluma))} SnowLuma   ${P.engines.snowluma.home || '没装'}`);
console.log(`${mark(Boolean(P.capabilities.voice))} 声音       ${P.engines.gptSovits.home || '没装（可选）'}`);
console.log(`${mark(Boolean(P.capabilities.draw))} 画图       ${P.engines.comfyui.home || '没装（可选）'}`);
console.log(`${mark(Boolean(P.capabilities.sing))} 唱歌       ${P.engines.rvc.home || '没装（可选）'}`);

console.log('\n--- 她 ---');
console.log('此刻在做：' + (inner.doing || '-'));
console.log('心里在想：' + (inner.thinking || '-'));
console.log('身体：' + (body.note || '-'));
console.log('最后一句：' + (out.her.last || '今天还没说话'));

console.log('\n--- 产出 ---');
console.log('回忆录：' + out.counts.memoir + ' 章');
console.log('日记：' + out.counts.diary + ' 篇');
console.log('梦：' + out.counts.dream + ' 个');
console.log('幻想：' + out.counts.fantasy + ' 条');

if (warnings.length) {
  console.log('\n--- 还没配好的 ---');
  for (const w of warnings) console.log('⚠️  ' + w);
  console.log(`配置：${P.config}`);
}
console.log('');
