// 局域网访问：让手机也能看她的状态，但**必须带口令**。
//
// 安全前提（想清楚再改）：
//   · 默认关闭，默认仍只绑 127.0.0.1；
//   · 开启后必须设置口令（至少 12 位），口令用 scrypt 存哈希，不落明文；
//   · 非本机请求一律要会话 Cookie；默认**只读**（GET），写操作要显式打开 allowWrite；
//   · 会话 Cookie 用 HMAC 签名，7 天过期。

import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, STATE_DIR, readConfig } from '../../src/paths.js';

const SECRET_FILE = path.join(STATE_DIR, 'remote-secret');
export const SESSION_COOKIE = 'xy_session';
export const SESSION_DAYS = 7;
export const MIN_PASSWORD = 12;

export function loadRemoteConfig(cfg = readConfig()) {
  const raw = cfg?.remote && typeof cfg.remote === 'object' ? cfg.remote : {};
  return {
    enabled: raw.enabled === true,
    port: Number(raw.port) > 0 ? Number(raw.port) : 8765,
    host: String(raw.host ?? ''),
    allowWrite: raw.allowWrite === true,
    passwordHash: String(raw.passwordHash ?? ''),
    hasPassword: Boolean(raw.passwordHash),
    passwordAt: Number(raw.passwordAt) || 0,
  };
}

function secret() {
  try {
    const text = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (text.length >= 32) return text;
  } catch { /* 还没生成 */ }
  const next = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, next, { encoding: 'utf8', mode: 0o600 });
  } catch { /* 写不进去就每次重启换一个（人得重新登录，不影响安全） */ }
  return next;
}

/** scrypt 哈希：salt$hash（都是 hex）。 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored ?? '').split('$');
  if (!saltHex || !hashHex) return false;
  try {
    const derived = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch { return false; }
}

/** 签发会话：exp.nonce.hmac。 */
/**
 * 密码指纹：哈希的前 12 位，塞进会话签名。
 * 目的：改密码之后，之前签出去的 Cookie 立刻失效（安全审查 P1-03）。
 * 用哈希而不是明文，不泄露可逆信息。
 */
function passwordFingerprint() {
  try {
    const cfg = loadRemoteConfig();
    const hash = String(cfg && cfg.passwordHash ? cfg.passwordHash : "");
    if (!hash) return "none";
    return crypto.createHash("sha256").update(hash).digest("hex").slice(0, 12);
  } catch {
    return "none";
  }
}

export function signSession(now = Date.now()) {
  const exp = now + SESSION_DAYS * 86400000;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${exp}.${nonce}.${passwordFingerprint()}`;
  const mac = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

export function verifySession(cookie, now = Date.now()) {
  const parts = String(cookie ?? "").split(".");
  // 新格式 exp.nonce.fp.mac（4 段）。旧格式 3 段一律判失效：改密码后旧 Cookie 必须作废。
  if (parts.length !== 4) return false;
  const [exp, nonce, fp, mac] = parts;
  if (!Number(exp) || Number(exp) < now) return false;
  if (fp !== passwordFingerprint()) return false;
  const payload = `${exp}.${nonce}.${fp}`;
  const expect = crypto.createHmac("sha256", secret()).update(payload).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expect, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}


export function isLoopback(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

/** 本机的局域网地址（给面板显示用）。 */
export function lanAddresses() {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list ?? []) {
        if (item.family !== 'IPv4' || item.internal) continue;
        out.push(item.address);
      }
    }
  } catch { /* 拿不到就当没有 */ }
  return out;
}

export const REMOTE_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  maxAge: SESSION_DAYS * 86400,
};
