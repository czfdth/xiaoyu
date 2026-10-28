// 启停动作：只允许白名单里的三个脚本，参数固定，不让前端传命令。
// 这是整个面板唯一会「动系统」的地方，所以收得很紧。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { APP_ROOT, CODE_ROOT } from '../../src/paths.js';
import { HttpError } from './guard.mjs';

const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';

/**
 * 脚本可能在数据根（正常安装），也可能只在代码根（XIAOYU_HOME 指到别处、
 * 接别人的 state 跑的时候）。先找数据根，再退回代码根。
 */
function resolveScript(relative) {
  const inData = path.join(APP_ROOT, relative);
  if (fs.existsSync(inData)) return inData;
  return path.join(CODE_ROOT, relative);
}

const ACTIONS = {
  start: { script: 'bin/start-all.ps1', args: ['-Quiet'], timeout: 240000, label: '启动全部', hint: '起 SnowLuma 之外的引擎 + 大脑' },
  stop: { script: 'bin/xiaoyu.ps1', args: ['stop'], timeout: 60000, label: '停止大脑', hint: '只停 bridge，网关和引擎不动' },
  restart: { script: 'bin/xiaoyu.ps1', args: ['restart'], timeout: 90000, label: '重启大脑', hint: '改完配置后用这个' },
};

export function actionList() {
  return Object.entries(ACTIONS).map(([name, a]) => ({ name, label: a.label, hint: a.hint }));
}

export function runAction(name) {
  const action = ACTIONS[name];
  if (!action) throw new HttpError(400, '未知操作');
  const script = resolveScript(action.script);

  return new Promise((resolve) => {
    execFile(
      PS,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...action.args],
      { cwd: APP_ROOT, timeout: action.timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          timedOut: error?.killed === true,
          label: action.label,
          output: output.slice(-8000),
        });
      }
    );
  });
}
