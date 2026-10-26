import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, updateJson } from './state-store.js';

const ACTIVE = new Set(['pending', 'in_progress', 'blocked']);
const STATUSES = new Set([...ACTIVE, 'needs_review', 'completed', 'cancelled']);

export function listCommitments(file, memoryFile, key, ownerQQ) {
  const store = readJson(file, { items: [] });
  const items = store.items.filter(e => e.conversationKey === key);
  const known = new Set(store.items.map(e => e.memoryId).filter(Boolean));
  for (const m of readJson(memoryFile, { items: [] }).items || []) {
    if (m.type !== 'promise' || known.has(m.id)) continue;
    const scope = m.conversationKey || `private:${ownerQQ}`;
    if (scope !== key) continue;
    // Old summaries are retained verbatim and never silently promoted to outstanding promises.
    items.push({ id: `memory:${m.id}`, memoryId: m.id, text: m.text, conversationKey: scope,
      promisor: m.promisor || null, dueAt: m.dueAt || null, condition: m.condition || '',
      status: 'needs_review', sourceRefs: m.sourceRefs || [], legacy: !m.conversationKey });
  }
  return items;
}

export function dueCommitments(items, now = Date.now()) {
  return items.filter(e => ACTIVE.has(e.status) && e.status !== 'blocked' && e.promisor === 'self'
    && Number.isFinite(e.dueAt) && e.dueAt <= now && !e.condition)
    .sort((a, b) => a.dueAt - b.dueAt);
}

