// 数据层：把磁盘上的 config / state / roles 读成前端能用的形状。
// 只认 src/paths.js 给的路径；写操作一律先备份。

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APP_ROOT,
  STATE_DIR,
  STATE_FILES,
  ROLES_DIR,
  LOGS_DIR,
  CONFIG_FILE,
  PORTS,
  readConfig,
  configExists,
  detectEngines,
  capabilities,
  resetEngineCache,
} from '../../src/paths.js';
import { HttpError, assertSafeName, normalizeIdList, normalizeQQ } from './guard.mjs';
import { createAlertCenter } from '../../src/alerts.js';
import { normalizeLimits, shouldBlockAutonomous, loadDaily } from '../../src/usage-budget.js';
import { loadRemoteConfig, lanAddresses, hashPassword, MIN_PASSWORD } from './remote.js';
import { createOneBotHttp } from '../../src/snowluma/index.js';
import { createPairing, loadPairing, savePairing, clearPairing, pairingStatus } from '../../src/pairing.js';
import { dshStatus, discoverDsh, persistDshBaseUrl } from '../../src/dsh-discovery.mjs';
import { lifeView } from './life.mjs';
import { gatewayState } from './gateway.mjs';

// ── 基础工具 ────────────────────────────────────────────────────────────────
function stripBom(text) { return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; }

function readJson(file, fallback) {
  try { return JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))); } catch { return fallback; }
}

function readText(file, fallback = '') {
  try { return stripBom(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function statOf(file) {
  try {
    const s = fs.statSync(file);
    return { mtime: s.mtimeMs, size: s.size };
  } catch { return { mtime: 0, size: 0 }; }
}

function listFiles(dir, re) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => ({ name: f, ...statOf(path.join(dir, f)) }));
  } catch { return []; }
}

