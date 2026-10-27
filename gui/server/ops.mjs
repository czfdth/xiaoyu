// 面板侧的运维体检：直接读文件 + 按需跑检查，和桥接共用 state/ops-health.json。
//
// 为什么控制台也自己算一份：桥接可能没跑（面板要能告诉人"备份能不能恢复"），
// 而且磁盘/密钥这两项纯属本地读取，不值得绕一圈 HTTP。

import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, STATE_FILES, LOGS_DIR, CONFIG_FILE, COMPANION_CONFIG } from '../../src/paths.js';
import { keyHealth, diskReport, cleanup, restoreDrill, indexHealth } from '../../src/ops.js';

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILES.opsHealth, 'utf8').replace(/^\uFEFF/, '')) ?? {}; } catch { return {}; }
}

function writeState(patch) {
  try {
    const next = { ...readState(), ...patch, updatedAt: Date.now() };
    fs.mkdirSync(path.dirname(STATE_FILES.opsHealth), { recursive: true });
    fs.writeFileSync(STATE_FILES.opsHealth, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch { return readState(); }
}

function logFiles() {
  return ['bridge.log', 'bridge.err.log', 'console.err.log']
    .map((name) => path.join(LOGS_DIR, name))
    .filter((file) => fs.existsSync(file));
}

/** 体检总览（只读，随时可调）。 */
export function opsView() {
  const state = readState();
  let keys = state.keys;
  let disk = state.disk;
  try { disk = diskReport({ home: APP_ROOT }); } catch { /* 用上次的 */ }
  try {
    const live = keyHealth({ configFiles: [COMPANION_CONFIG, CONFIG_FILE].filter(Boolean), logFiles: logFiles() });
    keys = { ...live, at: Date.now() };
  } catch { /* 用上次的 */ }
  return {
    disk,
    keys,
    drill: state.drill ?? null,
    index: state.index ?? null,
    lastReportDay: state.lastReportDay ?? '',
    lastReportText: state.lastReportText ?? '',
    updatedAt: state.updatedAt ?? 0,
  };
}

/**
 * 现场跑一项检查。
 * @param {'keys'|'drill'|'index'|'disk'} task
 */
export async function runOps(task = 'keys') {
  const patch = {};
  if (task === 'keys') {
    patch.keys = {
      ...keyHealth({ configFiles: [COMPANION_CONFIG, CONFIG_FILE].filter(Boolean), logFiles: logFiles() }),
      at: Date.now(),
    };
  } else if (task === 'drill') {
    patch.drill = restoreDrill({ backupDir: path.join(APP_ROOT, 'backups'), tmpRoot: path.join(path.dirname(STATE_FILES.opsHealth), 'tmp') });
  } else if (task === 'index') {
    patch.index = await indexHealth({ indexFile: STATE_FILES.semanticIndex, samples: 10 });
  } else if (task === 'disk') {
    patch.disk = diskReport({ home: APP_ROOT });
  }
  const state = writeState(patch);
  return { ok: true, task, health: { ...opsView(), ...state } };
}

/** 清理旧备份/旧日志（默认只演练不删）。 */
export function runCleanup({ keepBackupDays = 30, keepLogDays = 14, dryRun = true } = {}) {
  return cleanup({ home: APP_ROOT, keepBackupDays, keepLogDays, dryRun });
}
