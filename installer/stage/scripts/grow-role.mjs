// 成长写入人格卡：到 7/30/100/365 天，把「相处阶段」追加到当前人格卡（先备份）。
// 由计划任务每天 00:10 跑；已写过的阶段记在 state/growth.json，不重复。
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT as ROOT, STATE_DIR, ROLES_DIR } from '../src/paths.js';

const LIFE = path.join(STATE_DIR, 'life.json');
const GROWTH = path.join(STATE_DIR, 'growth.json');
const ROLE_STATE = path.join(STATE_DIR, 'current-role.json');
const LOG = path.join(STATE_DIR, 'growth.log');

const STAGES = [
  [7, '熟悉', '过了客气的阶段，可以随口说话，也可以安静待着。'],
  [30, '默契', '很多事不用解释；记得对方随口提过的小事，也会在对方累的时候少说两句。'],
  [100, '家人', '会自然地问对方吃饭没有、睡够没有，也开始管对方。'],
  [365, '老伴', '不用把话说完，也知道对方下一句要说什么。'],
];

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch { /* ignore */ }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

const life = readJson(LIFE, null);
if (!life?.birth) { log('还没有出生记录，跳过'); process.exit(0); }
const birth = new Date(`${life.birth}T00:00:00`).getTime();
const days = Math.max(1, Math.floor((Date.now() - birth) / 86400000) + 1);

const roleName = String(readJson(ROLE_STATE, {}).role || '').trim();
if (!roleName) { log('还没有当前人格卡，跳过'); process.exit(0); }
const roleFile = path.join(ROLES_DIR, `${roleName}.md`);
if (!fs.existsSync(roleFile)) { log(`人格卡不存在：${roleName}`); process.exit(0); }

const growth = readJson(GROWTH, { applied: [] });
const applied = new Set(growth.applied || []);
let changed = false;

for (const [min, name, text] of STAGES) {
  if (days < min || applied.has(name)) continue;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  try { fs.copyFileSync(roleFile, `${roleFile}.bak-growth-${stamp}`); } catch { /* 备份失败也继续 */ }
  const section = `\n\n## 相处阶段 · ${name}（第 ${days} 天）\n${text}\n`;
  fs.appendFileSync(roleFile, section, 'utf8');
  applied.add(name);
  changed = true;
  log(`已写入 ${roleName}.md：${name}（第 ${days} 天）`);
}

if (changed) fs.writeFileSync(GROWTH, JSON.stringify({ applied: [...applied], at: Date.now() }, null, 2), 'utf8');
else log(`第 ${days} 天，没有新的阶段要写`);
