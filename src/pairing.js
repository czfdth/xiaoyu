// 首次配对（一键部署的最后一步）。
//
// 新用户装完后没有 ownerQQ，白名单也是空的 —— 她不会回任何人，界面上看起来像"没反应"。
// 让用户去手写 config.json 是最容易劝退的一步，所以这里换成一个 6 位配对码：
//
//   部署脚本生成码 → 用户用自己的 QQ 私聊她，发这 6 位 → 桥接把发送者认成主人，
//   写进 config.json 的 ownerQQ + allow.private，然后回一句"配对成功"。
//
// 约束（都是安全边界，不要放松）：
//   · 只在**还没有主人**时接受配对（已有 ownerQQ 就完全不看配对码）
//   · 只认私聊，群里发码无效
//   · 15 分钟过期；错 5 次作废；成功后立刻删掉码
//   · 码是 6 位随机数字，不落日志（只记录"配对成功 / 失败次数"）

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PAIRING_TTL_MS = 15 * 60 * 1000;
export const PAIRING_MAX_ATTEMPTS = 5;

/** 6 位随机数字（避开 000000 这种明显值）。 */
export function randomPairingCode() {
  return String(crypto.randomInt(100000, 1000000));
}

export function createPairing({ ttlMs = PAIRING_TTL_MS, code = randomPairingCode() } = {}) {
  const now = Date.now();
  return {
    code: String(code),
    createdAt: now,
    expiresAt: now + ttlMs,
    attempts: 0,
    maxAttempts: PAIRING_MAX_ATTEMPTS,
  };
}

function isPairing(value) {
  return Boolean(value)
    && typeof value === 'object'
    && /^\d{6}$/.test(String(value.code ?? ''))
    && Number.isFinite(Number(value.expiresAt));
}

export function loadPairing(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return isPairing(state) ? state : null;
  } catch {
    return null;
  }
}

export function savePairing(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function clearPairing(file) {
  try { fs.unlinkSync(file); } catch { /* 已经没了 */ }
}

/** 给界面用：还剩多久、还能错几次。 */
export function pairingStatus(state, now = Date.now()) {
  if (!isPairing(state)) return { active: false, reason: 'none' };
  if (now > Number(state.expiresAt)) return { active: false, reason: 'expired' };
  return {
    active: true,
    expiresAt: Number(state.expiresAt),
    remainingMs: Number(state.expiresAt) - now,
    attemptsLeft: Math.max(0, Number(state.maxAttempts ?? PAIRING_MAX_ATTEMPTS) - Number(state.attempts ?? 0)),
  };
}

/** 校验用户发来的码。不改状态（失败计数由 recordFailure 负责）。 */
export function checkPairing(state, input, now = Date.now()) {
  if (!isPairing(state)) return { ok: false, reason: 'none' };
  if (now > Number(state.expiresAt)) return { ok: false, reason: 'expired' };
  const code = String(input ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'format' };
  if (code !== String(state.code)) return { ok: false, reason: 'mismatch' };
  return { ok: true, reason: 'ok' };
}

/** 记一次失败；返回新的状态与是否已作废。 */
export function recordFailure(state) {
  const next = { ...state, attempts: Number(state.attempts ?? 0) + 1 };
  const max = Number(next.maxAttempts ?? PAIRING_MAX_ATTEMPTS);
  return { state: next, locked: next.attempts >= max, attemptsLeft: Math.max(0, max - next.attempts) };
}

/**
 * 一次私聊消息该不该触发配对 —— 决策全在这里，桥接只负责回执和写配置。
 * 返回 action：ignore（不管）/ expired（过期，应删码）/ fail（码不对，需记一次）
 *              / pair（配对成功）
 */
export function decidePairing({ hasOwner = false, state = null, input = '', now = Date.now() } = {}) {
  if (hasOwner) return { action: 'ignore', reason: 'has-owner' };
  if (!isPairing(state)) return { action: 'ignore', reason: 'none' };
  if (now > Number(state.expiresAt)) return { action: 'expired' };
  const result = checkPairing(state, input, now);
  if (result.ok) return { action: 'pair' };
  if (result.reason !== 'mismatch' && result.reason !== 'format') return { action: 'ignore', reason: result.reason };
  const failure = recordFailure(state);
  return { action: 'fail', locked: failure.locked, attemptsLeft: failure.attemptsLeft, state: failure.state };
}
