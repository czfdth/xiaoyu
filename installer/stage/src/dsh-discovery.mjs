// DSH（DeepSeek Harness）发现与注册状态检查。
//
// 为什么需要：bridge 的「大脑」是 DSH，但 DSH 的 Web 端口是**每次启动随机**的
// （实测这台是 63247，而 config 默认写的是 3080），而且新用户可能根本没装。
// 一键部署如果不管这一段，装完就是「面板一切正常，她一条都不回」。
//
// 这里只做三件事：
//   1. 找到正在运行的 DSH 的 baseUrl（配置 > 环境变量 > 进程监听端口 > 3080）
//   2. 判断它是不是真的 DSH（用本地签名的会话 Cookie 打开首页）
//   3. 看 DSH 的 profile 里有没有注册我们的 MCP / preset

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { discoverDshSessionCookie } from './dsh-client.js';

export const MCP_MARKER = '# === qq-bridge MCP BEGIN ===';
export const BUNDLE_NAMES = ['qq-mode-console', 'qq-agent-presets'];

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** 列 DSH 的 profile（desktop / web / …）以及各自是否注册了我们。 */
export function listDshProfiles(home = dshHome()) {
  const dir = path.join(home, 'profiles');
  const out = [];
  for (const entry of safeReaddir(dir)) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const profileDir = path.join(dir, entry.name);
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    const pkgFile = path.join(profileDir, 'package.json');
    const patch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
    const pkg = readJson(pkgFile, {}) ?? {};
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    out.push({
      name: entry.name,
      dir: profileDir,
      hasPatch: fs.existsSync(patchFile),
      hasMcp: patch.includes(MCP_MARKER),
      hasBundles: BUNDLE_NAMES.every((b) => bundles.includes(b)),
      bundles,
      mtime: Math.max(mtimeOf(patchFile), mtimeOf(pkgFile)),
    });
  }
  return out;
}

/**
 * 猜当前在用的是哪个 profile。
 * 优先级：显式 DSH_PROFILE > 已注册我们的 > 有 patch 的 > 名字是 desktop/web > 最近改过的。
 */
export function detectDshProfile(home = dshHome()) {
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;
  const profiles = listDshProfiles(home);
  if (!profiles.length) return '';
  const scored = profiles.map((p) => ({
    p,
    score: (p.hasMcp ? 8 : 0) + (p.hasBundles ? 4 : 0) + (p.hasPatch ? 2 : 0)
      + (p.name === 'desktop' ? 1 : 0) + (p.name === 'web' ? 1 : 0)
      + Math.min(1, p.mtime / Date.now()),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].p.name;
}

export function dshRegistration(home = dshHome(), profile = detectDshProfile(home)) {
  const p = listDshProfiles(home).find((x) => x.name === profile);
  return {
    profile,
    home,
    found: Boolean(p),
    hasMcp: Boolean(p?.hasMcp),
    hasBundles: Boolean(p?.hasBundles),
    registered: Boolean(p?.hasMcp && p?.hasBundles),
  };
}

/** Windows：找 DSH 进程正在监听的环回端口。 */
function listDshPortsWindows() {
  return new Promise((resolve) => {
    const script = [
      "$ids = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DeepSeek|dsh' } | Select-Object -ExpandProperty Id;",
      'if (-not $ids) { ""; exit 0 }',
      "$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and ($_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::1') } | Select-Object -ExpandProperty LocalPort -Unique;",
      '$ports -join ","',
    ].join(' ');
    execFile('powershell', ['-NoProfile', '-Command', script], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) { resolve([]); return; }
      resolve(String(stdout ?? '').trim().split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0));
    });
  });
}

/** 其它平台：lsof 兜底；拿不到就只试常见端口。 */
function listDshPortsPosix() {
  return new Promise((resolve) => {
    execFile('sh', ['-c', "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -Ei 'dsh|deepseek' | awk '{print $9}' | sed 's/.*://'"], { timeout: 4000 }, (error, stdout) => {
      if (error) { resolve([]); return; }
      resolve(String(stdout ?? '').split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0));
    });
  });
}

