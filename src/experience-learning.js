import crypto from 'node:crypto';
import { readJson, updateJson } from './state-store.js';

export const LEARNING_TTL = 30 * 60000;
const empty = () => ({ version: 1, experiences: [], reflections: [], applications: [], reviews: [] });
const id = () => crypto.randomUUID();
const validKey = key => /^(private|group):\d+$/.test(key || '');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Only machine configuration participates. Prompts, credentials and conversation identities do not.
export function drawingScope(provider, config = {}) {
  const service = config[provider] || {};
  return digest([provider, service.baseUrl || '', service.checkpoint || '', config.fallback ?? true]);
}

export function recordDrawingExperience(file, { scope, provider, attempts, at = Date.now(), applicationId = null }) {
  if (typeof scope !== 'string' || !scope || !Array.isArray(attempts) || !attempts.length) throw new Error('绘图经历缺少执行证据');
  if (attempts.some(a => !['failed','succeeded'].includes(a.outcome))) throw new Error('绘图结果无效');
  const eventId = digest(['drawing_execution', scope, provider, at, applicationId, attempts]);
  let result;
  updateJson(file, empty(), store => {
    if (store.experiences.some(e => e.id === eventId)) return store;
    const observed = attempts.map(a => ({ provider: a.provider, outcome: a.outcome, ...(a.category ? { category: a.category } : {}) }));
    store.experiences.push({ id: eventId, at, source: 'drawing_execution', scope, provider, attempts: observed,
      limitation: '只证明工具生成结果，不证明作品符合主题、已交付或用户满意' });
    let reflection = store.reflections.find(r => r.kind === 'drawing_route' && r.scope === scope);
    const primary = observed.find(a => a.provider === provider);
    const local = observed.find(a => a.provider === 'local_illustration');
    const recoverable = primary?.outcome === 'failed' && ['unavailable','timeout'].includes(primary.category);
    if (recoverable && local?.outcome === 'succeeded' && provider !== 'local_illustration') {
      if (!reflection) {
        reflection = { id: id(), kind: 'drawing_route', scope, provider, evidenceIds: [], createdAt: at, disabled: false };
        store.reflections.push(reflection);
      }
      reflection.state = 'active'; reflection.updatedAt = at; reflection.probeAt = at + LEARNING_TTL;
      reflection.evidenceIds.push(eventId);
      reflection.conclusion = '主绘图服务连接失败或超时，本地插画生成成功；原因是执行条件，不是画技不足';
      reflection.action = 'prefer_local_then_probe';
      reflection.limitation = '仅对相同服务配置、允许备用且适用本地场景的请求生效；过期重新探测主服务';
    } else if (reflection && (primary?.outcome === 'succeeded' || local?.outcome === 'failed')) {
      reflection.state = primary?.outcome === 'succeeded' ? 'resolved' : 'needs_review';
      reflection.updatedAt = at; reflection.evidenceIds.push(eventId);
    }
    const application = store.applications.find(a => a.id === applicationId);
    if (application) {
      application.outcome = observed.some(a => a.outcome === 'succeeded') ? 'generated' : 'failed';
      application.finishedAt = at; application.evidenceId = eventId;
      application.localWorked = local?.outcome === 'succeeded';
      application.primaryRecovered = primary?.outcome === 'succeeded';
    }
    result = { experienceId: eventId, reflectionId: reflection?.id };
    return store;
  });
  return result;
}

export function chooseDrawingBehavior(file, { scope, provider, allowFallback, localSuitable = false, now = Date.now() }) {
  const store = readJson(file, empty());
  const reflection = store.reflections.find(r => r.kind === 'drawing_route' && r.scope === scope && r.provider === provider);
  if (!allowFallback || !localSuitable || !reflection || reflection.disabled || reflection.state !== 'active' || reflection.probeAt <= now) return null;
  let application;
  updateJson(file, empty(), current => {
    const latest = current.reflections.find(r => r.id === reflection.id);
    if (!latest || latest.disabled || latest.state !== 'active' || latest.probeAt <= now) return current;
    application = { id: id(), reflectionId: latest.id, scope, at: now, outcome: 'pending',
      baseline: [provider, 'local_illustration'], chosen: ['local_illustration', provider],
      reason: '同一服务近期连接失败而本地备用成功，先用适用的备用场景；失败则再试主服务', probeAt: latest.probeAt };
    current.applications.push(application); return current;
  });
  return application || null;
}

