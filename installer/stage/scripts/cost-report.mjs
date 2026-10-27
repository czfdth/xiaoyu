// 成本日报：统计今天的 token 消耗，晚上 23:00 发一条给她爸爸。
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';

const LEDGER = ROOT + '/state/token-usage.jsonl';
const LOG = ROOT + '/state/cost-report.log';

const cfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, ''));
const OWNER = Number(cfg.ownerQQ) || 0;
const base = String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const H = {
  'content-type': 'application/json',
  ...(cfg.snowluma?.accessToken ? { authorization: 'Bearer ' + cfg.snowluma.accessToken } : {})
};
const owner = Number(cfg.ownerQQ) || 0;

function log(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`, 'utf8'); } catch {}
}

let rows = [];
try {
  rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
} catch { log('no ledger'); }

const today = new Date();
today.setHours(0, 0, 0, 0);
const start = today.getTime();

const todays = rows.filter((r) => Number(r.t ?? 0) >= start);
let prompt = 0, hit = 0, out = 0, steps = 0;
for (const r of todays) {
  const b = r.b ?? {};
  const h = Number(b.cacheHit ?? 0), m = Number(b.cacheMiss ?? 0);
  hit += h; prompt += h + m; out += Number(b.output ?? 0); steps += 1;
}
const hitRate = prompt ? Math.round((hit / prompt) * 100) : 0;
const num = (n) => (n >= 1e8 ? (n / 1e8).toFixed(2) + ' 亿' : (n >= 1e4 ? (n / 1e4).toFixed(1) + ' 万' : String(n)));

const avgStep = steps ? Math.round(prompt / steps) : 0;
const text = todays.length
  ? `今天的账：${steps} 步（每步上下文约 ${num(avgStep)}）、输入 ${num(prompt)}、缓存命中 ${hitRate}%、输出 ${num(out)}。`
  : '今天没说几句话，没什么开销。';

try {
  const r = await fetch(base + '/send_private_msg', {
    method: 'POST', headers: H,
    body: JSON.stringify({ user_id: owner, message: [{ type: 'text', data: { text } }] }),
    signal: AbortSignal.timeout(20000)
  });
  const j = await r.json().catch(() => ({}));
  log(`${r.status} ${j.retcode ?? '-'} | ${text}`);
  console.log(text);
} catch (e) {
  log('send failed: ' + e.message);
  console.error(e.message);
}