function localDay(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** 写文件前留一份快照，最多留 20 份同名备份。 */
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.bak-${stamp()}`;
  try { fs.copyFileSync(file, dest); } catch { return null; }
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const snaps = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
    for (const f of snaps.slice(0, Math.max(0, snaps.length - 20))) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* 清理失败不影响主流程 */ }
  return dest;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function portOpen(port, timeout = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(timeout);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function probeAll() {
  const out = {};
  for (const [name, port] of Object.entries(PORTS)) out[name] = await portOpen(port);
  return out;
}

// ── 配置 ────────────────────────────────────────────────────────────────────
export function configWarnings(cfg = readConfig()) {
  const warnings = [];
  if (!configExists()) warnings.push('还没有 config.json（运行 node src/paths.js --init）');
  if (!cfg.ownerQQ) warnings.push('ownerQQ 没填：审批、管理命令、封闭模式都不可用');
  if (!(cfg.allow?.private ?? []).length && !(cfg.allow?.groups ?? []).length) {
    warnings.push('allow 白名单是空的：她不会回任何消息');
  }
  if (!(cfg.snowluma?.accessToken ?? '')) warnings.push('snowluma.accessToken 没填：连不上 QQ 网关');
  return warnings;
}

const MASK = '••••••';

/** 前端能看的配置：密钥一律只给「有没有」，不给出内容。 */
export function configView() {
  const cfg = readConfig();
  return {
    file: CONFIG_FILE,
    exists: configExists(),
    ownerQQ: cfg.ownerQQ ?? null,
    allow: { private: cfg.allow?.private ?? [], groups: cfg.allow?.groups ?? [] },
    deny: { private: cfg.deny?.private ?? [], groups: cfg.deny?.groups ?? [] },
    snowluma: {
      httpUrl: cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000',
      wsUrl: cfg.snowluma?.wsUrl ?? 'ws://127.0.0.1:3001',
      hasToken: Boolean(cfg.snowluma?.accessToken),
      tokenHint: cfg.snowluma?.accessToken ? MASK : '',
    },
    dsh: {
      baseUrl: cfg.dsh?.baseUrl ?? 'http://127.0.0.1:3080',
      provider: cfg.dsh?.provider ?? 'deepseek-official',
      model: cfg.dsh?.model ?? 'deepseek-flash',
      authHeader: cfg.dsh?.authHeader ?? 'authorization',
    },
    engines: cfg.engines ?? {},
    consolePort: cfg.consolePort ?? PORTS.bridge,
    warnings: configWarnings(cfg),
  };
}

/** 改配置：只接受白名单字段，合并进现有 config，先备份再原子写。 */
export function saveConfig(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, '配置必须是对象');
  const cfg = readConfig();
  const next = { ...cfg };

  if ('ownerQQ' in patch) next.ownerQQ = normalizeQQ(patch.ownerQQ);
  if ('allow' in patch) {
    next.allow = {
      ...(cfg.allow ?? {}),
      private: normalizeIdList(patch.allow?.private ?? []),
      groups: normalizeIdList(patch.allow?.groups ?? []),
    };
  }
  if ('deny' in patch) {
    next.deny = {
      ...(cfg.deny ?? {}),
      private: normalizeIdList(patch.deny?.private ?? []),
      groups: normalizeIdList(patch.deny?.groups ?? []),
    };
  }
  if ('snowluma' in patch) {
    const s = patch.snowluma ?? {};
    next.snowluma = { ...(cfg.snowluma ?? {}) };
    if (typeof s.httpUrl === 'string' && s.httpUrl.trim()) next.snowluma.httpUrl = s.httpUrl.trim().replace(/\/+$/, '');
    if (typeof s.wsUrl === 'string' && s.wsUrl.trim()) next.snowluma.wsUrl = s.wsUrl.trim();
    // 空字符串 / 占位符 = 不改；新值才写入
    if (typeof s.accessToken === 'string' && s.accessToken && s.accessToken !== MASK) {
      next.snowluma.accessToken = s.accessToken.trim();
    }
  }
  if ('dsh' in patch) {
    const d = patch.dsh ?? {};
    next.dsh = { ...(cfg.dsh ?? {}) };
    if (typeof d.baseUrl === 'string' && d.baseUrl.trim()) next.dsh.baseUrl = d.baseUrl.trim().replace(/\/+$/, '');
    if (typeof d.provider === 'string' && d.provider.trim()) next.dsh.provider = d.provider.trim();
    if (typeof d.model === 'string' && d.model.trim()) next.dsh.model = d.model.trim();
    if (typeof d.authHeader === 'string' && d.authHeader.trim()) next.dsh.authHeader = d.authHeader.trim();
  }
  if ('engines' in patch) {
    const e = patch.engines ?? {};
    next.engines = { ...(cfg.engines ?? {}) };
    for (const key of ['aiVoice', 'snowluma', 'gptSovits', 'comfyui', 'rvc', 'ffmpeg', 'gptSovitsPython', 'comfyuiPython', 'rvcPython']) {
      if (typeof e[key] === 'string') next.engines[key] = e[key].trim();
    }
  }
  if ('consolePort' in patch) {
    const p = Number(patch.consolePort);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new HttpError(400, 'consolePort 要在 1024~65535');
    next.consolePort = p;
  }

  const backupFile = backup(CONFIG_FILE);
  atomicWrite(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
  resetEngineCache();
  return { ok: true, backup: backupFile, config: configView() };
}

/** 只换控制台头像：校验图片确实存在，再写 config.ui.avatar。 */
export function saveAvatar(name) {
  const raw = String(name ?? '').trim();
  const safe = path.basename(raw);
  if (!safe || safe !== raw.replace(/\\/g, '') || !/\.(png|jpe?g|webp|gif|bmp)$/i.test(safe)) {
    throw new HttpError(400, '图片名不合法');
  }
  const full = path.join(APP_ROOT, 'images', safe);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new HttpError(404, '这张图不存在');
  const cfg = readConfig();
  const next = { ...cfg, ui: { ...(cfg.ui ?? {}), avatar: safe } };
  const backupFile = backup(CONFIG_FILE);
  atomicWrite(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, avatar: safe, backup: backupFile };
}

/** 只改 socialV2.tools 里的开关；写前备份。 */
export function saveToolFlags(flags = {}) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) throw new HttpError(400, 'tools 必须是对象');
  const cfg = readConfig();
  const next = { ...cfg, socialV2: { ...(cfg.socialV2 ?? {}) } };
  const tools = { ...(cfg.socialV2?.tools ?? {}) };
  for (const [key, value] of Object.entries(flags)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw new HttpError(400, `开关名不合法：${key}`);
    if (typeof value !== 'boolean') throw new HttpError(400, '开关值必须是布尔');
    tools[key] = value;
  }
  next.socialV2.tools = tools;
  const backupFile = backup(CONFIG_FILE);
  atomicWrite(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
  resetEngineCache();
  return { ok: true, backup: backupFile, tools };
}

/** 单独停用/启用一个工具（所有工具都能用，不依赖它有没有 flag）。 */
export function saveToolDisabled(name, disabled) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name)) throw new HttpError(400, '工具名不合法');
  if (typeof disabled !== 'boolean') throw new HttpError(400, 'disabled 必须是布尔');
  const cfg = readConfig();
  const next = { ...cfg, socialV2: { ...(cfg.socialV2 ?? {}) } };
  const list = new Set(Array.isArray(cfg.socialV2?.disabledTools) ? cfg.socialV2.disabledTools : []);
  if (disabled) list.add(name); else list.delete(name);
  next.socialV2.disabledTools = [...list].sort();
  const disabledAt = { ...(cfg.socialV2?.toolDisabledAt ?? {}) };
  if (disabled) {
    if (!disabledAt[name]) disabledAt[name] = new Date().toISOString();
  } else {
    delete disabledAt[name];
  }
  next.socialV2.toolDisabledAt = disabledAt;
  const backupFile = backup(CONFIG_FILE);
  atomicWrite(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
  resetEngineCache();
  return { ok: true, backup: backupFile, disabledTools: next.socialV2.disabledTools };
}

/** 上下文预算：只写 socialV2.context 里的几个刹车值，0 表示关闭对应那一项。 */
export function saveContextBudget(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, '预算必须是对象');
  const pick = (key, min, max) => {
    if (!(key in patch)) return null;
    const n = Number(patch[key]);
    if (!Number.isFinite(n)) throw new HttpError(400, `${key} 必须是数字`);
    const i = Math.trunc(n);
    if (i < min || i > max) throw new HttpError(400, `${key} 要在 ${min}~${max}`);
    return i;
  };
  const maxStepsPerTurn = pick('maxStepsPerTurn', 0, 500);
  const rotatePromptTokens = pick('rotatePromptTokens', 0, 2_000_000);
  const rotateMinTurns = pick('rotateMinTurns', 0, 1000);
  const idleRotateAfterMs = pick('idleRotateAfterMs', 0, 24 * 60 * 60 * 1000);
  const idleRotateTokens = pick('idleRotateTokens', 0, 2_000_000);
  const repeatToolLimit = pick('repeatToolLimit', 0, 20);
  if ([maxStepsPerTurn, rotatePromptTokens, rotateMinTurns, idleRotateAfterMs, idleRotateTokens, repeatToolLimit]
    .every((v) => v == null)) {
    throw new HttpError(400, '没有可保存的预算项');
  }
  const cfg = readConfig();
  const next = { ...cfg, socialV2: { ...(cfg.socialV2 ?? {}) } };
  const context = { ...(cfg.socialV2?.context ?? {}) };
  if (maxStepsPerTurn != null) context.maxStepsPerTurn = maxStepsPerTurn;
  if (rotatePromptTokens != null) context.rotatePromptTokens = rotatePromptTokens;
  if (rotateMinTurns != null) context.rotateMinTurns = rotateMinTurns;
  if (idleRotateAfterMs != null) context.idleRotateAfterMs = idleRotateAfterMs;
  if (idleRotateTokens != null) context.idleRotateTokens = idleRotateTokens;
  if (repeatToolLimit != null) context.repeatToolLimit = repeatToolLimit;
  next.socialV2.context = context;
  const backupFile = backup(CONFIG_FILE);
  atomicWrite(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
  resetEngineCache();
  return {
    ok: true,
    backup: backupFile,
    budget: contextBudgetOf(context),
  };
}

/** 把 socialV2.context 里的预算字段读成面板要的形状（缺省值与 src/context-budget.js 保持一致）。 */export function contextBudgetOf(context = {}) {
  return {
    maxStepsPerTurn: Number(context.maxStepsPerTurn ?? 30),
    rotatePromptTokens: Number(context.rotatePromptTokens ?? 45000),
    rotateMinTurns: Number(context.rotateMinTurns ?? 5),
    idleRotateAfterMs: Number(context.idleRotateAfterMs ?? 20 * 60 * 1000),
    idleRotateTokens: Number(context.idleRotateTokens ?? 35000),
    repeatToolLimit: Number(context.repeatToolLimit ?? 2),
  };
}

/** 界面皮肤：读 config.skin（缺省值兜底），给前端一套跨设备一致的设置。 */
export function skinView() {
  const cfg = readConfig();
  const raw = cfg?.skin && typeof cfg.skin === 'object' ? cfg.skin : {};
  return {
    enabled: raw.enabled !== false,
    veil: Number.isFinite(Number(raw.veil)) ? Math.min(0.8, Math.max(0, Number(raw.veil))) : 0.14,
    boot: raw.boot !== false,
    sound: raw.sound !== false,
  };
}

/** 写皮肤设置：只认这四个字段，值做范围钳制；写前备份 config。 */
export function saveSkin(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, '参数必须是对象');
  const next = skinView();
  if ('enabled' in patch) next.enabled = patch.enabled === true;
  if ('boot' in patch) next.boot = patch.boot === true;
  if ('sound' in patch) next.sound = patch.sound === true;
  if ('veil' in patch) {
    const veil = Number(patch.veil);
    if (!Number.isFinite(veil) || veil < 0 || veil > 0.8) throw new HttpError(400, 'veil 要在 0~0.8');
    next.veil = Math.round(veil * 100) / 100;
  }
  const cfg = readConfig();
  const backupFile = backup(CONFIG_FILE);
  atomicWrite(CONFIG_FILE, `${JSON.stringify({ ...cfg, skin: next }, null, 2)}\n`);
  resetEngineCache();
  return { ok: true, backup: backupFile, skin: next };
}

/** 手机访问：当前设置 + 本机局域网地址（只给本机看，远程请求会被上面拦掉）。 */
export function remoteView() {
  const cfg = loadRemoteConfig();
  return {
    enabled: cfg.enabled,
    port: cfg.port,
    allowWrite: cfg.allowWrite,
    hasPassword: cfg.hasPassword,
    passwordAt: cfg.passwordAt,
    lan: lanAddresses(),
    minPassword: MIN_PASSWORD,
  };
}

/** 开启/关闭手机访问、改口令（口令只存 scrypt 哈希）。 */
export function saveRemoteConfig(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, '参数必须是对象');
  const cfg = readConfig();
  const next = { ...cfg, remote: { ...(cfg.remote ?? {}) } };
  if ('enabled' in patch) next.remote.enabled = patch.enabled === true;
  if ('allowWrite' in patch) next.remote.allowWrite = patch.allowWrite === true;
  if (patch.port != null) {
    const port = Number(patch.port);
    if (!Number.isFinite(port) || port < 1024 || port > 65535) throw new HttpError(400, '端口要在 1024~65535');
    next.remote.port = Math.trunc(port);
  }
  if (patch.password != null) {
    const password = String(patch.password);
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少要 ${MIN_PASSWORD} 位`);
    next.remote.passwordHash = hashPassword(password);
    next.remote.passwordAt = Date.now();
  }
  if (next.remote.enabled && !next.remote.passwordHash) throw new HttpError(400, '开启前先设置口令');
  const backupFile = backup(CONFIG_FILE);
  atomicWrite(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
  resetEngineCache();
  return { ok: true, backup: backupFile, remote: remoteView(), restartHint: '改完要重启控制台（或她的管家）才生效' };
}

