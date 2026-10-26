// DSH 侧的一键准备：找到 DSH → 把地址写回 config → 需要的话注册 MCP / preset。
//
//   node scripts/dsh-setup.mjs                 # 发现 + 自动注册
//   node scripts/dsh-setup.mjs --json          # 给部署脚本解析
//   node scripts/dsh-setup.mjs --no-register   # 只发现，不改 DSH
//   node scripts/dsh-setup.mjs --scan=0        # 只试常见端口，不扫进程
//
// 注意：注册之后 DSH 需要重启才会加载新的 MCP / preset（脚本会标记 needsDshRestart）。

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, readConfig, ensureRuntime } from '../src/paths.js';
import { discoverDsh, dshRegistration, persistDshBaseUrl } from '../src/dsh-discovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const noRegister = args.includes('--no-register');
const scanArg = args.find((a) => a.startsWith('--scan'));
const scan = scanArg ? scanArg.split('=')[1] !== '0' : true;

function log(message) {
  if (wantJson) console.error(message);
  else console.log(message);
}

const cfg = readConfig();
ensureRuntime({ quiet: true });
const found = await discoverDsh({ cfg, scan });

let persist = { updated: false };
let registeredNow = false;
let registerLog = '';

if (found.ok) {
  persist = persistDshBaseUrl(CONFIG_FILE, found.baseUrl);
  log(`  ✅ DSH 在 ${found.baseUrl}（profile: ${found.registration.profile || '未找到'}）`);
  if (persist.updated) log(`  config.json 的 dsh.baseUrl: ${persist.from || '(空)'} → ${persist.to}`);

  if (!found.registration.registered && !noRegister) {
    log('  注册 MCP / preset 到 DSH…');
    const profile = found.registration.profile || '';
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-dsh.mjs'), ...(profile ? ['--profile', profile] : [])], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    registerLog = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    registeredNow = run.status === 0;
    log(registeredNow ? '  ✅ 注册完成（DSH 重启后生效）' : '  ⚠️ 注册失败，下面有输出');
    if (registerLog) log(registerLog.split('\n').slice(-6).map((l) => `    ${l}`).join('\n'));
  } else if (found.registration.registered) {
    log('  已经注册过 MCP / preset，跳过');
  }
} else {
  log(`  ❌ ${found.error}`);
}

const registration = found.ok ? dshRegistration() : dshRegistration();
const result = {
  ok: found.ok,
  baseUrl: found.ok ? found.baseUrl : '',
  error: found.ok ? '' : found.error,
  profile: registration.profile,
  registered: registration.registered,
  registeredNow,
  needsDshRestart: registeredNow,
  configUpdated: persist.updated,
  tried: found.tried ?? [],
};

if (wantJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  console.log('');
  if (!found.ok) {
    console.log('  下一步：先安装并打开 DeepSeek Harness（DSH），登录模型后再跑一次。');
    console.log('  装好后本脚本会自动找到它的端口，不用手填。');
  } else if (registeredNow) {
    console.log('  下一步：重启 DSH（关掉再打开），然后回面板点「重启大脑」。');
  }
  console.log('');
}

process.exit(found.ok ? 0 : 1);
