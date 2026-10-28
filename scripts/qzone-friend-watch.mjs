// 她去看爸爸的 QQ 空间：新说说点个赞，偶尔留一句评论。
//
// 由计划任务每 30 分钟跑一次。第一次运行只做"基线"（把已有说说记为已看过），
// 之后只处理新出现的，不会翻旧账刷屏。
import { APP_ROOT as ROOT } from '../src/paths.js';
import { readCompanion } from '../src/companion.js';
import fs from 'node:fs';

const STATE = ROOT + '/state/qzone-watch.json';
const LOG = ROOT + '/state/qzone-watch.log';
const COMPANION = readCompanion();

const FORCE = process.argv.includes('--force');
const COMMENT_PROB = 0.5;
const MAX_COMMENTS_PER_DAY = 3;

const cfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, ''));
const base = String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const H = {
  'content-type': 'application/json',
  ...(cfg.snowluma?.accessToken ? { authorization: 'Bearer ' + cfg.snowluma.accessToken } : {})
};
const OWNER = Number(cfg.ownerQQ) || 0;

function log(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`, 'utf8'); } catch {}
  console.log(msg);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { seen: [], comments: [] }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8'); } catch {}
}

async function call(action, params) {
  const r = await fetch(base + '/' + action, {
    method: 'POST', headers: H, body: JSON.stringify(params), signal: AbortSignal.timeout(30000)
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, retcode: j.retcode, data: j.data, wording: j.wording };
}

// 1) 拿他的说说
const list = await call('get_qzone_msg_list', { target_uin: OWNER, num: 10 });
const msgs = list?.data?.msglist ?? list?.data?.list ?? [];
if (!Array.isArray(msgs) || !msgs.length) { log('没有拿到他的说说：' + JSON.stringify(list).slice(0, 120)); process.exit(0); }

const st = readState();
const seen = new Set(st.seen ?? []);
const today = new Date().toISOString().slice(0, 10);
const commentsToday = (st.comments ?? []).filter((c) => String(c.day) === today).length;

const fresh = msgs.filter((m) => m && m.tid && !seen.has(String(m.tid)));
if (!seen.size && !FORCE) {
  // 第一次跑：只建基线
  st.seen = msgs.map((m) => String(m.tid));
  saveState(st);
  log(`基线建立：${st.seen.length} 条已记为看过`);
  process.exit(0);
}

if (!fresh.length) { log('没有新说说'); process.exit(0); }

// 2) 生成一句评论（用她自己的口吻）
async function makeComment(content) {
  try {
    const c = JSON.parse(fs.readFileSync(COMPANION, 'utf8').replace(/^\uFEFF/, ''));
    if (!c?.apiKey) return '';
    const apiBase = String(c.baseUrl ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const r = await fetch(apiBase + '/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + c.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: c.model || 'deepseek-chat',
        messages: [{
          role: 'user',
          content: `你是十五岁的女孩小鱼，爸爸发了条说说：「${String(content).slice(0, 200)}」。\n用你自己的口吻留一句评论：10~20 字，口语，别客套、别用「爸爸」二字开头，不要表情符号。只输出评论本身。`
        }],
        max_tokens: 2000,
        temperature: 0.9
      }),
      signal: AbortSignal.timeout(60000)
    });
    const j = await r.json().catch(() => ({}));
    return String(j?.choices?.[0]?.message?.content ?? '').trim().replace(/^["'「]|["'」]$/g, '').slice(0, 40);
  } catch { return ''; }
}

// 3) 处理（最多 2 条/次，避免刷屏）
let acted = 0;
for (const m of fresh.slice(0, 2)) {
  const tid = String(m.tid);
  const abstime = m.time ?? m.createTime ?? m.uploadTime;
  const like = await call('like_qzone', { tid, target_uin: OWNER, ...(abstime ? { abstime: Number(abstime) } : {}) });
  log(`点赞 ${tid} -> ${like.status}/${like.retcode ?? '-'}`);

  if (commentsToday < MAX_COMMENTS_PER_DAY && Math.random() < COMMENT_PROB) {
    const text = await makeComment(m.content ?? '');
    if (text) {
      const c = await call('comment_qzone', { tid, content: text, target_uin: OWNER });
      if (c.retcode === 0) {
        log(`评论 ${tid}: ${text}`);
        st.comments = [...(st.comments ?? []), { tid, text, day: today, at: Date.now() }].slice(-50);
      } else {
        log(`评论失败 ${tid}: ${c.wording ?? c.retcode}`);
      }
    }
  }

  seen.add(tid);
  acted += 1;
}

st.seen = [...seen].slice(-300);
saveState(st);
log(`处理 ${acted} 条新说说`);