/** 日预算视图：今天花了多少、主动了几次、上限是多少、现在有没有被拦。 */
export function usageBudgetView() {
  const cfg = readConfig();
  const daily = loadDaily(STATE_FILES.usageDaily);
  const limits = normalizeLimits(cfg.limits);
  const verdict = shouldBlockAutonomous({
    usedTokens: daily.tokens,
    proactiveCount: daily.proactive,
    limits,
  });
  return {
    day: daily.day,
    tokens: daily.tokens,
    proactive: daily.proactive,
    limits,
    blocked: verdict.block,
    reason: verdict.reason,
    updatedAt: daily.updatedAt,
  };
}

/** 写日预算：只改 limits.dailyTokens / proactivePerDay，0 表示不限。 */
export function saveUsageLimits(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, '预算必须是对象');
  const pick = (key, max) => {
    if (!(key in patch)) return null;
    const n = Number(patch[key]);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${key} 要在 0~${max}`);
    return Math.trunc(n);
  };
  const dailyTokens = pick('dailyTokens', 1_000_000_000);
  const proactivePerDay = pick('proactivePerDay', 10_000);
  if (dailyTokens == null && proactivePerDay == null) throw new HttpError(400, '没有可保存的项');
  const cfg = readConfig();
  const next = { ...cfg, limits: { ...(cfg.limits ?? {}) } };
  if (dailyTokens != null) next.limits.dailyTokens = dailyTokens;
  if (proactivePerDay != null) next.limits.proactivePerDay = proactivePerDay;
  const backupFile = backup(CONFIG_FILE);
  atomicWrite(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
  resetEngineCache();
  return { ok: true, backup: backupFile, budget: usageBudgetView() };
}

export function runSetup(payload = {}) {
  return saveConfig({    ownerQQ: payload.ownerQQ,
    allow: { private: payload.private ?? [], groups: payload.groups ?? [] },
    snowluma: { accessToken: payload.token ?? '' },
    dsh: payload.dshBaseUrl ? { baseUrl: payload.dshBaseUrl } : {},
  });
}
// ── 她 ──────────────────────────────────────────────────────────────────────
export function herState() {
  const inner = readJson(STATE_FILES.inner, {});
  const body = readJson(STATE_FILES.body, {});
  const mood = readJson(STATE_FILES.mood, {});
  const role = readJson(STATE_FILES.role, {});
  return {
    inner: {
      doing: inner.doing ?? '',
      thinking: inner.thinking ?? '',
      worrying: inner.worrying ?? '',
      lastTopic: inner.lastTopic ?? '',
      curious: inner.curious ?? '',
      mood: inner.mood ?? '',
    },
    body: {
      sleepy: Number(body.sleepy ?? 0),
      hungry: Number(body.hungry ?? 0),
      cold: Number(body.cold ?? 0),
      tired: Number(body.tired ?? 0),
      note: body.note ?? '',
    },
    mood: { mood: mood.mood ?? '', why: mood.why ?? '', at: mood.at ?? null },
    role: role.role ?? '',
  };
}

export function journal(day) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day ?? '')) ? day : localDay(0);
  const file = path.join(STATE_FILES.journalDir, `${d}.jsonl`);
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { rows = []; }
  return {
    day: d,
    exists: rows.length > 0,
    messages: rows.slice(-300).map((r) => ({
      t: r.t ?? 0,
      role: r.role === 'her' ? 'her' : 'owner',
      text: String(r.text ?? ''),
      sender: r.sender ?? '',
      key: r.key ?? '',
    })),
  };
}

export function journalDays(limit = 30) {
  return listFiles(STATE_FILES.journalDir, /^\d{4}-\d{2}-\d{2}\.jsonl$/)
    .map((f) => f.name.replace(/\.jsonl$/, ''))
    .sort()
    .reverse()
    .slice(0, limit);
}

export function journalSearch(q, limit = 50) {
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return { query: '', items: [] };
  const items = [];
  for (const day of journalDays(90)) {
    const { messages } = journal(day);
    messages.forEach((m, i) => {
      if (!String(m.text ?? '').toLowerCase().includes(needle)
        && !String(m.sender ?? '').toLowerCase().includes(needle)) return;
      items.push({ day, i, ...m });
    });
  }
  items.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  return { query: q, items: items.slice(0, limit) };
}

// ── 记忆 ────────────────────────────────────────────────────────────────────
const MEMORY_KINDS = new Set(['diary', 'memoir', 'dreams', 'fantasies', 'knowledge']);

function jsonlRows(file) {
  return readText(file).split('\n').filter(Boolean).map((line, i) => {
    try { return { i, ...JSON.parse(line) }; } catch { return null; }
  }).filter(Boolean);
}

export function memoryList(kind) {
  if (!MEMORY_KINDS.has(kind)) throw new HttpError(400, '未知的记忆类型');
  if (kind === 'diary') {
    return listFiles(STATE_FILES.diaryDir, /\.md$/).sort((a, b) => b.name.localeCompare(a.name))
      .map((f) => ({ id: f.name, title: f.name.replace(/\.md$/, ''), ...f }));
  }
  if (kind === 'memoir') {
    return listFiles(STATE_FILES.memoirDir, /\.md$/).sort((a, b) => b.name.localeCompare(a.name))
      .map((f) => ({ id: f.name, title: f.name.replace(/\.md$/, ''), ...f }));
  }
  if (kind === 'knowledge') {
    return jsonlRows(STATE_FILES.knowledgeIndex).reverse().map((r) => ({
      id: String(r.id ?? r.i),
      title: r.title || '一条知识',
      at: r.createdAt ?? 0,
      tags: Array.isArray(r.tags) ? r.tags : [],
      excerpt: String(r.text ?? '').slice(0, 80),
    }));
  }
  const file = kind === 'dreams' ? STATE_FILES.dreams : STATE_FILES.fantasies;
  const rows = jsonlRows(file);
  return rows.reverse().map((r) => ({
    id: String(r.id ?? r.i),
    title: kind === 'dreams' ? (r.feel || '一个梦') : (r.tag || '幻想'),
    at: r.at ?? 0,
    excerpt: String(r.dream ?? r.text ?? '').slice(0, 80),
    ...statOf(file),
  }));
}

export function memoryRead(kind, id) {
  if (!MEMORY_KINDS.has(kind)) throw new HttpError(400, '未知的记忆类型');
  if (kind === 'diary' || kind === 'memoir') {
    const name = assertSafeName(id, '文件名');
    if (!/\.md$/.test(name)) throw new HttpError(400, '只读 .md');
    const dir = kind === 'diary' ? STATE_FILES.diaryDir : STATE_FILES.memoirDir;
    const full = path.join(dir, name);
    const content = readText(full, null);
    if (content === null) throw new HttpError(404, '没找到这篇');
    return { kind, id: name, content, ...statOf(full) };
  }
  if (kind === 'knowledge') {
    const row = jsonlRows(STATE_FILES.knowledgeIndex).find((r) => String(r.id ?? r.i) === String(id));
    if (!row) throw new HttpError(404, '没找到这条');
    return {
      kind, id, title: row.title ?? '', content: row.text ?? '',
      tags: Array.isArray(row.tags) ? row.tags : [], at: row.createdAt ?? 0,
    };
  }
  const file = kind === 'dreams' ? STATE_FILES.dreams : STATE_FILES.fantasies;
  const rows = jsonlRows(file);
  const row = rows.find((r) => String(r.id ?? r.i) === String(id));
  if (!row) throw new HttpError(404, '没找到这条');
  return kind === 'dreams'
    ? { kind, id, content: row.dream ?? '', feel: row.feel ?? '', at: row.at ?? 0 }
    : { kind, id, content: row.text ?? '', tag: row.tag ?? '', at: row.at ?? 0 };
}

export function memoryCounts() {
  return {
    diary: listFiles(STATE_FILES.diaryDir, /\.md$/).length,
    memoir: listFiles(STATE_FILES.memoirDir, /\.md$/).length,
    dreams: readText(STATE_FILES.dreams).split('\n').filter(Boolean).length,
    fantasies: readText(STATE_FILES.fantasies).split('\n').filter(Boolean).length,
    knowledge: readText(STATE_FILES.knowledgeIndex).split('\n').filter(Boolean).length,
  };
}

export function memorySearch(q, limit = 100) {  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return { query: '', items: [] };
  const items = [];
  for (const kind of MEMORY_KINDS) {
    let list = [];
    try { list = memoryList(kind); } catch { continue; }
    for (const it of list) {
      let detail;
      try { detail = memoryRead(kind, it.id); } catch { continue; }
      const content = String(detail.content ?? '');
      const tags = Array.isArray(detail.tags) ? detail.tags : [];
      const hay = [it.title, content, tags.join(' ')].join('\n').toLowerCase();
      if (!hay.includes(needle)) continue;
      const at = content.toLowerCase().indexOf(needle);
      const start = Math.max(0, at - 40);
      items.push({
        kind, id: it.id, title: it.title || it.id,
        at: it.at || it.mtime || 0, tags,
        snippet: content.slice(start, start + 140).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  items.sort((a, b) => b.at - a.at);
  return { query: q, items: items.slice(0, limit) };
}

// ── 安全拦截审计 ────────────────────────────────────────────────────────────
export function securityBlocks(limit = 200) {
  const rows = jsonlRows(path.join(STATE_DIR, 'security-blocks.jsonl'));
  const now = Date.now();
  const items = rows.map((r, i) => ({
    id: i,
    at: Date.parse(r.time) || 0,
    key: String(r.key ?? ''),
    reason: String(r.reason ?? 'sensitive'),
    hasKnownToken: Boolean(r.hasKnownToken),
    text: String(r.text ?? ''),
  })).sort((a, b) => b.at - a.at);
  const count = (reason) => items.filter((x) => x.reason === reason).length;
  return {
    total: items.length,
    last24h: items.filter((x) => now - x.at < 86400000).length,
    reasons: {
      agentLeak: count('agent-leak'),
      knownToken: count('known-token'),
      sensitive: count('sensitive'),
    },
    items: items.slice(0, limit),
  };
}

// ── 人格卡 ──────────────────────────────────────────────────────────────────
export function roleList() {
  const active = readJson(STATE_FILES.role, {}).role ?? '';
  return listFiles(ROLES_DIR, /\.md$/)
    .filter((f) => !/^readme\.md$/i.test(f.name))
    .map((f) => {
      const name = f.name.replace(/\.md$/, '');
      return {
        name,
        chars: readText(path.join(ROLES_DIR, f.name)).length,
        active: name === active,
        mtime: f.mtime,
        size: f.size,
      };
    })
    .sort((a, b) => (Number(b.active) - Number(a.active)) || a.name.localeCompare(b.name));
}

export function roleRead(name) {
  const safe = assertSafeName(name, '人格卡名字');
  const file = path.join(ROLES_DIR, `${safe}.md`);
  const content = readText(file, null);
  if (content === null) throw new HttpError(404, '没找到这张人格卡');
  return { name: safe, content, ...statOf(file) };
}

export function roleWrite(name, content) {
  const safe = assertSafeName(name, '人格卡名字');
  if (typeof content !== 'string') throw new HttpError(400, '内容必须是字符串');
  if (content.length > 60000) throw new HttpError(400, '人格卡太长了（上限 6 万字）');
  const file = path.join(ROLES_DIR, `${safe}.md`);
  if (!fs.existsSync(file)) throw new HttpError(404, '只能改已有的人格卡（新建请用脚本）');
  const backupFile = backup(file);
  atomicWrite(file, content);
  return { ok: true, backup: backupFile, name: safe, chars: content.length };
}

// ── 日志 ────────────────────────────────────────────────────────────────────
const LOG_FILES = {
  bridge: STATE_FILES.bridgeLog,
  activity: STATE_FILES.activityLog,
  console: path.join(LOGS_DIR, 'console.log'),
};

export function logList() {
  return Object.entries(LOG_FILES).map(([name, file]) => ({
    name,
    file,
    exists: fs.existsSync(file),
    ...statOf(file),
  }));
}

export function logTail(name, lines = 200) {
  const file = LOG_FILES[name];
  if (!file) throw new HttpError(400, '未知的日志');
  const n = Math.max(10, Math.min(2000, Number(lines) || 200));
  let text = '';
  try {
    const all = fs.readFileSync(file, 'utf8').split('\n');
    text = all.slice(-n).join('\n');
  } catch {
    return { name, exists: false, lines: [], text: '' };
  }
  return { name, exists: true, file, text, count: text.split('\n').filter(Boolean).length };
}

// ── 首次配对 ────────────────────────────────────────────────────────────────
// 给「一键部署」用：没有主人时，面板上显示 6 位码；用户私聊发过来，桥接认主。
export function pairingView() {
  const cfg = readConfig();
  const state = loadPairing(STATE_FILES.pairing);
  const status = pairingStatus(state);
  return {
    ownerQQ: cfg.ownerQQ ?? null,
    paired: Boolean(cfg.ownerQQ),
    active: status.active,
    reason: status.reason ?? '',
    code: status.active ? state.code : '',
    expiresAt: status.active ? state.expiresAt : 0,
    remainingMs: status.active ? status.remainingMs : 0,
    attemptsLeft: status.active ? status.attemptsLeft : 0,
    file: STATE_FILES.pairing,
  };
}

export function startPairing() {
  const cfg = readConfig();
  if (cfg.ownerQQ) throw new HttpError(400, '已经有主人了（ownerQQ 已填）。要换人请先清空 ownerQQ。');
  const state = createPairing();
  savePairing(STATE_FILES.pairing, state);
  return pairingView();
}

export function cancelPairing() {
  clearPairing(STATE_FILES.pairing);
  return pairingView();
}

// ── 大脑（DSH） ─────────────────────────────────────────────────────────────
// overview 每 15 秒轮询一次，不能每次都扫进程；这里缓存 8 秒。
let dshCache = { at: 0, value: null };

async function dshInfo(cfg, { force = false } = {}) {
  if (!force && dshCache.value && Date.now() - dshCache.at < 8000) return dshCache.value;
  let value = await dshStatus({ cfg, timeoutMs: 700 });
  // 配置里的端口过期（DSH 重启换端口）时，自动扫一次并写回配置
  if (!value.ok) {
    const found = await discoverDsh({ cfg, scan: true, timeoutMs: 900 }).catch(() => null);
    if (found?.ok && found.baseUrl && found.baseUrl !== value.baseUrl) {
      try { persistDshBaseUrl(CONFIG_FILE, found.baseUrl); } catch { /* 下次再写 */ }
      value = { ok: true, reason: 'ok', baseUrl: found.baseUrl, status: 200, registration: found.registration, autoDiscovered: true };
    }
  }
  dshCache = { at: Date.now(), value };
  return value;
}

/** 面板上点「自动检测」：允许扫进程（慢一点，但能发现随机端口）。 */
export async function discoverDshForUi() {
  const cfg = readConfig();
  const found = await discoverDsh({ cfg, scan: true, timeoutMs: 900 });
  dshCache = { at: 0, value: null };
  return found.ok
    ? { ok: true, baseUrl: found.baseUrl, registration: found.registration, tried: found.tried }
    : { ok: false, error: found.error, registration: found.registration, tried: found.tried };
}

/** 把 DSH 地址写进 config.json（走 saveConfig，自动备份）。 */
export function applyDshBaseUrl(baseUrl) {
  const value = String(baseUrl ?? '').trim();
  if (!/^https?:\/\//i.test(value)) throw new HttpError(400, 'DSH 地址要是 http(s)://...');
  const result = saveConfig({ dsh: { baseUrl: value } });
  dshCache = { at: 0, value: null };
  return { ok: true, baseUrl: value, backup: result.backup, config: configView() };
}

// ── 总览 ────────────────────────────────────────────────────────────────────
/** 网关探活：走统一的 SnowLuma 连接层，不再自己拼 fetch。永远不抛。 */
async function gatewayInfo(cfg) {
  const httpUrl = String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg.snowluma?.accessToken ?? '');
  try {
    const data = await createOneBotHttp({ baseUrl: httpUrl, token })
      .call('get_login_info', {}, { timeoutMs: 1200 });
    return { ok: true, httpUrl, uin: data?.user_id ?? null, nickname: data?.nickname ?? '' };
  } catch (error) {
    return { ok: false, httpUrl, error: String(error?.message ?? error) };
  }
}

const execFileP = promisify(execFile);
const BACKUP_DIR = path.join(APP_ROOT, 'backups');

/** 备份列表（新的在前）。 */
export function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /\.zip$/i.test(f)).map((name) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, size: stat.size, at: stat.mtimeMs };
    }).sort((a, b) => b.at - a.at);
  } catch { return []; }
}

function backupPath(name) {
  const safe = path.basename(String(name || ''));
  if (!/\.zip$/i.test(safe)) throw new HttpError(400, '备份文件名不合法');
  const full = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(full)) throw new HttpError(404, '备份不存在');
  return full;
}

export function backupFilePath(name) { return backupPath(name); }

export function gpuMode() {
  try { return fs.readFileSync(path.join(STATE_DIR, 'gpu-mode.txt'), 'utf8').trim() || 'idle'; } catch { return 'idle'; }
}

export async function setGpuMode(mode) {
  if (!['voice', 'draw', 'idle'].includes(mode)) throw new HttpError(400, 'mode 只能是 voice/draw/idle');
  const script = path.join(APP_ROOT, 'bin', 'gpu.ps1');
  const { stdout } = await execFileP('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode], { timeout: 60000, windowsHide: true });
  return { ok: true, mode, output: String(stdout || '').trim() };
}

export async function createBackupNow() {
  const script = path.join(APP_ROOT, 'bin', 'backup.ps1');
  const { stdout } = await execFileP('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { timeout: 180000, windowsHide: true });
  return { ok: true, output: String(stdout || '').trim(), backups: listBackups() };
}

export async function restoreBackup(name) {
  const zip = backupPath(name);
  const script = path.join(APP_ROOT, 'bin', 'restore.ps1');
  const { stdout, stderr } = await execFileP('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-From', zip, '-Force'], { timeout: 300000, windowsHide: true });
  return { ok: true, output: String(stdout || stderr || '').trim(), file: path.basename(zip) };
}

/** 健康告警：进程在，但她不一定“活着”。 */
const RUNTIME_ALERT_TEXT = {
  balance: '账户余额不足，她回不了消息',
  contextOverflow: '上下文爆表，有一轮没答成',
  agentErrors: '连续几轮 agent 出错',
  gatewayDown: 'QQ 网关掉线超过 5 分钟',
  restartStorm: '桥接一小时内重启多次',
  backupStale: '备份超过 48 小时没更新',
};

export async function healthAlerts({ ports, dsh }) {
  const alerts = [];
  if (!ports?.bridge) alerts.push({ level: 'error', text: '大脑（3100）没在跑', action: 'restart' });
  if (dsh && !dsh.ok) alerts.push({ level: 'error', text: `DSH 连不上：${dsh.baseUrl || '未配置'}`, action: 'setup' });
  if (!ports?.gateway) alerts.push({ level: 'warn', text: 'QQ 网关离线：SnowLuma 没开或没登录', action: 'gateway' });
  try {
    const msgs = [...journal(localDay(-1)).messages, ...journal(localDay(0)).messages];
    const mine = msgs.filter((m) => m.role === 'her' && m.t);
    if (mine.length) {
      const last = Math.max(...mine.map((m) => m.t));
      const hours = (Date.now() - last) / 3600000;
      const hour = new Date().getHours();
      if (hours >= 6 && hour >= 9 && hour <= 23) alerts.push({ level: 'warn', text: `她已经 ${Math.floor(hours)} 小时没说话了`, action: 'logs' });
    }
  } catch { /* 读不到聊天记录就不报 */ }
  try {
    const backups = listBackups();
    if (!backups.length) alerts.push({ level: 'warn', text: '还没有备份', action: 'backup' });
    else if (Date.now() - backups[0].at > 48 * 3600000) alerts.push({ level: 'warn', text: '最近一次备份超过 48 小时', action: 'backup' });
  } catch { /* ignore */ }
  return alerts;
}

/** 导出“她的一生” Markdown。 */
export function exportLifeMarkdown() {
  const life = lifeView();
  const lines = [];
  lines.push(`# 小鱼的一生（出生 ${life.birth} · 第 ${life.days} 天）`);
  lines.push('');
  lines.push(`- 阶段：${life.stage.name}`);
  lines.push(`- 日记 ${life.stats.diary} 篇 · 回忆录 ${life.stats.memoir} 章 · 梦 ${life.stats.dreams} 个 · 幻想 ${life.stats.fantasies} 条 · 知识 ${life.stats.knowledge} 条`);
  lines.push('');
  lines.push('## 时间线');
  for (const item of life.timeline.slice().reverse()) {
    lines.push(`- ${item.day}（第 ${item.n} 天）${item.title}`);
    if (item.text) lines.push('  ' + item.text.replace(/\n/g, ' '));
  }
  lines.push('');
  lines.push('## 回忆录');
  try {
    const dir = path.join(STATE_DIR, 'memoir');
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      lines.push(''); lines.push(`### ${name.replace(/\.md$/, '')}`);
      lines.push(fs.readFileSync(path.join(dir, name), 'utf8'));
    }
  } catch { /* 没回忆录 */ }
  const stamp = new Date().toISOString().slice(0, 10);
  return { filename: `xiaoyu-life-${stamp}.md`, markdown: `${lines.join('\n')}\n` };
}

