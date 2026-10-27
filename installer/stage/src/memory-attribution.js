import crypto from 'node:crypto';
import { contentKind } from './reality.js';

export function journalEvent(row, ownerQQ) {
  const key = String(row.key || '');
  if (!/^(private|group):\d+$/.test(key) || !Number.isFinite(row.t) || row.t <= 0) return null;
  const role = row.role === 'her' ? 'self' : row.role === 'owner' && (!row.senderId || String(row.senderId) === String(ownerQQ)) ? 'owner' : 'other';
  const speakerId = role === 'self' ? 'self' : role === 'owner' ? String(ownerQQ)
    : row.senderId ? String(row.senderId) : `unknown:${crypto.createHash('sha256').update(key + ':' + (row.sender || '')).digest('hex').slice(0, 16)}`;
  const eventId = row.eventId || crypto.createHash('sha256').update(JSON.stringify([key, row.t, role, speakerId, row.text])).digest('hex').slice(0, 24);
  return { eventId, conversationKey: key, speakerId, role, eventAt: row.t,
    realityKind: row.realityKind === 'tool_observation' && row.sourceType === 'bridge_tool_result' ? 'tool_observation' : contentKind(row.text, row.role),
    ...(row.realityKind === 'tool_observation' && typeof row.toolOk === 'boolean' ? { toolOk: row.toolOk } : {}),
    messageId: row.messageId == null ? null : String(row.messageId), text: String(row.text || '').slice(0, 500) };
}

export function extractionBatches(rows, ownerQQ, maxChars = 7800) {
  const groups = new Map();
  for (const row of rows) {
    const event = journalEvent(row, ownerQQ);
    if (!event || !event.text || /^\[(图片|视频|语音|表情)\]$/.test(event.text)) continue;
    if (!groups.has(event.conversationKey)) groups.set(event.conversationKey, []);
    groups.get(event.conversationKey).push(event);
  }
  const batches = [];
  for (const events of groups.values()) {
    events.sort((a, b) => a.eventAt - b.eventAt);
    let batch = [], size = 0;
    for (const event of events) {
      const n = JSON.stringify(event).length + 1;
      if (batch.length && size + n > maxChars) { batches.push(batch); batch = []; size = 0; }
      batch.push(event); size += n;
    }
    if (batch.length) batches.push(batch);
  }
  return batches;
}

export function batchId(events) {
  return crypto.createHash('sha256').update(events.map(e => e.eventId).join('|')).digest('hex');
}

export function engagement(events) {
  const pairs = [];
  for (const e of events.filter(e => e.role === 'self')) {
    const next = events.find(r => r.role === 'owner' && r.conversationKey === e.conversationKey && r.eventAt > e.eventAt);
    if (next && next.eventAt - e.eventAt <= 600000) pairs.push({ from: e.eventId, to: next.eventId });
  }
  return { temporalPairs: pairs, warning: '只表示同一会话十分钟内有后续消息；不能证明回复质量或因果，也不能把未回复解释为冷落。' };
}

export function visibleMemory(item, key, ownerQQ) {
  if (!item.conversationKey) return key === `private:${ownerQQ}`; // Legacy summaries stay private and unverified.
  return item.conversationKey === key;
}

export function promptMemories(items, key, ownerQQ) {
  // Keep all legacy files intact, but don't repeatedly teach the model an unverified
  // identity/preference/correction (the old extractor merged all speakers as “他”).
  return items.filter(item => item.realityKind !== 'imagined' && visibleMemory(item, key, ownerQQ)
    && (item.conversationKey || ['moment','topic'].includes(item.type)));
}

export function applyExtraction(existing, parsed, events, day, now = Date.now()) {
  const byId = new Map(events.map(e => [e.eventId, e]));
  const next = existing.map(e => ({ ...e }));
  const allowedTypes = new Set(['identity','habit','preference','promise','topic','relation','moment','correction','lesson']);
  let rejected = 0;
  // Updates must supply evidence for the same person and conversation. Legacy memories remain untouched.
  for (const input of [...(Array.isArray(parsed.add) ? parsed.add : []), ...(Array.isArray(parsed.update) ? parsed.update : [])]) {
    if (!input || typeof input !== 'object') { rejected++; continue; }
    const refs = Array.isArray(input.sourceRefs) ? input.sourceRefs.map(String) : [];
    const sources = refs.map(id => byId.get(id));
    const subjectId = String(input.subjectId || '');
    const text = String(input.text || '').trim().slice(0, 160);
    if (!text || !allowedTypes.has(input.type) || !sources.length || sources.some(s => !s || s.realityKind === 'imagined')
      || !sources.some(s => s.speakerId === subjectId) || new Set(sources.map(s => s.conversationKey)).size !== 1) { rejected++; continue; }
    const key = sources[0].conversationKey;
    if (input.type === 'promise' && !sources.some(s => s.speakerId === subjectId && s.role !== 'other')) { rejected++; continue; }
    const old = input.id ? next.find(e => e.id === input.id) : null;
    if (input.id && (!old || old.subjectId !== subjectId || old.conversationKey !== key)) { rejected++; continue; }
    const id = old?.id || 'e-' + crypto.createHash('sha256').update(JSON.stringify([key, subjectId, input.type, [...refs].sort()])).digest('hex').slice(0, 24);
    const item = { ...(old || {}), id, text, type: input.type, weight: input.type === 'correction' ? 3 : Math.max(1, Math.min(3, Number(input.weight) || 1)),
      subjectId, conversationKey: key, sourceRefs: [...new Set(refs)], evidence: sources,
      realityKind: sources.every(s => s.realityKind === 'tool_observation') ? 'tool_observation' : subjectId === 'self' ? 'self_report' : 'reported',
      createdAt: old?.createdAt || now, lastSeenAt: Math.max(...sources.map(s => s.eventAt)), source: day };
    const failures = sources.filter(s => s.realityKind === 'tool_observation' && s.toolOk === false);
    if (failures.length) {
      item.text = failures.map(s => s.text).join('；').slice(0, 160);
      item.realityKind = 'tool_observation';
    }
    if (item.type === 'promise') {
      item.promisor = subjectId;
      item.condition = String(input.condition || '').slice(0, 200);
      // Require an explicit timezone. A relative “tomorrow” must be resolved using eventAt, not extraction time.
      item.dueAt = resolvePromiseDue(input.dueAt, sources.filter(s => s.speakerId === subjectId));
    }
    const idx = next.findIndex(e => e.id === id);
    if (idx >= 0) next[idx] = item; else next.push(item);
  }
  return { items: next, rejected };
}

export function resolvePromiseDue(value, sources) {
  const raw = String(value || '');
  let due = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw) && Number.isFinite(Date.parse(raw)) ? Date.parse(raw) : null;
  const source = sources.find(s => /明天|明早|明晚|今天|今晚/.test(s.text));
  if (source) {
    const tomorrow = /明天|明早|明晚/.test(source.text);
    const day = new Date(source.eventAt + 8 * 3600000 + (tomorrow ? 86400000 : 0)).toISOString().slice(0, 10);
    if (!due || new Date(due + 8 * 3600000).toISOString().slice(0, 10) !== day) {
      due = Date.parse(day + (/明早/.test(source.text) ? 'T12:00:00+08:00' : 'T23:59:59+08:00'));
    }
  }
  return due;
}
