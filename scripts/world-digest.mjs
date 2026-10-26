// 每日世界：抓微博热搜，挑几条人能聊的，存进知识库，并留一份给提示词用。
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';

const OUT = ROOT + '/state/world';
const KB = ROOT + '/state/knowledge/index.jsonl';
const LOG = ROOT + '/state/world.log';

fs.mkdirSync(OUT, { recursive: true });
const log = (m) => { try { fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN')}] ${m}\n`, 'utf8'); } catch {} };

// 不想让她聊的：时政、案件、灾难、色情、死亡相关
const BLOCK = ['总书记', '主席', '总理', '外交', '通报', '警方', '拘', '判', '死', '亡', '杀', '尸', '裸', '色情', '强奸', '坠', '车祸', '爆炸', '地震', '疫情', '疫苗', '癌', '猝', '党', '军', '战', '英雄', '致敬', '抹黑', '辱华', '抵制', '爱国', '反腐', '落马', '纪委', '当选', '国会', '总统'];

function clean(s) {
  return String(s ?? '').replace(/^#|#$/g, '').replace(/\s+/g, ' ').trim();
}

let items = [];
try {
  const r = await fetch('https://weibo.com/ajax/side/hotSearch', {
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://weibo.com/' },
    signal: AbortSignal.timeout(15000)
  });
  const j = await r.json();
  const realtime = j?.data?.realtime ?? [];
  items = realtime.map((x) => ({
    title: clean(x.word),
    hot: Number(x.num) || 0,
    tag: clean(x.category || x.label_name || '')
  })).filter((x) => x.title && !BLOCK.some((w) => x.title.includes(w)));
} catch (e) {
  log('fetch failed: ' + e.message);
}

// 去重 + 取热度高的前 10
const seen = new Set();
const picked = [];
for (const it of items) {
  const key = it.title.slice(0, 10);
  if (seen.has(key)) continue;
  seen.add(key);
  picked.push(it);
  if (picked.length >= 10) break;
}

if (!picked.length) { log('no items today'); process.exit(0); }

const day = new Date().toISOString().slice(0, 10);
fs.writeFileSync(`${OUT}/latest.json`, JSON.stringify({ day, at: Date.now(), items: picked }, null, 2), 'utf8');
fs.writeFileSync(`${OUT}/${day}.json`, JSON.stringify({ day, at: Date.now(), items: picked }, null, 2), 'utf8');

// 存一条知识（每天一条，不刷屏）
const titles = picked.map((x) => x.title);
try {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title: `${day} 外面在说的事`,
    text: titles.join('；'),
    tags: ['世界', '热点', day],
    createdAt: Date.now()
  };
  fs.appendFileSync(KB, JSON.stringify(entry) + '\n', 'utf8');
} catch (e) { log('kb write failed: ' + e.message); }

log(`saved ${picked.length} items: ${titles.slice(0, 3).join(' / ')}`);
console.log(titles.join('\n'));
