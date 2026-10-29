// 日常调度：什么时候该做哪件事（纯函数，好测）。
//
// 从 bridge.js 里抽出来的第一块。原来这些判断散在一个 14,000 行的文件里，
// 改一处全凭"找锚点"，插错位置就会静默失效（今晚已经栽过两次）。
// 抽成纯函数之后：输入时间，输出该不该跑，单元测试直接覆盖。

/** 上海时间的小时（0~23）。 */
export function shanghaiHour(now = Date.now()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false,
  }).format(new Date(now)));
}

/** 上海时间的日期键（YYYY-MM-DD）。 */
export function dayKey(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
}

/**
 * 该不该发今天的日报。
 * 规则：8~23 点之间、今天还没发过、有收件人。
 * @param {{now?: number, lastSentDay?: string, ownerQQ?: string|number}} opts
 */
export function shouldSendDailyReport({ now = Date.now(), lastSentDay = '', ownerQQ = '' } = {}) {
  const hour = shanghaiHour(now);
  const day = dayKey(now);
  if (!ownerQQ) return { due: false, day, hour, reason: 'no-owner' };
  if (hour < 8 || hour >= 23) return { due: false, day, hour, reason: 'out-of-window' };
  if (lastSentDay === day) return { due: false, day, hour, reason: 'already-sent' };
  return { due: true, day, hour, reason: 'ok' };
}

/**
 * 该不该跑夜间日常（幻想 / 自省）。
 * 规则：23:00~02:00。
 */
export function inNightWindow(now = Date.now()) {
  const hour = shanghaiHour(now);
  return hour >= 23 || hour < 2;
}

/**
 * 该不该轮转日志。
 * 规则：05:00 之后，且距上次超过 20 小时。
 */
export function shouldRotateLogs({ now = Date.now(), lastAt = 0 } = {}) {
  const hour = shanghaiHour(now);
  if (hour < 5) return false;
  return !lastAt || now - lastAt > 20 * 3600 * 1000;
}
