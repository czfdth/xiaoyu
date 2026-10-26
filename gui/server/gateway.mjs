// QQ 网关（SnowLuma）状态与「用户点击后启动」。
//
// 边界（项目不变量 L6 + SnowLuma EULA 2.2/5.4）：
//   · 不随包分发、不替用户安装、不静默启动
//   · 只有用户在面板里显式确认后，才打开他**已经装好**的 launcher.bat
//   · 登录/扫码始终由用户完成

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { LOGS_DIR, readConfig } from '../../src/paths.js';

function portOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function logLine(text) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOGS_DIR, 'gateway.log'),
      `[${new Date().toISOString()}] ${text}\n`, 'utf8');
  } catch { /* 日志写不进去不影响主流程 */ }
}

/** 只读：装没装、哪个版本、跑没跑、EULA 在不在、有没有配置下载地址。 */
export async function gatewayState() {
  const cfg = readConfig();
  const home = String(cfg.engines?.snowluma?.home || '').trim() || path.join(os.homedir(), 'SnowLuma');
  const launcher = path.join(home, 'launcher.bat');
  const installed = fs.existsSync(launcher);

  let version = '';
  try { version = String(JSON.parse(fs.readFileSync(path.join(home, 'release.json'), 'utf8')).version || ''); } catch { /* 没装或格式不对 */ }

  let port = 3000;
  try { port = Number(new URL(String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000')).port) || 3000; } catch { /* 用默认 */ }
  const running = await portOpen(port);

  // SnowLuma 的 WebUI 默认 5099（被占时自己换 5100）。
  // 它开着但没登录时 OneBot 的 3000/3001 不会监听——这种情况不能再开新实例，
  // 否则新实例抢不到 5099/单实例锁，会立刻退出（实测连点 4 次都这样）。
  let uiPort = 0;
  for (const candidate of [5099, 5100]) {
    if (await portOpen(candidate)) { uiPort = candidate; break; }
  }
  const appRunning = running || uiPort > 0;

  return {
    installed,
    home,
    launcher,
    version,
    running,
    port,
    appRunning,
    uiPort,
    webuiUrl: uiPort ? `http://127.0.0.1:${uiPort}` : '',
    waitingLogin: appRunning && !running,
    eula: fs.existsSync(path.join(home, 'EULA.md')) ? path.join(home, 'EULA.md') : '',
    downloadUrl: String(cfg.snowluma?.downloadUrl || '') || 'https://github.com/FrostNova-Labs/SnowLuma/releases',
  };
}

/** 用户显式确认后，打开已安装的 SnowLuma（不安装、不下载）。 */
export async function launchGateway({ dryRun = false } = {}) {
  const state = await gatewayState();
  if (!state.installed) {
    const error = new Error('没检测到 SnowLuma（launcher.bat 不存在）。它不能随包分发，请先自行下载并同意 EULA。');
    error.statusCode = 400;
    throw error;
  }
  if (state.running) return { started: false, reason: 'already-running', ...state };
  if (state.appRunning) return { started: false, reason: 'waiting-login', ...state };
  if (dryRun) return { started: false, reason: 'dry-run', launcher: state.launcher, home: state.home };

  // 用 start 打开一个新的控制台窗口：launcher.bat 里的 pause 需要可见窗口，扫码也在那里。
  spawn('cmd.exe', ['/c', 'start', '', 'launcher.bat'], {
    cwd: state.home,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();

  logLine(`用户点击启动 SnowLuma：${state.launcher}`);
  return { started: true, launcher: state.launcher, home: state.home };
}
