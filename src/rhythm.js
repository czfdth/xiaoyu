// 节律：让她的活跃度跟着一天的时间走，而不是 24 小时一个样。
//
// 之前只有一个粗糙的"深夜 ×0.3"。真人的一天是有低谷和高峰的：
// 凌晨几乎不在线、清晨刚醒有点迷糊、午后有点低、晚上最活跃。
//
// 这里只做两件事：
//   rhythmFactor()  给主动搭话概率乘一个系数
//   rhythmNote()    早上第一轮带一句"刚醒"的提示（不伪造，只是状态描述）

const HOUR = 3600000;

/** 上海时间的小时（带小数，比如 7.5 表示 7:30）。 */
function shanghaiHour(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(now));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) + m / 60;
}

/**
 * 活跃度系数（乘在主动概率上）。
 * @param {number} [now]
 * @returns {number} 0.03 ~ 1.05
 */
export function rhythmFactor(now = Date.now()) {
  const h = shanghaiHour(now);
  if (h >= 0.5 && h < 6.5) return 0.03;   // 凌晨：几乎不可能主动
  if (h >= 6.5 && h < 8.5) return 0.45;   // 清晨：刚醒，慢半拍
  if (h >= 8.5 && h < 11) return 0.9;     // 上午
  if (h >= 11 && h < 13.5) return 0.75;   // 午间：吃饭/犯困
  if (h >= 13.5 && h < 17) return 0.7;    // 下午低谷
  if (h >= 17 && h < 19.5) return 0.95;   // 傍晚
  if (h >= 19.5 && h < 23) return 1.05;   // 晚上：最活跃
  return 0.25;                            // 23:00~00:30 收尾
}

/**
 * 早上第一轮的一句状态提示；不在清晨返回空串。
 * 刻意只描述"刚醒"这个客观状态，不替她编情绪。
 */
export function rhythmNote(now = Date.now()) {
  const h = shanghaiHour(now);
  if (h < 6.5 || h >= 9) return '';
  return '【时间】你刚醒不久（早上 ' + Math.floor(h) + ' 点多）。说话可以慢一点、短一点，别一上来就长篇大论。\n\n';
}
