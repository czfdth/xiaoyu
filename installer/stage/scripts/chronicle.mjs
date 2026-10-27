// 自动年鉴：每满 100 天生成一份（由计划任务每天 23:30 调，脚本自己判断该不该生成）。
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../src/paths.js';
import { lifeView, generateChronicle, chronicleList } from '../gui/server/life.mjs';

const DIR = path.join(STATE_DIR, 'chronicles');
const LAST = path.join(DIR, 'last.json');
const LOG = path.join(STATE_DIR, 'chronicle.log');

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(LOG, line, 'utf8'); } catch { /* ignore */ }
  process.stdout.write(line);
}

let last = { lastDay: 0 };
try { last = { ...last, ...JSON.parse(fs.readFileSync(LAST, 'utf8')) }; } catch { /* 第一次 */ }

const life = lifeView();
const days = life.days;
if (days - (last.lastDay || 0) < 100) {
  log(`还没到 100 天（第 ${days} 天，上次 ${last.lastDay || 0}），跳过`);
  process.exit(0);
}

const result = generateChronicle({ days: 100 });
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(LAST, JSON.stringify({ lastDay: days, file: result.label, at: Date.now() }, null, 2), 'utf8');
log(`生成年鉴 ${result.label}（第 ${days} 天，${result.size} 字节）；现有 ${chronicleList().length} 份`);
