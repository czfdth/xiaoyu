import fs from 'node:fs';
import crypto from 'node:crypto';
import { readJson, updateJson } from './state-store.js';

const empty = () => ({ version: 1, experiences: [], reflections: [], applications: [], reviews: [] });
export const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function stateFingerprint(files = [], context = null) {
  return digest([context, files.map(file => {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
    catch (e) { return e.code === 'ENOENT' ? 'missing' : 'unreadable'; }
  })]);
}
export function failureClass(error) {
  const text = `${error?.code || ''} ${error?.cause?.code || ''} ${error?.message || error}`;
  if (/DELIVERY_UNCERTAIN|DELIVERY_PENDING/.test(text)) return 'delivery_unknown';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|connect|timeout|abort|超时|HTTP\s*(502|503|504)/i.test(text)) return 'unavailable';
  if (/ENOENT|not found|未配置|没配|No module|Cannot find|ModuleNotFound|not recognized/i.test(text)) return 'dependency';
  if (/证据|回执|草稿|检查|图片|任务|用户|步骤|归档|匹配|约定|重试时间/.test(text)) return 'precondition';
  return 'execution';
}
export class AdaptivePause extends Error {
  constructor(rule) {
    super(`[${rule.requiresVerification ? 'DELIVERY_UNCERTAIN' : 'ADAPTIVE_PAUSED'}] 上次执行失败后，输入与条件未变，本次未重复执行。${rule.requiresVerification ? '先核对发送回执，不能盲目重发。' : '请先补齐依赖、修正输入或更新实际状态/证据；到期可再探测。'} 经验:${rule.id}`);
    this.code = rule.requiresVerification ? 'DELIVERY_UNCERTAIN' : 'ADAPTIVE_PAUSED';
    this.reflectionId = rule.id;
  }
}

// The caller supplies a fixed executable fallback, never code or instructions from a model lesson.
export async function runAdaptiveOperation({ file, tool, key, input, condition, execute, fallback,
  serviceInput = null, intent = null, ttl = 30 * 60000, now = Date.now }) {
  const inputHash = digest(input), serviceHash = serviceInput == null ? null : digest(serviceInput);
  const intentHash = digest(intent);
  let rule, warning;
  try {
    rule = readJson(file, empty()).reflections.find(r => r.kind === 'tool_execution' && r.tool === tool && r.conversationKey === key
      && (r.condition === condition || (r.requiresVerification && r.intentHash === intentHash)) && (r.inputHash === inputHash || (serviceHash && r.inputHash === serviceHash && r.serviceWide))
      && (!r.disabled || r.requiresVerification) && r.state === 'active' && (r.requiresVerification || r.probeAt > now()));
  } catch { warning = '经验不可读，未覆盖旧记录'; }
  let applicationId;
  const application = (reflection, chosen) => {
    const aid = crypto.randomUUID();
    try { updateJson(file, empty(), s => { s.applications.push({ id: aid, reflectionId: reflection.id, at: now(),
      baseline: ['execute'], chosen: [chosen], outcome: 'pending' }); return s; }); applicationId = aid; }
    catch { warning = '经验采用记录未保存'; }
  };
  const finish = (reflection, ok, outcome, error = null, alternate = false) => {
    const eventId = crypto.randomUUID(), at = now();
    try {
      updateJson(file, empty(), s => {
        s.experiences.push({ id: eventId, at, source: outcome === 'not_reexecuted' ? 'adaptive_decision' : 'adaptive_tool_execution', conversationKey: key, tool, inputHash, condition,
          ok, outcome, ...(error ? { failureClass: failureClass(error) } : {}) });
        const app = s.applications.find(a => a.id === applicationId);
        if (app) { app.outcome = outcome; app.finishedAt = at; app.evidenceId = eventId; }
        if (reflection) {
          const r = s.reflections.find(r => r.id === reflection.id);
          if (r) { r.evidenceIds.push(eventId); if (alternate && !ok) r.alternateFailed = true; }
        }
        if (ok && !alternate) {
          for (const r of s.reflections.filter(r => r.kind === 'tool_execution' && r.tool === tool && r.conversationKey === key
            && (r.inputHash === inputHash || (serviceHash && r.inputHash === serviceHash)))) {
            r.state = 'resolved'; r.updatedAt = at; if (!r.evidenceIds.includes(eventId)) r.evidenceIds.push(eventId);
          }
        }
        return s;
      });
    } catch { warning = '执行完成但经验更新失败；不能声称已经学会'; }
  };
  const alternate = async reflection => {
    application(reflection, 'fallback');
    try { const value = await fallback(); finish(reflection, true, 'fallback_succeeded', null, true); return value; }
    catch (e) { finish(reflection, false, 'fallback_failed', e, true); throw e; }
  };
  if (rule) {
    if (fallback && !rule.alternateFailed && !rule.requiresVerification) return alternate(rule);
    application(rule, 'pause_and_refresh'); finish(rule, false, 'not_reexecuted'); throw new AdaptivePause(rule);
  }
  try { const value = await execute(); finish(null, true, 'executed'); return value; }
  catch (error) {
    if(/SITUATION_PAUSED|AGENCY_HOLD/.test(String(error?.message)))throw error;
    // Rejections from an inner guard are decisions, not new failed executions. Do not prolong cooldowns.
    if (error instanceof AdaptivePause || ['ADAPTIVE_PAUSED','DELIVERY_UNCERTAIN','DELIVERY_PENDING'].includes(error.code)) throw error;
    const category = failureClass(error), at = now();
    const serviceWide = serviceHash && ['unavailable','dependency'].includes(category);
    let reflection;
    try {
      updateJson(file, empty(), s => {
        const eventId = crypto.randomUUID();
        s.experiences.push({ id: eventId, at, source: 'adaptive_tool_execution', conversationKey: key, tool,
          inputHash, condition, ok: false, outcome: 'failed', failureClass: category });
        reflection = s.reflections.find(r => r.kind === 'tool_execution' && r.tool === tool && r.conversationKey === key
          && r.inputHash === (serviceWide ? serviceHash : inputHash) && r.condition === condition);
        if (!reflection) {
          reflection = { id: crypto.randomUUID(), kind: 'tool_execution', conversationKey: key, tool, inputHash: serviceWide ? serviceHash : inputHash,
            serviceWide: Boolean(serviceWide), condition, intentHash, createdAt: at, evidenceIds: [], disabled: false };
          s.reflections.push(reflection);
        }
        reflection.state = 'active'; reflection.updatedAt = at; reflection.probeAt = at + ttl;
        reflection.requiresVerification = category === 'delivery_unknown'; reflection.evidenceIds.push(eventId);
        reflection.action = fallback ? 'use_configured_fallback' : 'pause_until_conditions_change';
        reflection.conclusion = '相同条件下实际执行失败，下一次先换既定备用或停止重复执行';
        return s;
      });
    } catch { warning = '失败经验未保存，未覆盖原数据'; }
    if (fallback) return alternate(reflection || { id: null });
    if (warning) error.learningWarning = warning;
    throw error;
  }
}
