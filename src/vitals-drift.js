// 身体漂移：不靠她主动写，也会随时间变化。
//
// 问题很具体：她的身体/内心只在她调 qq_body / qq_mood 时才更新。线上实测出现过
// 下午三点还在说「刚醒，脑子有点懵」——因为身体记录是早上 7:37 写的，"她"和"面板"都以为还那样。
//
// 做法：保留她写的值（base），按经过的时间推算"现在大概是什么感觉"（drift）。
// **不覆盖 body.json** —— 那是她自己的表述，覆盖了就变成我们替她感觉；
// 只把推算值写进 vitals 时间序列，并在面板上并列显示。
//
// 参数是粗调的经验值，不是生理模型：够用来让「困/饿/累」有方向感就行。

export const DRIFT_DEFAULTS = Object.freeze({
  graceMs: 30 * 60 * 1000,   // 她刚写过就完全信她，别立刻改
  perHour: { sleepy: 0.035, tired: 0.03, hungry: 0.05, cold: 0.02 },
  max: 0.95,
  min: 0.05,
  nightSleepyBoost: 0.25,    // 23:00~06:00 额外加一点困
  nightColdBoost: 0.15,      // 深夜更冷
  dayHungryBoost: 0.1,       // 12:00~13:30 / 18:00~19:30 饭点更饿
});

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function shanghaiHour(at) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false,
  }).formatToParts(new Date(at));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return Number.isFinite(hour) ? hour : 0;
}

/**
 * 按经过的时间推算现在的身体值。
 *
 * @param {{sleepy?:number, tired?:number, hungry?:number, cold?:number}} base 她最后一次写的值
 * @param {{sinceMs:number, now?:number, drift?:object}} options sinceMs = 距今多久没更新
 * @returns {{sleepy:number, tired:number, hungry:number, cold:number, drifts:number}}
 */
export function driftBody(base = {}, { sinceMs = 0, now = Date.now(), drift = {} } = {}) {
  const cfg = { ...DRIFT_DEFAULTS, ...drift };
  const elapsed = Math.max(0, Number(sinceMs) || 0);
  const hours = Math.max(0, (elapsed - cfg.graceMs) / 3600000);
  const hour = shanghaiHour(now);

  const night = hour >= 23 || hour < 6;
  const meal = (hour >= 12 && hour < 14) || (hour >= 18 && hour < 20);

  // 她写的值当基准；没写过的字段按 0.3 起（"还行"），别让推算从 0 开始显得诡异
  const pick = (key) => {
    const v = Number(base?.[key]);
    return Number.isFinite(v) ? clamp(v, 0, 1) : 0.3;
  };
  const add = (key, delta) => clamp(pick(key) + delta, cfg.min, cfg.max);

  const sleepy = add('sleepy', hours * cfg.perHour.sleepy + (night ? cfg.nightSleepyBoost : 0));
  const tired = add('tired', hours * cfg.perHour.tired);
  const hungry = add('hungry', hours * cfg.perHour.hungry + (meal ? cfg.dayHungryBoost : 0));
  const cold = add('cold', hours * cfg.perHour.cold + (night ? cfg.nightColdBoost : 0));

  return {
    sleepy: Math.round(sleepy * 100) / 100,
    tired: Math.round(tired * 100) / 100,
    hungry: Math.round(hungry * 100) / 100,
    cold: Math.round(cold * 100) / 100,
    drifts: hours > 0 ? Math.round(hours * 10) / 10 : 0,
  };
}

/** 她写过的值 vs 推算值差多少（面板上标"推算"用）。 */
export function driftDelta(base = {}, drifted = {}) {
  const out = {};
  for (const key of ['sleepy', 'tired', 'hungry', 'cold']) {
    const a = Number(base?.[key]);
    const b = Number(drifted?.[key]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = Math.round((b - a) * 100) / 100;
    if (Math.abs(d) >= 0.03) out[key] = d;
  }
  return out;
}
