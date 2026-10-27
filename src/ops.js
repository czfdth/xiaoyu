// 运维体检：密钥泄漏、磁盘占用、备份可恢复性、语义索引召回、她的一天。
//
// 这一组都是"平时没人看、出事才发现坏了"的东西，所以每个都给一个可执行的检查 + 一句人话结论。
// 除了 cleanup（会删旧备份/旧日志），其余全是只读。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ── 1. 密钥泄漏扫描 ────────────────────────────────────────────────────────
// 只找"像密钥"的串，不打印完整值；命中就把路径和行号报出来，让人自己去改。
const SECRET_PATTERNS = [
  { name: 'deepseek/sk', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'openai', re: /\bsk-(?:proj|live)-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
];

/** 把一个密钥值遮成 sk-abc…wxyz，用于报告里展示"是哪一条"而不泄漏。 */
export function maskSecret(value) {
  const text = String(value ?? '');
  if (text.length <= 8) return '***';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/**
 * 扫一批文件里有没有明文密钥。
 * @param {string[]} files
 * @returns {{file:string, line:number, kind:string, masked:string}[]}
 */
export function scanSecrets(files = []) {
  const out = [];
  for (const file of files) {
    let text = '';
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      for (const { name, re } of SECRET_PATTERNS) {
        const hit = line.match(re);
        if (!hit) continue;
        out.push({ file, line: index + 1, kind: name, masked: maskSecret(hit[0]) });
        break;
      }
    });
  }
  return out;
}

/**
 * 密钥健康：哪些文件里还留着明文、日志里有没有漏出去。
 * @returns {{ok:boolean, plaintextFiles:string[], logLeaks:object[], warnings:string[]}}
 */
export function keyHealth({ configFiles = [], logFiles = [] } = {}) {
  const configHits = scanSecrets(configFiles);
  const logHits = scanSecrets(logFiles);
  const plaintextFiles = [...new Set(configHits.map((h) => h.file))];
  const warnings = [];
  if (plaintextFiles.length) warnings.push(`${plaintextFiles.length} 个配置文件里是明文密钥（备份 zip 会一起带走）`);
  if (logHits.length) warnings.push(`日志里出现 ${logHits.length} 处疑似密钥，建议立刻轮换`);
  return { ok: !plaintextFiles.length && !logHits.length, plaintextFiles, logLeaks: logHits, warnings };
}

// ── 2. 磁盘占用 ────────────────────────────────────────────────────────────
function dirSize(dir, { maxFiles = 20000 } = {}) {
  let bytes = 0;
  let files = 0;
  const walk = (d, depth) => {
    if (depth > 6 || files >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      try { bytes += fs.statSync(full).size; files += 1; } catch { /* 跳过读不到的 */ }
      if (files >= maxFiles) return;
    }
  };
  walk(dir, 0);
  return { bytes, files };
}

/**
 * 各部分占多少（日志/备份/state/整个数据根）。
 * @param {{home:string}} options
 */
export function diskReport({ home }) {
  const parts = [
    { key: 'state', dir: path.join(home, 'state') },
    { key: 'logs', dir: path.join(home, 'logs') },
    { key: 'backups', dir: path.join(home, 'backups') },
    { key: 'home', dir: home },
  ];
  const out = {};
  for (const { key, dir } of parts) {
    const { bytes, files } = dirSize(dir);
    out[key] = { bytes, files, mb: Math.round((bytes / 1024 / 1024) * 10) / 10, path: dir };
  }
  out.free = freeSpace(home);
  return out;
}

function freeSpace(dir) {
  try {
    const stat = fs.statfsSync ? fs.statfsSync(dir) : null;
    if (!stat) return null;
    return Math.round((stat.bavail * stat.bsize) / 1024 / 1024 / 1024 * 10) / 10;
  } catch { return null; }
}

/**
 * 清理：只动「旧备份 zip」和「轮转过的日志」，绝不碰 state 里的记忆。
 * @param {{home:string, now?:number, keepBackupDays?:number, keepLogDays?:number, dryRun?:boolean}} options
 */
export function cleanup({ home, now = Date.now(), keepBackupDays = 30, keepLogDays = 14, dryRun = false } = {}) {
  const removed = [];
  let bytes = 0;
  const sweep = (dir, match, maxAgeMs) => {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (!match(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
      removed.push({ file: full, mb: Math.round((st.size / 1024 / 1024) * 10) / 10 });
      bytes += st.size;
      if (!dryRun) { try { fs.rmSync(full, { force: true }); } catch { /* 删不掉就留着 */ } }
    }
  };
  sweep(path.join(home, 'backups'), (n) => /^xiaoyu-.*\.zip$/i.test(n), keepBackupDays * 86400000);
  sweep(path.join(home, 'logs'), (n) => /\.log(\.\d+)?$/i.test(n) || /\.log\.gz$/i.test(n), keepLogDays * 86400000);
  return { removed, mb: Math.round((bytes / 1024 / 1024) * 10) / 10, dryRun };
}

// ── 3. 备份可恢复性 ────────────────────────────────────────────────────────
/** 找最新的备份 zip。 */
export function latestBackup(dir) {
  let latest = '';
  let at = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^xiaoyu-.*\.zip$/i.test(name)) continue;
      const st = fs.statSync(path.join(dir, name));
      if (st.mtimeMs > at) { at = st.mtimeMs; latest = name; }
    }
  } catch { /* 没目录 */ }
  return latest ? { name: latest, path: path.join(dir, latest), at, mb: Math.round((fs.statSync(path.join(dir, latest)).size / 1024 / 1024) * 10) / 10 } : null;
}