export function reflectToolObservation(file, event) {
  if (!event?.id || event.realityKind !== 'tool_observation' || event.sourceType !== 'bridge_tool_result' || !validKey(event.conversationKey) || typeof event.ok !== 'boolean') return null;
  if (!/^qq_(draw|sketch|send_image|send_message|say|project_workflow|commitments)$/.test(event.tool)) return null;
  // Fixed interpretations of actual tool status. No free-form model lesson can become executable policy.
  const eventId = 'tool:' + event.id;
  updateJson(file, empty(), store => {
    if (store.experiences.some(e => e.id === eventId)) return store;
    store.experiences.push({ id: eventId, at: event.at, source: 'bridge_tool_result', conversationKey: event.conversationKey, tool: event.tool, ok: event.ok });
    let rule = store.reflections.find(r => r.kind === 'tool_retry' && r.conversationKey === event.conversationKey && r.tool === event.tool);
    if (!event.ok) {
      if (!rule) {
        rule = { id: id(), kind: 'tool_retry', conversationKey: event.conversationKey, tool: event.tool, evidenceIds: [], disabled: false, createdAt: event.at };
        store.reflections.push(rule);
      }
      rule.state = 'active'; rule.updatedAt = event.at; rule.probeAt = event.at + LEARNING_TTL;
      rule.action = 'inspect_before_retry'; rule.evidenceIds.push(eventId);
      rule.conclusion = '这个工具实际返回失败；先核对原因与前置条件，避免原样重复';
      rule.limitation = '失败不证明能力不足或用户不喜欢；发送结果不明时先查回执，不能盲目重发';
    } else if (rule) { rule.state = 'resolved'; rule.updatedAt = event.at; rule.evidenceIds.push(eventId); }
    return store;
  });
  return eventId;
}

export function learningView(file, key, now = Date.now()) {
  const store = readJson(file, empty());
  const reflections = store.reflections.filter(r => r.kind === 'drawing_route' || r.conversationKey === 'machine' || r.conversationKey === key)
    .map(r => ({ ...r, effective: !r.disabled && r.state === 'active' && (r.requiresVerification || r.probeAt > now) }));
  const allowed = new Set(reflections.map(r => r.id));
  const sources = new Set(reflections.flatMap(r => r.evidenceIds));
  return { version: store.version, reflections,
    experiences: store.experiences.filter(e => sources.has(e.id)),
    applications: store.applications.filter(a => allowed.has(a.reflectionId)),
    reviews: store.reviews.filter(r => allowed.has(r.reflectionId)) };
}

export function reviewLearning(file, key, { reflectionId, action, reason }, now = Date.now()) {
  if (!['disable','enable'].includes(action) || typeof reason !== 'string' || !reason.trim()) throw new Error('需要明确的启停动作和原因');
  updateJson(file, empty(), store => {
    const rule = store.reflections.find(r => r.id === reflectionId && (r.kind === 'drawing_route' || r.conversationKey === 'machine' || r.conversationKey === key));
    if (!rule) throw new Error('经验规则不存在或属于其他会话');
    rule.disabled = action === 'disable';
    store.reviews.push({ id: id(), reflectionId, action, reason: reason.trim().slice(0, 600), at: now, source: 'authenticated_operator' });
    return store;
  });
  return learningView(file, key, now);
}

export function learningHint(file, key, now = Date.now(), scope = null) {
  let view;
  try { view = learningView(file, key, now); }
  catch { return '\n【经验状态】经验文件暂不可读，未覆盖旧记录；依据当前工具结果行动，不声称沿用了历史经验。\n'; }
  const active = view.reflections.filter(r => r.effective && (r.kind !== 'drawing_route' || !scope || r.scope === scope)).slice(-6);
  if (!active.length) return '';
  const behavior = r => {
    if (r.kind === 'tool_delivery') return r.requiresVerification
      ? '发送结果尚待核对；执行层已停止重复发送，必须先找实际回执。'
      : r.action === 'reuse_confirmed_receipt' ? '已经有成功发送回执；执行层复用该回执，避免重复交付。' : '上次网关明确拒绝；执行层短暂退避，条件改变后再决定是否发送。';
    if (r.kind === 'tool_execution') return r.requiresVerification
      ? '发送结果不明，执行层不会盲目重复合成再发；先核对实际回执。'
      : r.action === 'use_configured_fallback' ? '相同执行条件下主方法失败；执行层优先采用既定备用，备用也失败则停止重复。'
      : '上次实际执行失败；执行层已重读状态与证据，条件不变就暂停同一请求，修正输入或补齐条件后再执行。';
    return `${r.tool} 近期失败；先查执行条件和实际回执，再决定是否换路或停止，不能原样反复尝试。`;
  };
  return '\n【有执行证据的经验与行动调整】\n' + active.map(r =>
    `${r.id}：${r.kind === 'drawing_route' ? '近期主绘图连接失败、备用生成成功；qq_draw 对适用的有限场景明确选择 fallbackTemplate 后先走备用，定时重探主服务。不适用就不选，不要用简单模板冒充复杂作品。必须说明备用限制并实际看图。' : behavior(r)} 证据数:${r.evidenceIds.length}，${r.requiresVerification ? '核对回执前不自动解锁' : '有效至:' + new Date(r.probeAt).toISOString()}。`).join('\n')
    + '\n这些只是有限条件下的经验，不是人格定论；工具成功不等于用户满意，未回复不能推断讨厌。\n';
}
