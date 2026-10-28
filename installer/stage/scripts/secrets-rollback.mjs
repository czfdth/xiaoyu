#!/usr/bin/env node
// 回滚伴侣配置：把明文恢复回来。**单独一个文件**，不依赖任何其它逻辑。
//
// 为什么单独写：上一次我把"回滚"和"诊断"塞进同一条 PowerShell 命令，
// 命令解析失败时连回滚都没跑，明文一度不存在。安全操作必须是独立、可单独执行的一条命令。
//
// 用法：node scripts/secrets-rollback.mjs

import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from '../src/paths.js';
const COMPANION_FILE = process.env.XIAOYU_COMPANION_CONFIG
  ? path.resolve(process.env.XIAOYU_COMPANION_CONFIG)
  : path.join(APP_ROOT, 'companion.json');

const plain = COMPANION_FILE;
const bak = `${plain}.plain-bak`;
const enc = `${plain}.dpapi`;

const state = () => ({
  plain: fs.existsSync(plain),
  bak: fs.existsSync(bak),
  enc: fs.existsSync(enc),
});

console.log('回滚前:', JSON.stringify(state()));

if (fs.existsSync(plain)) {
  console.log('明文已存在，不需要回滚。');
  process.exit(0);
}
if (!fs.existsSync(bak)) {
  console.error('没有明文也没有备份 —— 只能从 .dpapi 解密恢复，请手动处理。');
  process.exit(1);
}

fs.copyFileSync(bak, plain);
console.log('已从备份恢复:', path.basename(plain));
console.log('回滚后:', JSON.stringify(state()));
