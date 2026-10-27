// 待补的消息：回合失败时，她"没答上"这件事要有地方记账。
//
// 线上真实发生过：14:28 你连问五遍"你现在的状态怎么样"，五轮都因为
// `tool input is invalid JSON` 死掉，消息进了未读但没有任何后续 —— 她不是不想答，是没答成，
// 而且下一轮她也不知道"上一条还没答"。这个模块就是那份账。
//
// 存法：state/pending-answers.json = { "<key>": [ {at, reason, texts:[...], seq} ] }，
// 每个会话最多留 5 条（再多说明问题不在补答，而在修错误本身）。

export const PENDING_MAX_PER_KEY = 5;

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    out[key] = list.filter((x) => x && typeof x === 'object').slice(-PENDING_MAX_PER_KEY);
  }
  return out;
}

/** 同上：把一条"没答上"记进去（同一条消息不重复记）。 */
export function addPending(state, key, { at = Date.now(), reason = '', texts = [], seq } = {}) {
  const store = normalize(state);
  const list = Array.isArray(store[key]) ? store[key] : [];
  const signature = `${at}|${reason}`;
  if (list.some((x) => `${x.at}|${x.reason}` === signature)) return store;
  list.push({
    at,
    reason: String(reason ?? '').slice(0, 160),
    texts: (Array.isArray(texts) ? texts : []).slice(0, 3).map((t) => String(t ?? '').slice(0, 120)),
    seq: Number.isFinite(Number(seq)) ? Number(seq) : null,
  });
  store[key] = list.slice(-PENDING_MAX_PER_KEY);
  return store;
}

/** 取走某个会话的待补（取走即清空：补一次就够，不要每轮都提）。 */
export function takePending(state, key) {
  const store = normalize(state);
  const list = Array.isArray(store[key]) ? store[key] : [];
  if (!list.length) return { list: [], state: store };
  delete store[key];
  return { list, state: store };
}

/** 只读：有没有待补。 */
export function peekPending(state, key) {
  const store = normalize(state);
  return Array.isArray(store[key]) ? store[key] : [];
}

/** 生成提示里那一小段（有就返回字符串，没有返回 ''）。 */
export function pendingHint(list, now = Date.now()) {
  const items = Array.isArray(list) ? list.filter((x) => x && Number.isFinite(Number(x.at))) : [];
  if (!items.length) return '';
  const lines = items.map((item) => {
    const mins = Math.max(1, Math.round((now - Number(item.at)) / 60000));
    const why = item.reason ? `（当时失败：${item.reason}）` : '';
    const what = item.texts?.length ? `：${item.texts.join(' / ')}` : '';
    return `- ${mins} 分钟前那轮没答上${why}${what}`;
  });
  return `【补答】下面这些是你上一轮没答成的，不是新消息，别当成刚发生的；能答就自然接一句，答不了就别硬编：\n${lines.join('\n')}\n\n`;
}
