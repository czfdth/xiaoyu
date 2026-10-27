#!/usr/bin/env node
// 确保本机 Ollama 在跑。
//
// 为什么需要它：Windows 上装的是 Portable 版（winget 的 Ollama.Ollama.Portable），
// 没有托盘程序、也没有开机自启，重启机器后 11434 就没了 —— 语义检索会静默降级成关键词，
// 看起来像"功能坏了"。这个脚本只做一件事：探端口，不通就拉起 `ollama serve`。
//
// 用法：node scripts/ollama-ensure.mjs          （计划任务每 15 分钟跑一次）
// 环境变量：OLLAMA_BASE（默认 http://127.0.0.1:11434）、OLLAMA_EXE（手工指定 exe）

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = String(process.env.OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

/** 找到 ollama.exe：显式环境变量 > winget 便携包目录 > PATH。 */
function findExe() {
  if (process.env.OLLAMA_EXE && fs.existsSync(process.env.OLLAMA_EXE)) return process.env.OLLAMA_EXE;
  const pkgRoot = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  try {
    const dir = fs.readdirSync(pkgRoot).find((n) => n.startsWith('Ollama.Ollama.Portable'));
    if (dir) {
      const candidate = path.join(pkgRoot, dir, 'ollama.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* 没有 winget 目录就继续往下试 */ }
  for (const p of [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
  ]) {
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}

async function alive(timeoutMs = 1500) {
  try {
    const response = await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const data = await response.json().catch(() => ({}));
    return Boolean(data?.version);
  } catch {
    return false;
  }
}

const up = await alive();
if (up) {
  log(`Ollama 已在跑（${BASE}）`);
  process.exit(0);
}

const exe = findExe();
if (!exe) {
  log('没找到 ollama.exe：装一下 Ollama（winget install Ollama.Ollama），或设 OLLAMA_EXE 指到它');
  process.exitCode = 1;
  process.exit();
}

log(`Ollama 没在跑，拉起：${exe} serve`);
try {
  const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
} catch (error) {
  log(`拉起失败：${error?.message ?? error}`);
  process.exitCode = 1;
  process.exit();
}

// 最多等 30 秒就绪（模型不在内存里时启动很快；这里只等 HTTP，不等模型加载）
for (let i = 0; i < 30; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  if (await alive()) {
    log('已就绪');
    process.exit(0);
  }
}
log('拉起后 30 秒仍不可用，看一眼 OLLAMA_MODELS 和模型目录');
process.exitCode = 1;
