#!/usr/bin/env node
// 安装目录自检修复：把仓库里有、安装目录里缺的文件补回去。
//
// 背景：2026-11-02 发现 %LOCALAPPDATA%\xiaoyu 下丢了 gui\server.mjs、
// gui\package.json 以及全部 .bat —— 控制台就此起不来，桌面快捷方式也点不动。
// 这类"文件静默消失"没法预防（不知道是谁删的），但可以一键补回来。
//
// 用法：
//   node scripts/repair-install.mjs            # 只报告缺什么
//   node scripts/repair-install.mjs --fix      # 真的复制回去

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const INSTALL = process.env.XIAOYU_HOME || path.join(process.env.LOCALAPPDATA, 'xiaoyu');
const FIX = process.argv.includes('--fix');

// 需要同步的目录（递归）与文件（单个）
const DIRS = ['src', 'scripts', 'bin', 'tools', 'roles', 'gui/server', 'gui/shared', 'gui/dist', 'eval', 'tests'];
const FILES = ['package.json', 'uninstall.ps1', 'RELEASE.md'];
const GLOBS = [['.', '.bat']];   // 根目录下的启动脚本

const missing = [];
const copied = [];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  copied.push(path.relative(INSTALL, to));
}

function walk(fromDir, toDir) {
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const src = path.join(fromDir, entry.name);
    const dst = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(src, dst);
    } else if (!fs.existsSync(dst)) {
      missing.push(path.relative(INSTALL, dst));
      if (FIX) copyFile(src, dst);
    }
  }
}

for (const d of DIRS) {
  const from = path.join(REPO, d);
  if (!fs.existsSync(from)) continue;
  walk(from, path.join(INSTALL, d));
}

for (const f of FILES) {
  const from = path.join(REPO, f);
  const to = path.join(INSTALL, f);
  if (fs.existsSync(from) && !fs.existsSync(to)) {
    missing.push(f);
    if (FIX) copyFile(from, to);
  }
}

for (const [dir, ext] of GLOBS) {
  const from = path.join(REPO, dir);
  for (const name of fs.readdirSync(from)) {
    if (!name.endsWith(ext)) continue;
    const to = path.join(INSTALL, name);
    if (!fs.existsSync(to)) {
      missing.push(name);
      if (FIX) copyFile(path.join(from, name), to);
    }
  }
}

if (!missing.length) {
  console.log(`安装目录完整（${INSTALL}）`);
} else {
  console.log(`缺少 ${missing.length} 个文件：`);
  for (const m of missing.slice(0, 40)) console.log('  ' + m);
  if (missing.length > 40) console.log(`  … 还有 ${missing.length - 40} 个`);
  if (FIX) console.log(`\n已补回 ${copied.length} 个文件`);
  else console.log('\n加 --fix 可自动补回');
}
