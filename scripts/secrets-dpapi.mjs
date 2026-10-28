#!/usr/bin/env node
// 密钥落盘加密（Windows DPAPI，按当前用户加密）。
//
// 现状：companion.json 里 apiKey 是明文 `sk-…`，而且跟着每个备份 zip 走。
// 这里用 DPAPI 加密成 companion.json.dpapi：**只有这台机器的这个用户**能解开，
// 拷到别的机器或别的用户下就是一堆乱码。
//
// 用法：
//   node scripts/secrets-dpapi.mjs status                 # 看现在是什么状态
//   node scripts/secrets-dpapi.mjs encrypt                # 加密（生成 .dpapi，删明文前先校验）
//   node scripts/secrets-dpapi.mjs decrypt                # 回滚成明文
//   node scripts/secrets-dpapi.mjs test --file <副本>      # 在副本上验证加解密闭环，不碰真文件
//
// 注意：加密之后，所有读 companion.json 的地方都要改成读 companion.json.dpapi。
// 在没改完之前**不要**用 encrypt，否则那些读取方会读不到 key。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { APP_ROOT } from '../src/paths.js';
const COMPANION_FILE = process.env.XIAOYU_COMPANION_CONFIG
  ? path.resolve(process.env.XIAOYU_COMPANION_CONFIG)
  : path.join(APP_ROOT, 'companion.json');
import { dpapiEncrypt, dpapiDecrypt } from '../src/companion.js';

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const fileArg = (() => {
  const i = args.indexOf('--file');
  return i >= 0 ? args[i + 1] : '';
})();
const target = fileArg ? path.resolve(fileArg) : COMPANION_FILE;
const encFile = `${target}.dpapi`;

function status() {
  const plain = fs.existsSync(target);
  const enc = fs.existsSync(encFile);
  const shell = fs.existsSync(path.join(os.homedir(), 'OneDrive', 'xiaoyu-backups'));
  console.log(`配置文件      ${target}`);
  console.log(`明文存在      ${plain ? '是' : '否'}`);
  console.log(`加密存在      ${enc ? '是' : '否'}${enc ? `（${Math.round(fs.statSync(encFile).size / 1024)} KB）` : ''}`);
  console.log(`异地备份目录  ${shell ? '有' : '没有'}`);
  if (plain && enc) console.log('状态：两套都在（加密未生效，读取方仍读明文）');
  else if (plain) console.log('状态：明文（未加密）');
  else if (enc) console.log('状态：已加密（读取方必须支持 .dpapi）');
  else console.log('状态：都没有');
}

if (cmd === 'status') {
  status();
} else if (cmd === 'test') {
  // 在副本上验证闭环：读明文 → 加密 → 解密 → 比对
  if (!fileArg) { console.error('test 需要 --file <副本路径>'); process.exit(1); }
  const plain = fs.readFileSync(target, 'utf8');
  const blob = dpapiEncrypt(plain);
  const back = dpapiDecrypt(blob);
  const same = back === plain;
  console.log(`加密长度 ${blob.length}  解密一致 ${same ? '✅' : '❌'}`);
  if (!same) process.exit(1);
  const key = (() => { try { return JSON.parse(plain.replace(/^\uFEFF/, '')).apiKey ? '有 apiKey' : '没有 apiKey'; } catch { return '解析失败'; } })();
  console.log(`副本内容 ${key}`);
} else if (cmd === 'encrypt') {
  if (!fs.existsSync(target)) { console.error('没有可加密的配置文件'); process.exit(1); }
  if (!target.endsWith('companion.json')) {
    console.error('只允许对 companion.json 执行（防止误碰其它 json）');
    process.exit(1);
  }
  const plain = fs.readFileSync(target, 'utf8');
  const blob = dpapiEncrypt(plain);
  // 先验证能解回来，再落盘
  if (dpapiDecrypt(blob) !== plain) { console.error('加解密校验失败，未写入'); process.exit(1); }
  fs.writeFileSync(encFile, blob, { encoding: 'utf8', mode: 0o600 });
  console.log(`已生成 ${path.basename(encFile)}（${Math.round(blob.length / 1024)} KB）`);
  console.log('明文仍然保留 —— 改完所有读取方之后再手动删。');
} else if (cmd === 'decrypt') {
  if (!fs.existsSync(encFile)) { console.error('没有加密文件'); process.exit(1); }
  const plain = dpapiDecrypt(fs.readFileSync(encFile, 'utf8'));
  fs.writeFileSync(target, plain, 'utf8');
  console.log(`已还原 ${path.basename(target)}`);
} else {
  console.log('用法: status | test --file <副本> | encrypt | decrypt');
  process.exit(1);
}