function verifiedEvidence(input, context) {
  const evidence = [];
  if (input.evidencePath) {
    const candidate = path.resolve(context.root, input.evidencePath);
    const real = fs.realpathSync(candidate);
    const roots = ['images','audio','state/diary','state/memoir'].map(p => path.resolve(context.root, p));
    if (!roots.some(root => {
      if (!fs.existsSync(root)) return false;
      const relative = path.relative(fs.realpathSync(root), real);
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    })) throw new Error('完成证据必须是本项目的作品或日记文件');
    const stat = fs.statSync(real);
    if (!stat.isFile() || !stat.size || stat.size > 64 * 1024 * 1024) throw new Error('完成证据文件无效');
    if (!/\.(png|jpe?g|webp|gif|wav|mp3|ogg|flac|mp4|md|txt)$/i.test(real)) throw new Error('不支持此证据格式');
    evidence.push({ kind: 'artifact', path: path.relative(context.root, real), size: stat.size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex') });
  }
  if (input.deliveredMessageId != null) {
    const id = String(input.deliveredMessageId);
    const sent = context.messages.find(m => m.isSelf && String(m.messageId) === id);
    if (!sent) throw new Error('找不到同一会话的成功发送记录，不能认定已经交付');
    evidence.push({ kind: 'delivery', messageId: id, at: sent.time || sent.at, artifactHashes: sent.artifactHashes || [] });
  }
  return evidence;
}

export function verifyArtifact(root, evidencePath) {
  return verifiedEvidence({ evidencePath }, { root, messages: [] })[0];
}

export function changeCommitment(file, memoryFile, key, ownerQQ, input, context) {
  const views = listCommitments(file, memoryFile, key, ownerQQ);
  const now = context.now || Date.now();
  const due = input.dueAt == null || input.dueAt === '' ? null : Date.parse(input.dueAt);
  if (input.dueAt && (!/(?:Z|[+-]\d{2}:\d{2})$/.test(input.dueAt) || !Number.isFinite(due))) throw new Error('dueAt 需要带时区的明确日期');
  let result;
  updateJson(file, { version: 1, items: [] }, store => {
    let item = input.id ? store.items.find(e => e.id === input.id && e.conversationKey === key) : null;
    if (!item && input.id) {
      const legacy = views.find(e => e.id === input.id);
      if (!legacy) throw new Error('找不到这条承诺');
      item = { ...legacy, createdAt: now, history: [] };
      store.items.push(item);
    }
    if (!item) {
      const source = context.messages.find(m => String(m.messageId) === String(input.sourceMessageId) && m.messageId != null);
      if (!source) throw new Error('新承诺必须关联同一会话的消息 ID');
      const text = String(input.text || '').trim().slice(0, 200);
      if (!text) throw new Error('承诺内容不能为空');
      const promisor = source.isSelf ? 'self' : source.isOwner ? String(ownerQQ) : null;
      if (!promisor) throw new Error('不能替群友创建用户的承诺');
      item = { id: `c-${crypto.randomUUID()}`, conversationKey: key, text, promisor,
        status: 'pending', dueAt: due, condition: String(input.condition || '').slice(0, 200),
        deliveryRequired: input.deliveryRequired !== false, sourceMessageId: String(source.messageId),
        createdAt: now, history: [] };
      store.items.push(item);
    }
    if (['completed','cancelled'].includes(item.status)) throw new Error('已结案；需要新约定时请另建承诺');
    const status = input.status || item.status;
    if (!STATUSES.has(status)) throw new Error('未知承诺状态');
    if (item.status === 'needs_review' && status !== 'needs_review' && status !== 'cancelled') {
      // A legacy summary needs an actual promise message before it may become actionable.
      const source = context.messages.find(m => m.messageId != null && String(m.messageId) === String(input.sourceMessageId));
      if (!source || (!source.isSelf && !source.isOwner)) throw new Error('旧承诺需用原话或重新确认的消息核实');
      item.promisor = source.isSelf ? 'self' : String(ownerQQ);
      item.sourceMessageId = String(source.messageId);
      item.deliveryRequired = input.deliveryRequired !== false;
      item.legacy = false;
    }
    if (input.dueAt !== undefined) item.dueAt = due;
    if (input.condition !== undefined) item.condition = String(input.condition).slice(0, 200);
    if (status === 'blocked' && !String(input.note || '').trim()) throw new Error('受阻时请记录原因和下一步');
    if (status === 'completed') {
      const evidence = verifiedEvidence(input, context);
      const delivery = evidence.find(e => e.kind === 'delivery');
      if (delivery && (delivery.messageId === item.sourceMessageId || !Number.isFinite(delivery.at) || delivery.at < item.createdAt)) {
        throw new Error('承诺原话或旧消息不是这次履约的交付证据');
      }
      const needsArtifact = /画|图|作品|录音|唱歌|写.*(?:日记|故事|文章|回忆)/.test(item.text);
      if (!evidence.length || (needsArtifact && !evidence.some(e => e.kind === 'artifact'))
        || ((item.deliveryRequired !== false || /给|发|交付|告诉|提醒/.test(item.text)) && !evidence.some(e => e.kind === 'delivery'))) {
        throw new Error('完成需要可核验的证据；答应交付的事情还需要成功发送的消息 ID');
      }
      const media = evidence.find(e => e.kind === 'artifact' && /\.(png|jpe?g|gif|webp|wav|mp3|ogg|flac|mp4)$/i.test(e.path));
      if (delivery && media && !delivery.artifactHashes.includes(media.sha256)) throw new Error('交付回执与这件作品不匹配');
      item.evidence = evidence;
      item.completedAt = now;
    }
    item.history ||= [];
    item.history.push({ at: now, from: item.status, to: status, note: String(input.note || '').slice(0, 300) });
    item.status = status; item.updatedAt = now;
    result = item;
    return store;
  });
  return result;
}

export function commitmentHint(items) {
  const open = items.filter(e => !['completed','cancelled'].includes(e.status)).slice(0, 6);
  return '\n【约定与待办】答应具体事情后，用成功发出的原话消息 ID 调用 qq_commitments 登记；没有明确答应不要自动立约。\n' + open.map(e => `${e.id} [${e.status}] ${e.text}${e.dueAt ? ' 到期:' + new Date(e.dueAt).toISOString() : ''}${e.condition ? ' 条件:' + e.condition : ''}`).join('\n')
    + '\n用 qq_commitments 接续或更新；needs_review 是未核实旧摘要，不要当作失约或直接催办。完成以工具与交付证据为准，受阻要记录原因，不能只口头说完成。\n';
}