/**
 * 恢复演练：真的把最新的包解开，检查关键文件能不能用。
 * 只有"解开后 JSON 能解析、journal 有内容"才算通过。
 */
export function restoreDrill({ backupDir, tmpRoot, keep = false } = {}) {
  const zip = latestBackup(backupDir);
  if (!zip) return { ok: false, reason: '一个备份都没有', at: Date.now() };
  const target = path.join(tmpRoot, `drill-${Date.now()}`);
  try {
    fs.mkdirSync(target, { recursive: true });
    // Expand-Archive 在 Windows 上最省事；其它平台直接报不支持（CI 跳过）
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zip.path.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'ignore', timeout: 120000 });
    const stats = inspectExtracted(target);
    const ok = stats.jsonFiles > 0 && stats.jsonBad === 0 && stats.journalRows > 0;
    return {
      ok,
      at: Date.now(),
      backup: zip.name,
      mb: zip.mb,
      ...stats,
      reason: ok ? '' : '解开的包里没有可用数据（JSON 坏或 journal 为空）',
    };
  } catch (error) {
    return { ok: false, at: Date.now(), backup: zip.name, reason: `解压失败：${error?.message ?? error}` };
  } finally {
    if (!keep) { try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 清不掉也无所谓 */ } }
  }
}

function inspectExtracted(root) {
  const out = { jsonFiles: 0, jsonBad: 0, journalRows: 0, diaryRows: 0, files: 0 };
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      out.files += 1;
      if (/\.json$/i.test(entry.name)) {
        out.jsonFiles += 1;
        try { JSON.parse(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '')); } catch { out.jsonBad += 1; }
      } else if (/journal[\\/].*\.jsonl$/i.test(full)) {
        out.journalRows += countLines(full);
      } else if (/diary[\\/].*\.(jsonl|md)$/i.test(full)) {
        out.diaryRows += countLines(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

// ── 5. 语义索引体检 ───────────────────────────────────────────────────────
/**
 * 抽若干条旧记忆，用它们自己的文字去检索，看 Top-K 里能不能命中自己。
 * 索引"静默腐化"（模型换了/文件格式变了）时，召回会掉到随机水平，而调用方不会报错。
 *
 * @param {{indexFile:string, samples?:number, k?:number, base?:string, model?:string, random?:()=>number}} options
 */
export async function indexHealth({ indexFile, samples = 10, k = 3, base, model, random = Math.random } = {}) {
  const { loadIndex, searchIndex, embedTexts, SEMANTIC_MODEL_DEFAULT, SEMANTIC_BASE_DEFAULT } = await import('./semantic-index.js');
  const index = loadIndex(indexFile);
  const entries = Array.isArray(index?.entries) ? index.entries.filter((e) => String(e?.text ?? '').trim().length > 8) : [];
  if (entries.length < 20) {
    return { ok: false, reason: `索引条目太少（${entries.length}），先建索引`, samples: 0, hits: 0, rate: 0, at: Date.now() };
  }
  const picked = [];
  for (let i = 0; i < Math.min(samples, entries.length); i += 1) {
    picked.push(entries[Math.floor(random() * entries.length)]);
  }
  let hits = 0;
  for (const entry of picked) {
    const query = String(entry.text).slice(0, 40);
    // eslint-disable-next-line no-await-in-loop
    const vectors = await embedTexts({
      texts: [query],
      base: base ?? SEMANTIC_BASE_DEFAULT,
      model: model ?? index.model ?? SEMANTIC_MODEL_DEFAULT,
    });
    const vec = vectors?.[0];
    if (!vec?.length) continue;
    const found = searchIndex(index, vec, { k, minScore: 0 });
    const selfHit = found.some((h) => h.key === entry.key && String(h.text ?? '').slice(0, 40) === query);
    if (selfHit) hits += 1;
  }
  const rate = picked.length ? hits / picked.length : 0;
  return {
    ok: rate >= 0.6,
    at: Date.now(),
    samples: picked.length,
    hits,
    rate: Math.round(rate * 1000) / 1000,
    entries: entries.length,
    reason: rate >= 0.6 ? '' : `召回率 ${Math.round(rate * 100)}% 偏低，索引可能过期或模型换了`,
  };
}

// ── 6. 她的一天（日报）────────────────────────────────────────────────────
/**
 * @param {{day:string, messages:Array, diary:number, works:number, tokens:number, cost:number,
 *          mood:string, topPeers:Array<{who:string,count:number}>}} data
 */
export function composeDailyReport(data = {}) {
  const day = String(data.day ?? '');
  const her = Number(data.herMessages) || 0;
  const other = Number(data.otherMessages) || 0;
  const peers = Array.isArray(data.topPeers) ? data.topPeers.filter((p) => p && p.count > 0).slice(0, 3) : [];
  const lines = [`【${day} · 她的一天】`];
  lines.push(`说话 ${her} 条，被搭话 ${other} 条${peers.length ? `；主要和 ${peers.map((p) => `${p.who}（${p.count}）`).join('、')} 聊` : ''}`);
  if (data.mood) lines.push(`心情：${data.mood}`);
  if (Number(data.diary) > 0) lines.push(`写了 ${data.diary} 篇日记`);
  if (Number(data.works) > 0) lines.push(`画了 ${data.works} 张`);
  if (Number(data.cost) > 0) lines.push(`花费 ≈ ¥${Number(data.cost).toFixed(2)}（${Math.round((Number(data.tokens) || 0) / 10000)} 万 token）`);
  if (data.firstAt && data.lastAt) lines.push(`从 ${data.firstAt} 到 ${data.lastAt}`);
  return lines.join('\n');
}
