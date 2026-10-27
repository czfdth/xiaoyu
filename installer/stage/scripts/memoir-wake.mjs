// 每周日 21:00 提醒她写一章回忆录（叫醒她，让她自己决定写不写）。
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, ''));
const OWNER = Number(cfg.ownerQQ) || 0;

const tok = fs.readFileSync(ROOT + '/state/console-token', 'utf8').trim();
const LOG = ROOT + '/state/memoir-wake.log';

function log(m) {
  try { fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN')}] ${m}\n`, 'utf8'); } catch {}
}

fs.writeFileSync(ROOT + '/state/task-note.txt', "现在是你写回忆录的时间。用 qq_memoir_write 写一章（300~800 字），回头看这段日子，写你和他经历过的事，按时间排，像老了以后写给自己的。写完不用特意告诉他。", 'utf8');

const r = await fetch('http://127.0.0.1:3100/api/socialV2/wake', {
  method: 'POST',
  headers: { 'x-console-token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({
    key: `private:${OWNER}`,
    reason: 'task',
    hint: '现在是你写回忆录的时间。用 qq_memoir_write 写一章（300~800 字）：回头看这段日子，写你和他经历过的事，按时间排，像老了以后写给自己的。写完不用告诉他，除非他问。'
  })
});
log('wake ' + r.status);
console.log('wake', r.status);