/** 候选端口，去重后返回。 */
export async function dshPortCandidates(cfg = {}, { scan = true } = {}) {
  const ports = [];
  const push = (n) => { const v = Number(n); if (Number.isInteger(v) && v > 0 && !ports.includes(v)) ports.push(v); };
  const fromCfg = String(cfg?.dsh?.baseUrl ?? '').match(/:(\d+)$/);
  if (fromCfg) push(fromCfg[1]);
  if (process.env.DSH_URL) { const m = String(process.env.DSH_URL).match(/:(\d+)$/); if (m) push(m[1]); }
  if (process.env.DSH_PORT) push(process.env.DSH_PORT);
  push(3080);
  if (scan) {
    const scanned = process.platform === 'win32' ? await listDshPortsWindows() : await listDshPortsPosix();
    for (const p of scanned) push(p);
  }
  return ports;
}

/**
 * 探测一个地址是不是 DSH。
 * 用本地签名 Cookie 打首页：200 + HTML 才算；401 说明要鉴权（也可能就是 DSH，但无法确认）。
 */
export async function probeDsh(baseUrl, { timeoutMs = 1200 } = {}) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!base) return { ok: false, status: 0, error: '空地址' };
  const startedAt = Date.now();
  const cookie = discoverDshSessionCookie(base);
  try {
    const res = await fetch(`${base}/`, {
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    const text = await res.text().catch(() => '');
    const isHtml = /<!doctype html/i.test(text) || /<html/i.test(text);
    const looksDsh = /deepseek|dsh|harness/i.test(text);
    return {
      ok: res.status === 200 && isHtml,
      status: res.status,
      html: isHtml,
      looksDsh,
      hasCookie: Boolean(cookie),
      latencyMs: Date.now() - startedAt,
      baseUrl: base,
    };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message ?? String(error), latencyMs: Date.now() - startedAt, baseUrl: base };
  }
}

/**
 * 一次性发现：端口候选逐个探，返回第一个能确认是 DSH 的。
 * @returns {{ok:boolean, baseUrl?:string, via?:string, profile?:string, registered?:boolean, tried?:Array}}
 */
export async function discoverDsh({ cfg = {}, scan = true, timeoutMs = 1200, home = dshHome() } = {}) {
  const ports = await dshPortCandidates(cfg, { scan });
  const tried = [];
  for (const port of ports) {
    const baseUrl = `http://127.0.0.1:${port}`;
    const probe = await probeDsh(baseUrl, { timeoutMs });
    tried.push({ port, ok: probe.ok, status: probe.status });
    if (probe.ok) {
      const registration = dshRegistration(home);
      return {
        ok: true,
        baseUrl,
        port,
        via: 'listen-scan',
        hasCookie: probe.hasCookie,
        latencyMs: probe.latencyMs,
        registration,
        tried,
      };
    }
  }
  return {
    ok: false,
    error: `没找到在运行的 DSH（试了 ${ports.join(', ')} 这些端口）。`,
    registration: dshRegistration(home),
    tried,
  };
}

/** 把确认可用的 DSH 地址写回 config.json 的 dsh.baseUrl（幂等，保留 BOM）。 */
export function persistDshBaseUrl(cfgPath, baseUrl) {
  const next = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!next) return { updated: false };
  let text = fs.readFileSync(cfgPath, 'utf8');
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  if (hadBom) text = text.slice(1);
  const cfg = JSON.parse(text);
  const current = String(cfg?.dsh?.baseUrl ?? '');
  if (current === next) return { updated: false, from: current, to: next };
  cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: next };
  const serialized = `${JSON.stringify(cfg, null, 2)}\n`;
  fs.writeFileSync(cfgPath, hadBom ? `\uFEFF${serialized}` : serialized, 'utf8');
  return { updated: true, from: current, to: next };
}

/** 给面板/部署用的摘要（不扫进程，只看配置地址；scan=true 时才扫）。 */
export async function dshStatus({ cfg = {}, scan = false, timeoutMs = 900 } = {}) {
  const baseUrl = String(cfg?.dsh?.baseUrl ?? '').replace(/\/+$/, '');
  const registration = dshRegistration();
  if (!baseUrl) {
    return { ok: false, reason: 'not-configured', baseUrl: '', registration };
  }
  const probe = await probeDsh(baseUrl, { timeoutMs });
  return {
    ok: probe.ok,
    reason: probe.ok ? 'ok' : (probe.status === 401 ? 'unauthorized' : 'unreachable'),
    baseUrl,
    status: probe.status,
    latencyMs: probe.latencyMs,
    registration,
  };
}
