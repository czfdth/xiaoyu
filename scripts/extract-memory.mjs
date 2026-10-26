// 夜间提炼：把当天对话炼成「关于别人的事实」，写进长期记忆。
//
// 数据源：state/journal/<日期>.jsonl（收发流水）+ state/qq-activity.log 回填（她还没上线前的历史）。
// 输出：state/memory/long-term.json —— 桥接每次拼提示词时会注入前 N 条。
//
// 关键取舍：只记"稳定、以后还用得上"的事实（身份、习惯、偏好、约定、人际关系），
// 不记一次性的闲聊（"我饿了"不是记忆，"他爱吃辣"才是）。
import { APP_ROOT as ROOT, COMPANION_CONFIG } from '../src/paths.js';
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, ''));
const OWNER = Number(cfg.ownerQQ) || 0;

const COMPANION = COMPANION_CONFIG;
const JOURNAL = path.join(ROOT, 'state', 'journal');
const MEMORY_DIR = path.join(ROOT, 'state', 'memory');
const MEMORY_FILE = path.join(MEMORY_DIR, 'long-term.json');
const LOG = path.join(ROOT, 'state', 'memory-extract.log');

const args = process.argv.slice(2);
const dayArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const DAY = dayArg || new Date().toISOString().slice(0, 10);
const DRY = args.includes('--dry');

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch {}
  console.log(line.trim());
}

const companion = JSON.parse(fs.readFileSync(COMPANION, 'utf8').replace(/^\uFEFF/, ''));
const apiKey = companion.apiKey;
const baseUrl = String(companion.baseUrl ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const model = companion.model || 'deepseek-chat';
if (!apiKey) { log('no api key'); process.exit(1); }

// ── 读当天流水
const rows = [];
try {
  const p = path.join(JOURNAL, `${DAY}.jsonl`);
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
} catch {}

// ── 回填：活动日志里的入站消息（journal 上线之前的历史）
try {
  const activity = fs.readFileSync(path.join(ROOT, 'state', 'qq-activity.log'), 'utf8').split('\n');
  const seen = new Set(rows.filter((r) => r.role === 'them').map((r) => String(r.text).trim()));
  for (const line of activity) {
    const m = /^\[(\d{2}:\d{2}:\d{2})\]\s+(\S+?)\s+\[reserved2\]\s+消息已入未读：(.*)$/.exec(line.trim());
    if (!m) continue;
    const text = m[3].trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    rows.push({ t: 0, key: m[2], role: 'them', text, sender: '回填' });
  }
} catch {}

if (!rows.length) { log(`${DAY} 没有可提炼的对话`); process.exit(0); }

// 一天聊太多时，一次塞给模型会超出输出上限（finish=length 会拿到空内容）。
// 只取最近的 220 条——记忆提炼本来就是抓重点，不是做全量转录。
const MAX_ROWS = 220;
if (rows.length > MAX_ROWS) {
  log(`今天 ${rows.length} 条，只取最近 ${MAX_ROWS} 条提炼`);
  rows.splice(0, rows.length - MAX_ROWS);
}
log(`装载 ${rows.length} 条（${DAY}）`);

// ── 现有记忆
let mem = { items: [] };
try { mem = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch {}
const existing = Array.isArray(mem.items) ? mem.items : [];

// ── 组织成对话文本（限制体量）
const NAME = cfg.ownerQQ ? { [String(cfg.ownerQQ)]: '他' } : {};
const lines = rows
  .filter((r) => r.text && !/^\[(图片|视频|语音|表情)\]$/.test(String(r.text).trim()))
  .slice(-400)
  .map((r) => {
    const who = r.role === 'her' ? '小鱼' : (NAME[String(r.key).replace(/^private:/, '')] || '他');
    return `${who}：${String(r.text).slice(0, 200)}`;
  });

const existingText = existing.map((x, i) => `${i + 1}. ${x.text}`).join('\n') || '（空）';

// 参与度统计：她发出的每条之后，他多久回；回了就是"有效"。
function computeEngagement(rows) {
  const mine = rows.filter((r) => r.role === 'her' && r.text);
  const his = rows.filter((r) => r.role === 'owner' && r.text);
  const engaged = [];
  const ignored = [];
  for (const m of mine) {
    const next = his.find((h) => h.t > m.t);
    const gapMin = next ? (next.t - m.t) / 60000 : Infinity;
    if (next && gapMin <= 10) engaged.push({ text: m.text, gapMin });
    else ignored.push(m.text);
  }
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  return {
    engagedCount: engaged.length,
    ignoredCount: ignored.length,
    avgGapMin: Number(avg(engaged.map((x) => x.gapMin)).toFixed(1)),
    avgLenEngaged: Number(avg(engaged.map((x) => [...x.text].length)).toFixed(1)),
    avgLenIgnored: Number(avg(ignored.map((x) => [...x].length)).toFixed(1)),
    samplesEngaged: engaged.slice(-3).map((x) => x.text.slice(0, 30)),
    samplesIgnored: ignored.slice(-3).map((x) => x.slice(0, 30))
  };
}
const engageStats = computeEngagement(rows);
const prompt = [
  '你在维护一个 AI 角色对用户的长期记忆。下面是她和用户今天的对话，以及已有的记忆条目。',
  '',
  '任务：',
  '1. 从对话里提炼两类东西：',
  '   (a) 事实：身份信息、生活习惯、偏好厌恶、重要日期、约定/承诺、人际关系、长期话题。',
  '   (b) 经历（type=moment）：他们一起做过的事、说过的有分量的话、情绪转折点、让她开心或难过的小事。比如「他教她唱歌，她跑调了」「她第一次画画他很捧场」。经历要带画面感，别写成结论。',
  '2. 不要记一次性的闲聊（"我饿了""哈哈"），不要记对话本身，不要记情绪波动。',
  '3. 已有记忆里过时或错误的，可以用 update 修正；重复的不要重复添加。',
  '4. **纠正（type=correction，weight 固定 3）**：他说过「别这样」「不要…」「以后要…」「我不喜欢…」这类话时，必须记下来，写成一句可执行的规则，例如「他不喜欢我一次发很多条」。',
  '5. **经验（type=lesson）**：只从下面给的统计数据里总结，不要凭感觉。数据说明什么样的回复更容易得到他的回应。',
  '6. **硬性禁止**：不记录任何性相关、露骨、未成年人不适的内容；即使对话里出现，也一律跳过，不要写进记忆。',
  '7. 她现在的设定是父女关系（他是爸爸），不要把「主人」「奴隶」这类旧关系写进记忆。',
  '4. 每条一句话，第三人称（"他"），不超过 40 字，具体不要空泛。',
  '',
  '【已有记忆】',
  existingText,
  '',
  '【今天她的回复效果（硬数据）】',
  JSON.stringify(engageStats),

  '【今天的对话】',
  lines.join('\n').slice(0, 8000),
  '',
  '只输出 JSON，格式：{"add":[{"text":"...","weight":1-3,"type":"identity|habit|preference|promise|topic|relation|moment|correction|lesson"}],"update":[{"index":序号,"text":"新内容"}]}',
  '没有值得记的就输出 {"add":[],"update":[]}。'
].join('\n');

const res = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 8000,
    temperature: 0.3
  }),
  signal: AbortSignal.timeout(180000)
});
const j = await res.json().catch(() => ({}));
let text = String(j.choices?.[0]?.message?.content ?? '').trim();
if (!text) { log(`模型没返回内容 finish=${j.choices?.[0]?.finish_reason ?? '?'}`); process.exit(1); }
text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
const braceStart = text.indexOf('{');
const braceEnd = text.lastIndexOf('}');
if (braceStart >= 0 && braceEnd > braceStart) text = text.slice(braceStart, braceEnd + 1);

