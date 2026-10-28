// 内置桌宠：把 dsh-pet 的独立模式（Electron 透明置顶窗）作为管家的一部分来启停。
// 素材/代码来自 dsh-pet（MIT, Copyright (c) 2026 PC2005-cloud）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_ROOT, STATE_DIR, LOGS_DIR } from '../../src/paths.js';

const DIR = path.join(APP_ROOT, 'pet', 'dsh-pet');
const PORT = 3099;
const STATE = path.join(STATE_DIR, 'desktop-pet.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}
function writeState(value) {
  try { fs.writeFileSync(STATE, JSON.stringify(value, null, 2), 'utf8'); } catch { /* ignore */ }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function probe() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function desktopPetStatus() {
  const state = readState();
  const running = Boolean(await probe());
  return {
    installed: fs.existsSync(path.join(DIR, 'lib', 'standalone.js')),
    running,
    port: PORT,
    pid: state?.pid || 0,
    startedAt: state?.startedAt || 0,
    dir: DIR,
  };
}

export async function startDesktopPet() {
  const status = await desktopPetStatus();
  if (!status.installed) {
    const error = new Error('桌宠还没解压到 pet/dsh-pet（先解压 dsh-pet 发行包）');
    error.statusCode = 400;
    throw error;
  }
  if (status.running) return { ok: true, started: false, ...status };

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const out = fs.openSync(path.join(LOGS_DIR, 'dsh-pet.out.log'), 'a');
  const err = fs.openSync(path.join(LOGS_DIR, 'dsh-pet.err.log'), 'a');
  const child = spawn(process.execPath, ['lib/standalone.js', '--port', String(PORT)], {
    cwd: DIR,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  writeState({ pid: child.pid, port: PORT, startedAt: Date.now() });

  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (await probe()) return { ok: true, started: true, ...(await desktopPetStatus()) };
  }
  return { ok: false, started: false, error: '桌宠 10 秒内没起来，看 logs/dsh-pet.err.log', ...(await desktopPetStatus()) };
}

export async function stopDesktopPet() {
  const state = readState();
  try {
    await fetch(`http://127.0.0.1:${PORT}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) });
  } catch { /* 没起或已退出 */ }
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await probe())) break;
  }
  if (alive(state?.pid)) {
    try { spawn('taskkill', ['/PID', String(state.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
  }
  writeState({ pid: 0, port: PORT, startedAt: 0 });
  return { ok: true, running: false, port: PORT };
}
