export function shanghaiDay(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

export function proactiveDecision({ status, state, now = Date.now(), random = Math.random(), due = [], work = null, practice = null, counter = {} }) {
  if (status?.mode !== 'reserved2' || status.socialV2Paused || status.dshReady !== true) return { ok: false, reason: '大脑未就绪或模式不符' };
  if (status.snowluma?.connected !== true || status.snowluma?.accountOnline === false || status.snowluma?.good === false) return { ok: false, reason: 'QQ 网关离线，不发起社交唤醒' };
  const hour = new Date(now + 8 * 3600000).getUTCHours();
  if (hour >= 1 && hour <= 7) return { ok: false, reason: '安静时段' };
  if (state?.ok !== true || !Number.isFinite(state.lastIncomingAt) || state.lastIncomingAt <= 0 || state.lastIncomingAt > now) return { ok: false, reason: '缺少有效来信时间，不能猜测空闲时长' };
  if (!Number.isFinite(state.unreadCount) || state.unreadCount > 0) return { ok: false, reason: '尚有未处理消息或未读状态未知' };
  if (now - state.lastIncomingAt < 240000) return { ok: false, reason: '刚有来信' };
  if (Number.isFinite(state.lastAiReplyAt) && state.lastAiReplyAt > 0 && now - state.lastAiReplyAt < 360000) return { ok: false, reason: '刚发过消息' };
  const contactQuiet=state.relationship?.proactiveDisabled===true;
  const task = (contactQuiet?[]:due).find(e => e.id !== counter.lastCommitmentId || now - (counter.lastCommitmentWakeAt || 0) >= 1800000);
  if (task) return { ok: true, reason: 'commitment', commitmentId: task.id };
  if (due.length&&!contactQuiet) return { ok: false, reason: '约定刚检查过，等待执行反馈' };
  if(state.agency?.enabled&&state.agency.hasGoals) {
    const next=state.agency.next;
    if(!next)return {ok:false,reason:state.agency.hold||'主目标暂不可推进'};
    if(next.kind==='project')return {ok:true,reason:'project',projectTaskId:next.id};
    if(next.kind==='practice')return {ok:true,reason:'practice',practiceId:next.id};
    return {ok:false,reason:'没有可核对的目标动作'};
  }
  if (work) {
    if (work.id === counter.lastProjectId && now - (counter.lastProjectWakeAt || 0) < 1800000) return { ok: false, reason: '页面刚推进过，等待下一次独立活动' };
    return { ok: true, reason: 'project', projectTaskId: work.id };
  }
  if(practice) {
    if(practice.id===counter.lastPracticeId&&now-(counter.lastPracticeWakeAt||0)<1800000)return {ok:false,reason:'练习刚检查过，等待下一次独立活动'};
    return {ok:true,reason:'practice',practiceId:practice.id};
  }
  if(contactQuiet)return {ok:false,reason:'用户要求暂不主动打扰'};
  if(state.situation?.proactiveAllowed===false)return {ok:false,reason:'当前情境无需再次主动联系'};
  if (random > 0.65) return { ok: false, reason: '本次保持安静' };
  return { ok: true, reason: 'proactiveCheck' };
}

export async function runProactive({ baseUrl, headers, key, counter, due = [], work = null, practice = null, now = Date.now(), random, fetchImpl = fetch }) {
  const get = async route => {
    const r = await fetchImpl(baseUrl + route, { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`状态接口 HTTP ${r.status}`);
    return r.json();
  };
  const status = await get('/api/status');
  // A failed health check must not fetch or create conversation state.
  const ready = status.mode === 'reserved2' && !status.socialV2Paused && status.dshReady === true
    && status.snowluma?.connected === true && status.snowluma?.accountOnline !== false && status.snowluma?.good !== false;
  if (!ready) return { accepted: false, decision: { ok: false, reason: '服务或 QQ 连接未就绪' } };
  const state = await get('/api/socialV2/state?key=' + encodeURIComponent(key));
  const decision = proactiveDecision({ status, state, now, random, due, work, practice, counter });
  if (!decision.ok) return { accepted: false, decision };
  const response = await fetchImpl(baseUrl + '/api/socialV2/wake', { method: 'POST', headers,
    body: JSON.stringify({ key, reason: decision.reason }), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok || data.ok !== true || data.accepted !== true) return { accepted: false, decision, httpStatus: response.status };
  return { accepted: true, decision, counter: { ...counter, count: (Number(counter.count) || 0) + 1,
    meaning: 'accepted_wake_requests_not_delivered_messages', lastAcceptedAt: now,
    ...(decision.practiceId ? {lastPracticeId:decision.practiceId,lastPracticeWakeAt:now}:{}),
    ...(decision.projectTaskId ? { lastProjectId: decision.projectTaskId, lastProjectWakeAt: now } : {}),
    ...(decision.commitmentId ? { lastCommitmentId: decision.commitmentId, lastCommitmentWakeAt: now } : {}) } };
}
