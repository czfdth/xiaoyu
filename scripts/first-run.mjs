// 首次部署的最后一步（给 bin\deploy.ps1 调用，也可以单独跑）：
//
//   1. 建目录 / 生成 config.json（如果还没有）
//   2. 等 SnowLuma 网关上线，自动发现 HTTP/WS 地址与 token（用户不用手抄）
//   3. 还没主人 → 生成一个 6 位配对码，写进 state/pairing.json
//   4. 输出一份结果（--json 给脚本，人类看默认格式）
//
// 用法：
//   node scripts/first-run.mjs                 # 立刻探测一次
//   node scripts/first-run.mjs --wait 120      # 最多等 120 秒（SnowLuma 正在登录时用）
//   node scripts/first-run.mjs --pairing       # 重新生成配对码
//   node scripts/first-run.mjs --json

import {
  APP_ROOT, CONFIG_FILE, STATE_FILES, ensureRuntime, readConfig, configExists, detectEngines,
} from '../src/paths.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint } from '../src/snowluma/index.js';
import { createPairing, savePairing, loadPairing, pairingStatus } from '../src/pairing.js';
import { discoverDsh, persistDshBaseUrl } from '../src/dsh-discovery.mjs';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const regenerate = args.includes('--pairing');
const waitArg = args.find((a) => a.startsWith('--wait'));
const waitSeconds = Number(waitArg?.includes('=') ? waitArg.split('=')[1] : args[args.indexOf(waitArg) + 1]) || 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(message) {
  if (!wantJson) console.log(message);
  else console.error(message);
}

ensureRuntime({ quiet: true });

// 1) 等网关
let found = null;
const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
let attempts = 0;
for (;;) {
  attempts += 1;
  found = await discoverSnowLumaConnection({ cfg: readConfig(), timeoutMs: 2500 });
  if (found.ok) break;
  if (Date.now() >= deadline) break;
  if (!wantJson && attempts === 1) log('  等 SnowLuma 上线（手机 QQ 扫码登录后会自动继续）…');
  await sleep(2000);
}

// 2) 写回端点
if (found.ok) {
  try {
    persistSnowLumaEndpoint(CONFIG_FILE, {
      accessToken: found.token,
      httpUrl: found.baseUrl,
      wsUrl: found.wsUrl || undefined,
    });
  } catch (error) {
    log(`  ⚠️ 写回 SnowLuma 端点失败：${error?.message ?? error}`);
  }
}

// 3) DSH（大脑）：地址写回 config，顺带报注册状态
//    先按配置里的地址试一次（快）；不通再扫本机端口（DSH 每次启动端口可能变）。
const cfgBeforeDsh = readConfig();
let dsh = await discoverDsh({ cfg: cfgBeforeDsh, scan: false, timeoutMs: 900 });
if (!dsh.ok) dsh = await discoverDsh({ cfg: cfgBeforeDsh, scan: true, timeoutMs: 900 });
let dshPersist = { updated: false };
if (dsh.ok) {
  try { dshPersist = persistDshBaseUrl(CONFIG_FILE, dsh.baseUrl); } catch (error) { log(`  ⚠️ 写回 DSH 地址失败：${error?.message ?? error}`); }
}

// 4) 配对码
const cfg = readConfig();
let pairingState = loadPairing(STATE_FILES.pairing);
const status = pairingStatus(pairingState);
if (!cfg.ownerQQ && (!status.active || regenerate)) {
  pairingState = createPairing();
  savePairing(STATE_FILES.pairing, pairingState);
}

const result = {
  ok: true,
  root: APP_ROOT,
  config: CONFIG_FILE,
  configExists: configExists(),
  gateway: found.ok
    ? { ok: true, uin: found.self?.user_id ?? null, nickname: found.self?.nickname ?? '', httpUrl: found.baseUrl, wsUrl: found.wsUrl ?? null }
    : { ok: false, error: found.error, tried: found.tried?.length ?? 0 },
  dsh: dsh.ok
    ? { ok: true, baseUrl: dsh.baseUrl, profile: dsh.registration?.profile ?? '', registered: Boolean(dsh.registration?.registered) }
    : { ok: false, error: dsh.error, profile: dsh.registration?.profile ?? '', registered: Boolean(dsh.registration?.registered) },
  paired: Boolean(cfg.ownerQQ),
  ownerQQ: cfg.ownerQQ ?? null,
  pairing: !cfg.ownerQQ && pairingState
    ? { code: pairingState.code, expiresAt: pairingState.expiresAt, ttlMinutes: Math.round((pairingState.expiresAt - Date.now()) / 60000) }
    : null,
  engines: detectEngines(),
};

if (wantJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  console.log('');
  console.log('=== 小鱼 · 首次部署 ===');
  console.log(`  目录    ${result.root}`);
  console.log(`  配置    ${result.config}`);
  if (result.gateway.ok) {
    console.log(`  ✅ 网关   ${result.gateway.nickname || '已登录'}（${result.gateway.uin}）@ ${result.gateway.httpUrl}`);
  } else {
    console.log(`  ❌ 网关   ${result.gateway.error}`);
  }
  if (result.dsh.ok) {
    console.log(`  ✅ 大脑   ${result.dsh.baseUrl}（profile ${result.dsh.profile || '?'}，${result.dsh.registered ? '已注册' : '未注册'}）`);
  } else {
    console.log(`  ❌ 大脑   ${result.dsh.error}`);
  }
  if (result.paired) {
    console.log(`  ✅ 已认主 ${result.ownerQQ}`);
  } else if (result.pairing) {
    console.log('');
    console.log(`  配对码：${result.pairing.code}   （${result.pairing.ttlMinutes} 分钟内有效）`);
    console.log('  用你自己的 QQ 私聊她，把这 6 位数字发过去，就完成认主。');
  }
  console.log('');
}
