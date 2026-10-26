// 鎷︽埅瑙勫垯鍥炴斁锛氬彧鍦ㄦ湰鏈鸿窇瑙勫垯锛屼笉鍙戞秷鎭€佷笉鍐欑洏锛岀敤鏉ュ垽鏂槸涓嶆槸璇激銆?import { SENSITIVE_RE, AGENT_LEAK_RE, looksLikeAgentLeak } from '../../src/sensitive.js';
import { HttpError } from './guard.mjs';

function collect(re, text) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const rx = new RegExp(re.source, flags);
  const out = [];
  let m;
  while ((m = rx.exec(text)) !== null && out.length < 8) {
    const start = Math.max(0, m.index - 30);
    const end = Math.min(text.length, m.index + m[0].length + 30);
    out.push({
      match: String(m[0]).slice(0, 120),
      snippet: text.slice(start, end).replace(/\s+/g, ' ').trim(),
    });
    if (rx.lastIndex === m.index) rx.lastIndex += 1;
  }
  return out;
}

export function replaySecurity({ text, knownToken = false } = {}) {  const value = String(text ?? '');
  if (!value.trim()) throw new HttpError(400, '鍥炴斁鏂囨湰涓嶈兘涓虹┖');
  if (value.length > 20000) throw new HttpError(400, '鍥炴斁鏂囨湰澶暱锛堜笂闄?20000 瀛楋級');

  const signals = [];
  const agentLeak = looksLikeAgentLeak(value);
  if (agentLeak) {
    signals.push({
      rule: 'agent-leak',
      label: '缂栫爜浠ｇ悊涓插彴',
      matches: collect(AGENT_LEAK_RE, value),
    });
  }
  if (SENSITIVE_RE.test(value)) {
    signals.push({
      rule: 'sensitive',
      label: '鏁忔劅淇℃伅锛堣矾寰?鍑嵁/瀵嗛挜锛?,
      matches: collect(SENSITIVE_RE, value),
    });
  }
  if (knownToken) {
    signals.push({
      rule: 'known-token',
      label: '鍛戒腑浜嗚繍琛屾湡宸茬煡鐨勪細璇濅护鐗?,
      matches: [],
    });
  }

  const reason = signals.some((s) => s.rule === 'agent-leak') ? 'agent-leak'
    : signals.some((s) => s.rule === 'known-token') ? 'known-token'
      : signals.length ? 'sensitive' : '';

  return {
    text: value,
    wouldBlock: signals.length > 0,
    reason,
    signals,
    checkedAt: Date.now(),
  };
}

function csvCell(value) {
  let s = String(value ?? '');
  // 闃?CSV 鍏紡娉ㄥ叆锛欵xcel 浼氭妸 = + - @ 寮€澶寸殑鍗曞厓鏍煎綋鍏紡
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 鎶婃嫤鎴褰曞鍑烘垚 CSV / JSONL锛涘彧鍋氭湰鍦板瓧绗︿覆鏍煎紡鍖栵紝涓嶅啓鐩樸€?*/
export function exportSecurity({ items = [], format = 'csv', reason = 'all', q = '', limit = 5000 } = {}) {
  const needle = String(q ?? '').trim().toLowerCase();
  const wanted = String(reason ?? 'all');
  const rows = items
    .filter((x) => wanted === 'all' || x.reason === wanted)
    .filter((x) => !needle || `${x.text} ${x.key}`.toLowerCase().includes(needle))
    .slice(0, limit);

  const stamp = localStamp();
  if (format === 'jsonl') {
    const body = rows.map((x) => JSON.stringify({
      time: x.at ? new Date(x.at).toISOString() : '',
      key: x.key,
      reason: x.reason,
      hasKnownToken: Boolean(x.hasKnownToken),
      text: x.text,
    })).join('\n');
    return {
      body: body ? `${body}\n` : '',
      contentType: 'application/x-ndjson; charset=utf-8',
      filename: `xiaoyu-security-${stamp}.jsonl`,
      count: rows.length,
    };
  }

  const header = ['time', 'key', 'reason', 'has_known_token', 'text'];
  const lines = [header.join(',')];
  for (const x of rows) {
    lines.push([
      x.at ? new Date(x.at).toISOString() : '',
      x.key,
      x.reason,
      x.hasKnownToken ? 'true' : 'false',
      x.text,
    ].map(csvCell).join(','));
  }
  return {
    body: `\uFEFF${lines.join('\r\n')}\r\n`,
    contentType: 'text/csv; charset=utf-8',
    filename: `xiaoyu-security-${stamp}.csv`,
    count: rows.length,
  };
}