export async function overview() {
  const cfg = readConfig();
  const engineSet = detectEngines({ cfg });
  const ports = await probeAll();
  const counts = memoryCounts();
  const today = journal(localDay(0));
  const hers = today.messages.filter((m) => m.role === 'her');
  const gateway = await gatewayInfo(cfg);
  const dsh = await dshInfo(cfg);
  const alerts = await healthAlerts({ ports, dsh });
  // 桥接记下的运行告警（余额不足 / 连续出错 / 备份过期…）也挂到首屏，别让人去翻日志
  try {
    const runtime = createAlertCenter({ file: STATE_FILES.alerts }).active();
    for (const a of runtime) {
      const detail = a.message ? `：${String(a.message).slice(0, 80)}` : '';
      alerts.push({ level: a.level, text: `${RUNTIME_ALERT_TEXT[a.kind] ?? a.kind}${detail}`, action: 'logs' });
    }
  } catch { /* 告警文件坏了不该拖垮首屏 */ }
  return {
    root: APP_ROOT,
    ports,
    portNames: PORTS,
    capabilities: capabilities(engineSet),
    engines: engineSet,
    gateway,
    snowluma: await gatewayState(),
    dsh,
    alerts,
    config: { exists: configExists(), file: CONFIG_FILE, warnings: configWarnings(cfg) },
    her: herState(),
    counts,
    journal: { day: today.day, total: today.messages.length, last: hers.length ? hers[hers.length - 1] : null },
    now: Date.now(),
  };
}
