// 每天早上检查今天是不是特殊日子；是的话叫醒她，让她主动提一句。
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, ''));
const OWNER = Number(cfg.ownerQQ) || 0;
const tok = fs.readFileSync(ROOT + '/state/console-token', 'utf8').trim();
const LOG = ROOT + '/state/anniversary.log';

function log(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`, 'utf8'); } catch {}
}

const d = cfg.socialV2?.dates ?? {};
const now = new Date();
const met = new Date(String(d.metAt || '') + 'T00:00:00+08:00');
const days = Number.isFinite(met.getTime()) ? Math.floor((now - met) / 86400000) + 1 : 0;
const mmdd = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
const marks = Array.isArray(d.milestones) ? d.milestones.map(Number) : [];

const events = [];
if (d.herBirthday && mmdd === String(d.herBirthday)) events.push('她的生日');
if (d.hisBirthday && mmdd === String(d.hisBirthday)) events.push('他的生日');
if (marks.includes(days)) events.push(`认识第 ${days} 天`);

if (!events.length) { log(`普通的一天（第 ${days} 天）`); process.exit(0); }

const r = await fetch('http://127.0.0.1:3100/api/socialV2/wake', {
  method: 'POST',
  headers: { 'x-console-token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({ key: `private:${OWNER}`, reason: 'proactiveCheck' })
});
log(`${events.join('、')} -> wake ${r.status}`);
console.log(events.join('、'), r.status);