let parsed;
try { parsed = JSON.parse(text); } catch { log(`JSON 解析失败: ${text.slice(0, 200)}`); process.exit(1); }

const now = Date.now();
const additions = Array.isArray(parsed.add) ? parsed.add.filter((x) => x && String(x.text ?? '').trim()) : [];
const updates = Array.isArray(parsed.update) ? parsed.update : [];

const next = [...existing];
for (const u of updates) {
  const idx = Number(u.index) - 1;
  if (Number.isInteger(idx) && next[idx]) {
    next[idx].text = String(u.text).trim().slice(0, 120);
    next[idx].lastSeenAt = now;
    next[idx].weight = Math.min(3, (next[idx].weight ?? 1) + 1);
  }
}

const norm = (s) => String(s).replace(/[\s，。,.!！?？、]/g, '');

// 相似度：字符二元组 Jaccard。用来判断「新记忆和旧记忆说的是不是同一件事」。
function similarity(a, b) {
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(norm(a));
  const B = grams(norm(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// 时间衰减：90 天没被提起，权重按 e^(-t/120) 缩；纠正类（correction）不衰减，永远最高。
function effectiveWeight(item, nowTs) {
  if (String(item.type) === 'correction') return 99;
  const base = Number(item.weight) || 1;
  const seen = Number(item.lastSeenAt ?? item.createdAt) || nowTs;
  const days = Math.max(0, (nowTs - seen) / 86400000);
  return base * Math.exp(-days / 120);
}

const have = new Set(next.map((x) => norm(x.text)));
let added = 0;
for (const a of additions) {
  const body = String(a.text).trim().slice(0, 120);
  if (!body || have.has(norm(body))) continue;
  // 冲突消解：跟已有记忆说的是同一件事，就替换成新的说法，而不是两条并存
  let merged = false;
  for (const it of next) {
    if (similarity(it.text, body) >= 0.55) {
      it.text = body.slice(0, 120);
      it.lastSeenAt = now;
      it.weight = Math.min(3, (it.weight ?? 1) + 1);
      if (a.type) it.type = String(a.type);
      merged = true;
      break;
    }
  }
  if (merged) continue;
  have.add(norm(body));
  next.push({
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    text: body,
    type: String(a.type ?? 'topic'),
    weight: Math.min(3, Math.max(1, Number(a.weight) || 1)),
    createdAt: now,
    lastSeenAt: now,
    source: DAY
  });
  added += 1;
}

log(`新增 ${added} 条，修正 ${updates.length} 条，总计 ${next.length} 条`);
for (const a of additions.slice(0, 10)) log('  + ' + String(a.text).slice(0, 60));

if (DRY) { log('dry run, not saved'); process.exit(0); }

fs.mkdirSync(MEMORY_DIR, { recursive: true });
// 淘汰：记忆满了，就按「有效权重」从低往高删；纠正类永不淘汰。
const MAX_ITEMS = 150;
let kept = next;
if (next.length > MAX_ITEMS) {
  const scored = next.map((it) => ({ it, eff: effectiveWeight(it, now) })).sort((a, b) => b.eff - a.eff);
  kept = scored.slice(0, MAX_ITEMS).map((x) => x.it);
  const dropped = next.length - kept.length;
  if (dropped > 0) log(`淘汰 ${dropped} 条很久没提、权重低的记忆`);
}
fs.writeFileSync(MEMORY_FILE, JSON.stringify({ items: kept }, null, 2), 'utf8');
log('saved');
