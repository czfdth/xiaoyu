// 守护：把「想让它保持静音」的群强制摁成永不唤醒（bridge 重启/默认刷新会重置唤醒配置）。
//
// 曾经硬编码 group:871761903 —— 结果那个群里 10-25 有人 @她「我加你好友你能同意吗」，
// 她永远收不到，看起来就像"她不回人"。现在改成配置驱动、默认空：
//
//   config.json → "socialV2": { "silentGroups": ["group:123456"] }
//
// 留空（或没有这个键）= 谁也不按，让她自己用 qq_set_wake_config 决定。
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';

const LOG = ROOT + '/state/silent-guard.log';

function log(m) {
  try { fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN')}] ${m}\n`, 'utf8'); } catch {}
}

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, '')); } catch { /* 读不到就什么都不做 */ }
const keys = Array.isArray(cfg?.socialV2?.silentGroups)
  ? cfg.socialV2.silentGroups.map((k) => String(k ?? '').trim()).filter(Boolean)
  : [];

if (!keys.length) {
  console.log('ok (no silentGroups configured)');
  process.exit(0);
}

const tok = fs.readFileSync(ROOT + '/state/console-token', 'utf8').trim();
const H = { 'x-console-token': tok, 'content-type': 'application/json' };
const WANT = { mode: 'diving', infinite: true, batchWindowMs: 2000,
  triggers: { atMention: false, nameMention: false, question: false, poke: false,
    anyMessage: false, probability: 0, keywords: ['__never__'] } };

for (const key of keys) {
  try {
    const st = await (await fetch('http://127.0.0.1:3100/api/socialV2/state?key=' + encodeURIComponent(key), { headers: H })).json();
    const tr = st.wakeConfig?.triggers ?? {};
    const drift = tr.atMention || tr.nameMention || tr.question || tr.poke || tr.anyMessage || Number(tr.probability) > 0;
    if (drift) {
      const r = await fetch('http://127.0.0.1:3100/api/socialV2/wake-config', {
        method: 'POST', headers: H, body: JSON.stringify({ key, config: WANT })
      });
      log(`${key} 检测到漂移，已重置：${r.status}`);
      console.log('reset', key, r.status);
    } else {
      console.log('ok (no drift)', key);
    }
  } catch (e) {
    log(`${key} guard error: ${e.message}`);
    console.log('err', key, e.message);
  }
}
