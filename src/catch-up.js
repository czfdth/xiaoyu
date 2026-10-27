// 断线补偿：网关断开期间的消息，OneBot 不会重放，丢了就没了。
// 重连后主动拉一次历史，把 lastIncomingAt 之后的消息补进未读。
//
// 这个模块只做两件事：从历史里挑出"新的"，以及按会话把补回来的记进去。
// 所有外部依赖（请求、状态、写日志）都由调用方注入——这样能单测，也不会重演上次那个
// "函数定义在别的作用域、回调里引用不到、连上 8 秒就崩"的事故。

/** 从一条历史消息里取纯文本；取不到返回空串。 */
export function textOf(row) {
  if (!row) return '';
  if (Array.isArray(row.message)) {
    return row.message
      .filter((seg) => seg?.type === 'text')
      .map((seg) => String(seg?.data?.text ?? ''))
      .join('')
      .trim();
  }
  return String(row?.raw_message ?? row?.message ?? '').trim();
}

/**
 * 挑出比 since 新的消息（按时间正序）。
 * @param {Array} rows OneBot 历史返回
 * @param {number} since 毫秒时间戳（上一条已处理消息的时间）
 */
export function collectMissed(rows, since) {
  const cutoff = Number(since) || 0;
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = Number(row?.time) * 1000;
    if (!Number.isFinite(at) || at <= cutoff) continue;
    const text = textOf(row);
    if (!text) continue;
    const senderId = row?.sender?.user_id ?? row?.user_id ?? null;
    out.push({
      at,
      text,
      senderId,
      senderName: row?.sender?.card || row?.sender?.nickname || String(senderId ?? ''),
      messageId: row?.message_id ?? row?.msg_id ?? null,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 对一个会话做补偿。
 * @param {{key:string, kind:'group'|'private', id:string, since:number,
 *          request:(action:string, params:object)=>Promise<any>, ingest:(msg:object)=>void}} options
 * @returns {Promise<{added:number, error?:string}>}
 */
export async function catchUpConversation({ key, kind, id, since, request, ingest } = {}) {
  const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
  const params = kind === 'group'
    ? { group_id: Number(id), count: 30 }
    : { user_id: Number(id), count: 30 };
  let rows;
  try {
    const resp = await request(action, params);
    rows = resp?.data?.messages ?? resp?.messages ?? [];
  } catch (error) {
    return { added: 0, error: String(error?.message ?? error).slice(0, 120) };
  }
  const missed = collectMissed(rows, since);
  let added = 0;
  for (const msg of missed) {
    try { ingest(msg); added += 1; } catch { /* 单条失败不影响其它 */ }
  }
  return { added };
}
