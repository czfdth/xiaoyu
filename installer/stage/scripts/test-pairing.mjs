// 配对逻辑自测（纯函数 + 文件读写，不连 QQ）。
//   node scripts/test-pairing.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPairing, loadPairing, savePairing, clearPairing, pairingStatus, decidePairing,
  PAIRING_TTL_MS, PAIRING_MAX_ATTEMPTS,
} from '../src/pairing.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

const state = createPairing();
check('生成 6 位数字码', /^\d{6}$/.test(state.code), state.code);
check('默认 15 分钟有效', state.expiresAt - state.createdAt === PAIRING_TTL_MS);
check('默认最多错 5 次', state.maxAttempts === PAIRING_MAX_ATTEMPTS);

const active = pairingStatus(state);
check('status：有效 + 剩余次数', active.active && active.attemptsLeft === 5);

// 决策：没有主人、码对
check('码对 → pair', decidePairing({ hasOwner: false, state, input: state.code }).action === 'pair');
check('码里带空格也认', decidePairing({ hasOwner: false, state, input: ` ${state.code.slice(0, 3)} ${state.code.slice(3)} ` }).action === 'pair');

// 决策：已经有主人
check('已有主人 → 完全不看配对', decidePairing({ hasOwner: true, state, input: state.code }).action === 'ignore');

// 决策：没有码
check('没有码 → ignore', decidePairing({ hasOwner: false, state: null, input: '123456' }).action === 'ignore');

// 决策：错码计数
let s = state;
let last = null;
for (let i = 1; i <= 5; i++) {
  last = decidePairing({ hasOwner: false, state: s, input: '000000' });
  s = last.state ?? s;
  if (i < 5) check(`第 ${i} 次错码：还剩 ${5 - i} 次`, last.action === 'fail' && last.attemptsLeft === 5 - i);
}
check('第 5 次错码 → locked', last?.action === 'fail' && last?.locked === true);

// 决策：过期
const expired = createPairing({ ttlMs: -1000 });
check('过期 → expired', decidePairing({ hasOwner: false, state: expired, input: expired.code }).action === 'expired');

// 决策：格式不对也算失败
check('非 6 位数字 → 记一次失败', decidePairing({ hasOwner: false, state, input: 'hello' }).action === 'fail');

// 文件读写
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-'));
const file = path.join(dir, 'pairing.json');
savePairing(file, state);
const loaded = loadPairing(file);
check('写盘/读回一致', loaded && loaded.code === state.code);
clearPairing(file);
check('清除后读不到', loadPairing(file) === null);
check('坏文件不抛错', (() => { fs.writeFileSync(file, '{oops'); return loadPairing(file) === null; })());
fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${failed.length ? '失败' : '通过'} ${results.length - failed.length}/${results.length} ===`);
process.exit(failed.length ? 1 : 0);
