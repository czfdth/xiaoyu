// 守护：强制大群保持静音（bridge 重启/默认刷新会重置唤醒配置）。
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';

const KEY = 'group:871761903';
const LOG = ROOT + '/state/silent-guard.log';

const tok = fs.readFileSync(ROOT + '/state/console-token', 'utf8').trim();
const H = { 'x-console-token': tok, 'content-type': 'application/json' };

const WANT = { mode: 'diving', infinite: true, batchWindowMs: 2000,
  triggers: { atMention: false, nameMention: false, question: false, poke: false,
    anyMessage: false, probability: 0, keywords: ['__never__'] } };

function log(m) {
  try { fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN')}] ${m}\n`, 'utf8'); } catch {}
}

try {
  const st = await (await fetch('http://127.0.0.1:3100/api/socialV2/state?key=' + encodeURIComponent(KEY), { headers: H })).json();
  const tr = st.wakeConfig?.triggers ?? {};
  const drift = tr.atMention || tr.nameMention || tr.question || tr.poke || tr.anyMessage || Number(tr.probability) > 0;
  if (drift) {
    const r = await fetch('http://127.0.0.1:3100/api/socialV2/wake-config', {
      method: 'POST', headers: H, body: JSON.stringify({ key: KEY, config: WANT })
    });
    log(`检测到漂移，已重置：${r.status}`);
    console.log('reset', r.status);
  } else {
    console.log('ok (no drift)');
  }
} catch (e) {
  log('guard error: ' + e.message);
  console.log('err', e.message);
}
