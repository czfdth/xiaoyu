import fs from 'node:fs';
import crypto from 'node:crypto';
import { readJson, updateJson } from './state-store.js';
import { digest } from './adaptive-tools.js';

const empty = () => ({ version: 1, operations: [] });
const lessons = () => ({ version: 1, experiences: [], reflections: [], applications: [], reviews: [] });
export function deliveryPayload(params) {
  return { ...params, message: Array.isArray(params.message) ? params.message.map(s => {
    const file = s.data?.file;
    if (!file || !['image','record','video'].includes(s.type)) return s;
    let bytes;
    if (file.startsWith('base64://')) bytes = Buffer.from(file.slice(9), 'base64');
    else { try { bytes = fs.readFileSync(file); } catch { /* retain filename identity if unavailable */ } }
    return bytes ? { ...s, data: { ...s.data, file: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') } } : s;
  }) : params.message };
}
export function deliveryIntent(socialFile, key) {
  const st = readJson(socialFile, { conversations: {} }).conversations?.[key] || {};
  const incoming = (st.recentMessages || []).filter(m => !m.isSelf).at(-1);
  return digest([st.lastIncomingAt || 0, incoming?.messageId || null]);
}
export class DeliveryUncertain extends Error {
  constructor(id, pending = false) {
    super(`[${pending ? 'DELIVERY_PENDING' : 'DELIVERY_UNCERTAIN'}] 本次没有重发；发送结果待核对，先查询成功回执。操作:${id}`);
    this.code = pending ? 'DELIVERY_PENDING' : 'DELIVERY_UNCERTAIN'; this.operationId = id;
  }
}
function receipt(file, operationId, key, requestHash) {
  if (!file || !fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n').reverse()) {
    if (!line) continue;
    let row;try { row = JSON.parse(line); } catch { continue; }
    if (row.operationId === operationId && row.key === key && row.requestHash === requestHash && row.messageId != null) return row;
  }
  return null;
}

// Persist the intent BEFORE touching the network. A crash/timeout cannot silently become a new send.
export async function guardedDelivery({ file, learningFile, receiptsFile, key, intent, request, condition,
  execute, verify, tool = 'qq_send_message', now = Date.now }) {
  const requestHash = digest(request), at = now();let operation, created = false;
  updateJson(file, empty(), store => {
    operation = [...store.operations].reverse().find(o => o.key === key && o.requestHash === requestHash
      && (['pending','uncertain'].includes(o.status) || (o.intent === intent && o.condition === condition && at - o.at < (o.status === 'succeeded' ? 120000 : 30000))));
    if (!operation) {
      created = true;operation = { id: crypto.randomUUID(), key, intent, requestHash, condition, at, status: 'pending' };
      store.operations.push(operation);
    }
    return store;
  });
  const learn = (outcome, messageId = null) => {
    if (!learningFile) return;
    try { updateJson(learningFile, lessons(), store => {
      const eventId = crypto.randomUUID(), stamp = now();
      store.experiences.push({ id: eventId, at: stamp, source: created ? 'delivery_execution' : 'delivery_verification',
        conversationKey: key, tool, operationId: operation.id, outcome, ...(messageId != null ? { messageId: String(messageId) } : {}) });
      let rule = store.reflections.find(r => r.kind === 'tool_delivery' && r.operationId === operation.id);
      if (!rule) {
        rule = { id: crypto.randomUUID(), kind: 'tool_delivery', conversationKey: key, tool, operationId: operation.id,
          state: 'active', disabled: false, evidenceIds: [], createdAt: stamp, probeAt: stamp + 120000 };
        store.reflections.push(rule);
      }
      rule.evidenceIds.push(eventId);
      rule.action = ['confirmed','reused_receipt','recovered_receipt'].includes(outcome) ? 'reuse_confirmed_receipt' : 'verify_before_resend';
      rule.requiresVerification = ['uncertain','verification_required'].includes(outcome);
      rule.conclusion = '依据真实回执复用已发送部分；结果不明时先停发核对，不猜测发送失败';
      if (!created) store.applications.push({ id: crypto.randomUUID(), reflectionId: rule.id, at: stamp,
        baseline: ['send_again'], chosen: [outcome === 'reused_receipt' || outcome === 'recovered_receipt' ? 'reuse_receipt' : 'pause_and_verify'],
        outcome, evidenceId: eventId, finishedAt: stamp });
      return store;
    }); } catch { /* A learning log failure must never cause another send. */ }
  };
  const complete = result => {
    updateJson(file, empty(), store => {
      const row = store.operations.find(o => o.id === operation.id);
      row.status = 'succeeded';row.result = { message_id: result.message_id };row.finishedAt = now();return store;
    });
    return result;
  };
  if (!created) {
    const found = receipt(receiptsFile, operation.id, key, requestHash);
    if (found) { const data = complete({ message_id: found.messageId });learn('recovered_receipt', found.messageId);return { ...data, adaptiveDelivery: { reused: true, operationId: operation.id } }; }
    if (operation.status === 'succeeded') {
      // Persisted success is an actual gateway acknowledgement. Verify it by read-only get_msg when available.
      if (verify) {
        try { const msg = await verify(operation.result.message_id);if (String(msg?.message_id) !== String(operation.result.message_id)) throw new Error('回执无法核对'); }
        catch { learn('verification_required');throw new DeliveryUncertain(operation.id); }
      }
      learn('reused_receipt', operation.result.message_id);
      return { ...operation.result, adaptiveDelivery: { reused: true, operationId: operation.id } };
    }
    if (operation.status === 'rejected') {
      learn('rejected_repeat_paused');const e = new Error('[ADAPTIVE_PAUSED] 上次网关明确拒绝，30秒内条件未变，本次未重复发送');e.code='ADAPTIVE_PAUSED';throw e;
    }
    learn('verification_required');throw new DeliveryUncertain(operation.id, operation.status === 'pending');
  }
  let result;
  try {
    result = await execute({ operationId: operation.id, requestHash });
    if (result?.message_id == null) throw new Error('网关没有返回可核对的消息 ID');
  } catch (error) {
    // Only a structured rejection proves non-delivery. Transport errors/HTTP 5xx/invalid JSON are ambiguous.
    const rejected = Number(error?.retcode) >= 100 || [400,401,403,404,422,429].includes(Number(error?.status));
    updateJson(file, empty(), store => { const row = store.operations.find(o => o.id === operation.id);
      row.status = rejected ? 'rejected' : 'uncertain';row.finishedAt = now();return store; });
    learn(rejected ? 'rejected' : 'uncertain');
    if (!rejected) throw new DeliveryUncertain(operation.id);
    throw error;
  }
  // If this write fails, the pending intent and (normally) the receipt remain. Never re-run execute.
  complete(result);learn('confirmed', result.message_id);
  return { ...result, adaptiveDelivery: { reused: false, operationId: operation.id } };
}
