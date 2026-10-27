// 固定仪式：到点唤醒她一次（早上/晚上由桥接按小时判断）。
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, ''));
const OWNER = Number(cfg.ownerQQ) || 0;

const tok = fs.readFileSync(ROOT + '/state/console-token', 'utf8').trim();

const r = await fetch('http://127.0.0.1:3100/api/socialV2/wake', {
  method: 'POST',
  headers: { 'x-console-token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({ key: `private:${OWNER}`, reason: 'ritual' })
});
console.log(new Date().toLocaleString('zh-CN'), 'ritual wake ->', r.status, JSON.stringify(await r.json().catch(() => null)).slice(0, 120));
