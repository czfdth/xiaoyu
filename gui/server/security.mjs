// 拦截规则回放：只在本机跑规则，不发消息、不写盘，用来判断是不是误伤。
import { SENSITIVE_RE, AGENT_LEAK_RE, looksLikeAgentLeak } from '../../src/sensitive.js';
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

export function replaySecurity({ text, knownToken = false } = {}) {
  const value = String(text ?? '');
  if (!value.trim()) throw new HttpError(400, '回放文本不能为空');
  if (value.length > 20000) throw new HttpError(400, '回放文本太长（上限 20000 字）');

  const signals = [];
  const agentLeak = looksLikeAgentLeak(value);
  if (agentLeak) {
    signals.push({
      rule: 'agent-leak',
      label: '编码代理串台',
      matches: collect(AGENT_LEAK_RE, value),
    });
  }
  if (SENSITIVE_RE.test(value)) {
    signals.push({
      rule: 'sensitive',
      label: '敏感信息（路径/凭据/密钥）',
      matches: collect(SENSITIVE_RE, value),
    });
  }
  if (knownToken) {
    signals.push({
      rule: 'known-token',
      label: '命中了运行期已知的会话令牌',
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
