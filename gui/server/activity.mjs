// 活跃度设置：让你（用户）自己调她有多主动，而不是只能改 JSON。
//
// 四个旋钮：
//   proactive.probability        每次"主动机会"真的开口的概率
//   proactive 间隔               两次机会之间等多久
//   privateProbability           私聊里你说话时她被叫醒的概率
//   maxBubbles                   一次回复最多分几条（1=合并成一条，2=允许两条）

import fs from 'node:fs';
import path from 'node:path';
import { readConfig, CONFIG_FILE } from '../../src/paths.js';
import { HttpError } from './guard.mjs';
// 本地小工具：写前备份 + 原子写（data.mjs 里那两个没导出，这里自己实现）
function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const to = file + '.bak-' + stamp;
  try { fs.copyFileSync(file, to); } catch { /* 首次可能没有文件 */ }
  return to;
}

function atomicWrite(file, text) {
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp');
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 把毫秒折成分钟，给界面用。 */
const toMin = (ms) => Math.round(Number(ms) / 60000) || 0;
const toMs = (min) => Math.max(1, Math.round(Number(min) || 0)) * 60000;

/** @returns {{proactive:object, privateProbability:number, maxBubbles:number}} */
export function activityView() {
  const cfg = readConfig();
  const pro = cfg?.socialV2?.proactive ?? {};
  const send = cfg?.socialV2?.send ?? {};
  return {
    enabled: pro.enabled !== false,
    probability: Number(pro.probability ?? 0.2),
    intervalMin: toMin(pro.checkIntervalMinMs ?? 45 * 60000),
    intervalMax: toMin(pro.checkIntervalMaxMs ?? 90 * 60000),
    idleMin: toMin(pro.idleThresholdMs ?? 30 * 60000),
    privateProbability: 0.25,   // 真实值在 social-v2.json，前端只展示建议值
    maxBubbles: Number(send.maxBubbles ?? 1),
  };
}

/**
 * 改活跃度。只接受四个字段，范围都钳制，写前备份 config。
 * @param {{probability?:number, intervalMin?:number, intervalMax?:number, idleMin?:number, maxBubbles?:number}} patch
 */
export function saveActivity(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, '参数必须是对象');
  const cfg = readConfig();
  const next = { ...(cfg.socialV2?.proactive ?? {}) };
  const send = { ...(cfg.socialV2?.send ?? {}) };

  const num = (key, min, max) => {
    if (!(key in patch)) return null;
    const v = Number(patch[key]);
    if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${key} 要在 ${min}~${max}`);
    return v;
  };

  const p = num('probability', 0, 1);
  if (p !== null) next.probability = Math.round(p * 100) / 100;
  const iMin = num('intervalMin', 2, 240);
  if (iMin !== null) next.checkIntervalMinMs = toMs(iMin);
  const iMax = num('intervalMax', 2, 240);
  if (iMax !== null) next.checkIntervalMaxMs = toMs(iMax);
  const idle = num('idleMin', 1, 240);
  if (idle !== null) next.idleThresholdMs = toMs(idle);
  const mb = num('maxBubbles', 1, 4);
  if (mb !== null) send.maxBubbles = Math.trunc(mb);

  // 间隔不能倒挂
  if (Number(next.checkIntervalMaxMs) < Number(next.checkIntervalMinMs)) {
    next.checkIntervalMaxMs = next.checkIntervalMinMs;
  }

  const backupFile = backup(CONFIG_FILE);
  const merged = {
    ...cfg,
    socialV2: {
      ...(cfg.socialV2 ?? {}),
      proactive: next,
      send: { ...(cfg.socialV2?.send ?? {}), ...send },
    },
  };
  atomicWrite(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`);
  return { ok: true, backup: backupFile, activity: activityView() };
}
