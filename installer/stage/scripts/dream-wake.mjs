// 凌晨 4:00 叫醒她做梦：写一个梦，然后继续睡。
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, ''));
const OWNER = Number(cfg.ownerQQ) || 0;

const tok = fs.readFileSync(ROOT + '/state/console-token', 'utf8').trim();
const LOG = ROOT + '/state/dream-wake.log';

function log(m) {
  try { fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN')}] ${m}\n`, 'utf8'); } catch {}
}

// 今天已经做过梦就不再叫
function dreamedToday() {
  try {
    const p = ROOT + '/state/dreams.jsonl';
    const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (!rows.length) return false;
    const today = new Date().toISOString().slice(0, 10);
    return rows.some((d) => new Date(d.at).toISOString().slice(0, 10) === today);
  } catch { return false; }
}

if (dreamedToday()) { log('skip: 今天已经做过梦'); console.log('skip'); process.exit(0); }

fs.writeFileSync(ROOT + '/state/task-note.txt', "现在是凌晨，你正在睡着。做了一个梦，用 qq_dream 记下来（一两百字，不合逻辑也行，带一句 feel）。记完继续睡，别给他发消息。", 'utf8');

const r = await fetch('http://127.0.0.1:3100/api/socialV2/wake', {
  method: 'POST',
  headers: { 'x-console-token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({
    key: `private:${OWNER}`,
    reason: 'task',
    hint: '现在是凌晨四点，你正在睡着。做了一个梦，用 qq_dream 记下来（一两百字，不合逻辑也行，带一句 feel），记完继续睡，别给他发消息。'
  })
});
log('wake ' + r.status);
console.log('wake', r.status);
