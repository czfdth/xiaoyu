// 运行告警：出事的时候**主动告诉人**，而不是等人来翻日志。
//
// 起因很具体：今天（10-27）真实发生过三次故障 —— 余额不足让四个会话全哑、上下文爆表两次、
// invalid JSON 连报 8 次 —— 但桥接只是写日志，人一点都不知道，最后是自己来问"检查一下"才发现。
//
// 设计取舍：
//   · 同一种告警有**冷却时间**（默认 30 分钟），避免一个持续故障把人刷屏；
//   · "连续 N 次"这类用滑动窗口计数（signal + shouldFire），不是永久累计；
//   · 状态落盘 state/alerts.json，重启后冷却仍然有效（否则重启风暴会刷屏）。

import fs from 'node:fs';
import path from 'node:path';

export const ALERT_DEFAULTS = Object.freeze({
  agentErrors: { threshold: 3, windowMs: 10 * 60 * 1000, cooldownMs: 30 * 60 * 1000 },
  balance: { threshold: 1, windowMs: 60 * 1000, cooldownMs: 30 * 60 * 1000 },
  gatewayDown: { threshold: 1, windowMs: 60 * 1000, cooldownMs: 30 * 60 * 1000 },
  contextOverflow: { threshold: 1, windowMs: 60 * 1000, cooldownMs: 60 * 60 * 1000 },
  restartStorm: { threshold: 3, windowMs: 60 * 60 * 1000, cooldownMs: 2 * 60 * 60 * 1000 },
  backupStale: { threshold: 1, windowMs: 60 * 1000, cooldownMs: 24 * 60 * 60 * 1000 },
});

/** 日志里的错误文本 → 告警种类（认不出来返回 ''）。 */
export function classifyError(message) {
  const text = String(message ?? '');
  if (/Insufficient Balance|余额不足|insufficient_quota|quota exceeded/i.test(text)) return 'balance';
  if (/maximum context length|context_length_exceeded|too many tokens/i.test(text)) return 'contextOverflow';
  return 'agentErrors';
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return {
      signals: raw?.signals && typeof raw.signals === 'object' ? raw.signals : {},
      fired: raw?.fired && typeof raw.fired === 'object' ? raw.fired : {},
      history: Array.isArray(raw?.history) ? raw.history.slice(-50) : [],
    };
  } catch {
    return { signals: {}, fired: {}, history: [] };
  }
}

function save(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 存不下去也不该影响主流程 */ }
}

/**
 * 告警中心。
 * @param {{file:string, now?:()=>number, rules?:object, onFire?:(alert)=>void}} options
 */
export function createAlertCenter({ file, now = () => Date.now(), rules = {}, onFire } = {}) {
  const cfg = { ...ALERT_DEFAULTS, ...rules };
  const state = load(file);

  const ruleOf = (kind) => cfg[kind] ?? ALERT_DEFAULTS.agentErrors;

  /** 记一次信号（滑动窗口），返回窗口内计数。 */
  function signal(kind, message = '', at = now()) {
    if (!kind) return 0;
    const list = Array.isArray(state.signals[kind]) ? state.signals[kind] : [];
    const windowMs = ruleOf(kind).windowMs;
    const kept = list.filter((t) => at - Number(t) < windowMs);
    kept.push(at);
    state.signals[kind] = kept.slice(-50);
    if (message) {
      state.lastMessage = state.lastMessage && typeof state.lastMessage === 'object' ? state.lastMessage : {};
      state.lastMessage[kind] = String(message).slice(0, 200);
    }
    save(file, state);
    return kept.length;
  }

  /** 计数够阈值、且不在冷却期 → 触发。 */
  function shouldFire(kind, at = now()) {
    const rule = ruleOf(kind);
    const list = Array.isArray(state.signals[kind]) ? state.signals[kind] : [];
    const inWindow = list.filter((t) => at - Number(t) < rule.windowMs).length;
    if (inWindow < rule.threshold) return null;
    const last = Number(state.fired[kind] ?? 0);
    if (last && at - last < rule.cooldownMs) return null;
    return { kind, count: inWindow, threshold: rule.threshold, at };
  }

  /** 记录一次触发（写冷却 + 历史）。 */
  function markFired(alert) {
    if (!alert?.kind) return;
    state.fired[alert.kind] = alert.at ?? now();
    state.history.push({ ...alert, at: alert.at ?? now() });
    state.history = state.history.slice(-50);
    save(file, state);
  }

  /**
   * 一步到位：记信号 → 判断 → 触发回调。
   * @returns {{fired:boolean, alert?:object, count:number}}
   */
  function report(kind, message = '', at = now(), { force = false } = {}) {
    const count = signal(kind, message, at);
    // force 只给控制台「测试告警」用：跳过阈值与冷却，验证这条链路真能送到 QQ
    const alert = force ? { kind, count, threshold: ruleOf(kind).threshold, at } : shouldFire(kind, at);
    if (!alert) return { fired: false, count };
    markFired(alert);
    try { onFire?.({ ...alert, message: String(message ?? '').slice(0, 300) }); } catch { /* 回调失败不影响记账 */ }
    return { fired: true, alert, count };
  }

  /** 冷却期内的告警（给面板显示）。 */
  function active(at = now()) {
    const out = [];
    for (const [kind, firedAt] of Object.entries(state.fired)) {
      const rule = ruleOf(kind);
      if (at - Number(firedAt) < rule.cooldownMs) {
        out.push({
          kind,
          at: Number(firedAt),
          message: state.lastMessage?.[kind] ?? '',
          level: kind === 'balance' || kind === 'contextOverflow' ? 'error' : 'warn',
        });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  return { signal, shouldFire, markFired, report, active, ruleOf, state: () => state };
}

/**
 * 备份是否太久没做（用最新 zip 的 mtime）。
 * @returns {{ageMs:number, latest:string}} ageMs = Infinity 表示一个都没有
 */
export function backupAge(dir, { now = Date.now() } = {}) {
  let latest = '';
  let newest = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^xiaoyu-.*\.zip$/i.test(name)) continue;
      const st = fs.statSync(path.join(dir, name));
      if (st.mtimeMs > newest) { newest = st.mtimeMs; latest = name; }
    }
  } catch { /* 没目录就是没备份 */ }
  return { ageMs: newest ? now - newest : Infinity, latest };
}
