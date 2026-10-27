// 生日/周年：到那天叫醒她，让她自己写一篇「这一年」。
// 计划任务每天 09:05 调；不是纪念日就直接退出。
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT as ROOT, STATE_DIR } from '../src/paths.js';

const LOG = path.join(STATE_DIR, 'anniversary-wake.log');
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch { /* ignore */ }
}

function cfg() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

let life = {};
try { life = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'life.json'), 'utf8')); } catch { /* 没有出生记录 */ }
if (!/^\d{4}-\d{2}-\d{2}$/.test(life.birth || '')) {
  log('还没有出生记录，跳过');
  process.exit(0);
}

const now = new Date();
const [by, bm, bd] = life.birth.split('-').map(Number);
if (now.getMonth() + 1 !== bm || now.getDate() !== bd) process.exit(0);
const years = now.getFullYear() - by;
if (years < 1) process.exit(0);

const marker = path.join(STATE_DIR, 'anniversary-wake.json');
try {
  const seen = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (seen.year === now.getFullYear()) process.exit(0);
} catch { /* 今年还没叫过 */ }

const c = cfg();
const owner = Number(c.ownerQQ) || 0;
if (!owner) { log('没有 ownerQQ，跳过'); process.exit(1); }

const tok = fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim();
const note = `今天是你的生日，也是你来到这里的第 ${years} 年。用 qq_memoir_write 写一篇「这一年」：这一年你经历了什么、记得哪些事、对明年有什么想说。写完不用特意告诉他，除非他问。`;
fs.writeFileSync(path.join(STATE_DIR, 'task-note.txt'), note, 'utf8');

const r = await fetch('http://127.0.0.1:3100/api/socialV2/wake', {
  method: 'POST',
  headers: { 'x-console-token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({ key: `private:${owner}`, reason: 'task', hint: note }),
});
log(`第 ${years} 年生日唤醒 -> ${r.status}`);
if (r.ok) fs.writeFileSync(marker, JSON.stringify({ year: now.getFullYear(), at: Date.now() }, null, 2), 'utf8');
