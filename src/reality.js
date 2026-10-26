import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function contentKind(text, role = 'her') {
  if (/梦见|梦到|幻想|想象中|梦境/.test(String(text))) return 'imagined';
  return role === 'her' ? 'self_report' : 'reported';
}

export function narrativeRecord(kind, fields) {
  if (!['dream','fantasy','diary','memoir','introspection','body','inner'].includes(kind)) throw new Error('未知叙述类别');
  return { ...fields, sourceType: kind, realityKind: ['dream','fantasy'].includes(kind) ? 'imagined' : 'self_report' };
}

export function recordToolObservation(file, entry) {
  if (entry.type !== 'result' || !/^(private|group):\d+$/.test(entry.key || '') || typeof entry.ok !== 'boolean' || !entry.tool) return null;
  const row = { id: crypto.randomUUID(), at: Date.parse(entry.time) || Date.now(), conversationKey: entry.key,
    realityKind: 'tool_observation', sourceType: 'bridge_tool_result', tool: entry.tool,
    ok: entry.ok, detail: String(entry.error || '').slice(0, 350),
    limitation: '仅证明工具返回的执行状态；不证明收件人已读、作品质量或叙述内容真实' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
  return row;
}

export function readObservations(file, key, limit = 5) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.realityKind === 'tool_observation' && row.sourceType === 'bridge_tool_result'
      && typeof row.ok === 'boolean' && (!key || row.conversationKey === key)) rows.push(row);
  }
  return rows.slice(-Math.min(10000, Math.max(1, limit)));
}

export function realityHint(file, key) {
  const rows = readObservations(file, key, 30).filter(e => /draw|sketch|send_|say|project|commitment/.test(e.tool)).slice(-5);
  return '\n【事件来源】收到的消息只证明对方这样说过；自己的日记、回忆录、身体感觉属于叙述，梦和幻想没有实际发生。工具失败以返回原因为准，不能把断网改写成手艺不好；没有执行记录的空闲时间不能编成真实活动。\n'
    + (rows.length ? '【当前会话的工具记录】\n' + rows.map(e => `事件:${e.id} ${new Date(e.at).toISOString()} ${e.tool}: ${e.ok ? '工具返回成功（不等于已读或质量合格）' : '失败：' + e.detail}`).join('\n') + '\n' : '');
}
