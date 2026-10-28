#!/usr/bin/env node
// 记忆层快照 / 回滚。
//
// 为什么需要：改记忆结构（加时间有效性、激活扩散）时，一旦改错她就"想不起任何事"。
// 这个脚本在改之前拍一张快照，改完发现不对，一条命令回到原样。
//
// 用法：
//   node scripts/memory-backup.mjs                 # 拍快照
//   node scripts/memory-backup.mjs --list          # 看有哪些快照
//   node scripts/memory-backup.mjs --restore <名>   # 回滚到某次
//
// 快照内容（都在 state/ 下）：memory/、knowledge/、semantic/、life.db

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../src/paths.js';

const ROOT = path.join(STATE_DIR, 'memory-backup');
const TARGETS = ['memory', 'knowledge', 'semantic', 'life.db'];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function copyInto(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyInto(path.join(from, name), path.join(to, name));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function sizeOf(dir) {
  let bytes = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    bytes += st.isDirectory() ? sizeOf(full) : st.size;
  }
  return bytes;
}

const args = process.argv.slice(2);

if (args[0] === '--list') {
  if (!fs.existsSync(ROOT)) { console.log('还没有任何快照'); process.exit(0); }
  for (const name of fs.readdirSync(ROOT).sort().reverse()) {
    const full = path.join(ROOT, name);
    if (!fs.statSync(full).isDirectory()) continue;
    console.log(`${name}  ${(sizeOf(full) / 1048576).toFixed(1)} MB`);
  }
  process.exit(0);
}

if (args[0] === '--restore') {
  const name = args[1];
  if (!name) { console.error('用法: --restore <快照名>'); process.exit(1); }
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) { console.error('没有这个快照:', name); process.exit(1); }
  // 回滚前先把当前状态另存一份，避免"回滚错了再也回不去"
  const safety = path.join(ROOT, 'before-restore-' + stamp());
  fs.mkdirSync(safety, { recursive: true });
  for (const target of TARGETS) {
    const cur = path.join(STATE_DIR, target);
    if (fs.existsSync(cur)) copyInto(cur, path.join(safety, target));
  }
  for (const target of TARGETS) {
    const from = path.join(src, target);
    if (!fs.existsSync(from)) continue;
    const to = path.join(STATE_DIR, target);
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    copyInto(from, to);
  }
  console.log('已回滚到', name);
  console.log('回滚前的状态另存在', 'before-restore-' + stamp() + '（见 --list）');
  process.exit(0);
}

// 拍快照
const name = 'memory-' + stamp();
const dest = path.join(ROOT, name);
fs.mkdirSync(dest, { recursive: true });
const saved = [];
for (const target of TARGETS) {
  const from = path.join(STATE_DIR, target);
  if (!fs.existsSync(from)) continue;
  copyInto(from, path.join(dest, target));
  saved.push(target);
}
const mb = (sizeOf(dest) / 1048576).toFixed(1);
console.log(`快照已保存：${name}（${mb} MB，含 ${saved.join(' / ') || '无'}）`);
console.log('回滚：node scripts/memory-backup.mjs --restore ' + name);
