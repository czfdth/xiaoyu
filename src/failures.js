// 没做成的事：从真实的失败记录里取，不是让她自己抒情。
//
// 数据源：state/tool-calls.jsonl 里 ok:false 的调用（这是真实发生过的失败）。
// 用途：偶尔在提示词里给她一句"最近这些没做成"，让她有机会认账、或者换个办法。
//
// 边界：只取 24 小时内的、只取前 3 类，不重复念同一件事（同一个工具一天最多出现一次）。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';

// 注意：STATE_FILES 里没有 toolCalls 这个键，直接拼路径（踩过：路径是 undefined，静默读不到）
const TOOL_CALLS = path.join(STATE_DIR, 'tool-calls.jsonl');

function readCalls(sinceMs) {
  const out = [];
  try {
    const lines = fs.readFileSync(TOOL_CALLS, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.type !== 'result' || row.ok !== false) continue;
      const at = Date.parse(row.time ?? '');
      if (!Number.isFinite(at) || at < sinceMs) continue;
      out.push({
        at,
        tool: String(row.tool ?? '').replace(/^mcp__[^_]+__/, ''),
        error: String(row.error ?? '').slice(0, 80),
      });
    }
  } catch { return []; }
  return out;
}

/**
 * 返回"最近没做成的事"提示；没有失败时返回空串。
 * @param {{now?: number, withinMs?: number}} [opts]
 */
export function failureLine({ now = Date.now(), withinMs = 86400000 } = {}) {
  try {
    const calls = readCalls(now - withinMs);
    if (!calls.length) return '';

    // 同一个工具只报一次，附带次数和最后一个错误
    const byTool = new Map();
    for (const c of calls) {
      const cur = byTool.get(c.tool) ?? { count: 0, error: '' };
      cur.count += 1;
      if (!cur.error) cur.error = c.error;
      byTool.set(c.tool, cur);
    }
    const items = [...byTool.entries()].slice(0, 3).map(([tool, v]) => {
      const reason = v.error.replace(/^"?Error:\s*/, '').slice(0, 50);
      return `- ${tool} 失败了 ${v.count} 次${reason ? '（' + reason + '）' : ''}`;
    });

    return '【最近没做成的事】\n' + items.join('\n')
      + '\n（不用逐条解释。如果要提，就一句带过；能换个办法就换。）\n\n';
  } catch {
    return '';
  }
}
