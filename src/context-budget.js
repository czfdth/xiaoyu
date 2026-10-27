// 上下文预算：DSH 的一条会话历史只增不减，而**每一步**都要把整段历史重新发给模型。
// 实测一支群聊会话从 21k token 长到 79 万 token 后，单回合 132 步 = 上亿 token，
// 钱几乎全花在「重复发送同一段旧历史」上。
//
// 这个模块只管四件事，判定逻辑与 I/O 完全分离（便于单独测试）：
//   1. 单回合步数上限：一个回合跑到 N 步还没收尾，说明大概率在打转，该打断；
//   2. 单步 prompt 超限：历史已经长到不划算，回合结束后换一条新会话（带最近上下文接力）；
//   3. 空闲刷新：缓存已经过期的那次唤醒，直接起新会话比重读整段历史便宜得多；
//   4. 打转检测：同一个工具同样的参数反复调，及时打断，别让它空转到步数上限。
//
// 注意：这里**不**做任何裁剪/摘要，会话内容的取舍由桥接层决定。

export const CONTEXT_BUDGET_DEFAULTS = Object.freeze({
  // 单个回合最多走多少步（0 = 不限制）。正常聊天 1~6 步收尾，20~30 步基本是空转。
  maxStepsPerTurn: 30,
  // 单步 prompt 达到多少 token 就该换新会话（0 = 不轮换）。
  rotatePromptTokens: 45000,
  // 会话至少完整跑过多少个回合才允许轮换：太短的会话轮换只会白付一次冷启动 cacheMiss。
  rotateMinTurns: 5,
  // 空闲多久之后的下一次唤醒直接起新会话（缓存反正已经过期）。0 = 关闭。
  idleRotateAfterMs: 20 * 60 * 1000,
  // 空闲刷新只对「已经不小」的会话有意义：低于这个规模，换不换都一样。
  idleRotateTokens: 35000,
  // 同一个工具用同样的参数连续调几次算打转（0 = 不检测）。
  repeatToolLimit: 2,
});

const INT_KEYS = [
  'maxStepsPerTurn',
  'rotatePromptTokens',
  'rotateMinTurns',
  'idleRotateAfterMs',
  'idleRotateTokens',
  'repeatToolLimit',
];

function intIn(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** 配置归一化：接受 socialV2.context 里的原始值，任何非法值回落到默认。 */
export function normalizeContextBudget(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of INT_KEYS) out[key] = intIn(src[key], CONTEXT_BUDGET_DEFAULTS[key], 0, 10_000_000);
  return out;
}

/**
 * 创建预算判定器。
 *
 * @param {object} [options]
 * @param {object} [options.limits] 覆盖项（通常就是 cfg.socialV2.context）
 * @param {() => number} [options.now]
 */
export function createContextBudget({ limits = {}, now = () => Date.now() } = {}) {
  const cfg = normalizeContextBudget(limits);
  /** sessionId -> { turn, step, steps, turns, promptTokens, interruptedFor, updatedAt } */
  const sessions = new Map();

  function entryOf(sessionId) {
    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = {
        turn: null,
        step: 0,
        steps: 0,        // 本回合见过的最大步数
        turns: 0,        // 已结束的回合数
        promptTokens: 0, // 最近一步的 prompt 大小
        interruptedFor: null, // 已经打断过的回合号，避免同一回合反复打断
        updatedAt: 0,
      };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  /**
   * 摄入一步的用量。turn/step 来自 DSH 的 usage 事件（与 token 账本同源）。
   * @returns {{interrupt:boolean, steps:number, turn:number|null}}
   */
  function observe({ sessionId, turn, step, promptTokens } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) return { interrupt: false, steps: 0, turn: null };
    const entry = entryOf(sessionId);
    const t = Number.isFinite(Number(turn)) ? Number(turn) : null;
    const s = Number.isFinite(Number(step)) ? Number(step) : 0;
    if (t != null && entry.turn !== t) {
      entry.turn = t;
      entry.steps = 0;
    }
    if (s > entry.steps) entry.steps = s;
    if (Number.isFinite(Number(step))) entry.step = s;
    const prompt = Number(promptTokens);
    if (Number.isFinite(prompt) && prompt > 0) entry.promptTokens = prompt;
    entry.updatedAt = now();

    const limit = cfg.maxStepsPerTurn;
    const over = limit > 0 && entry.steps >= limit;
    let interrupt = false;
    if (over && entry.interruptedFor !== entry.turn) {
      entry.interruptedFor = entry.turn;
      interrupt = true;
    }
    return { interrupt, steps: entry.steps, turn: entry.turn };
  }

  /** 回合结束：计数 +1。返回该会话最新统计（调用方据此决定是否轮换）。 */
  function noteTurnEnd(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    entry.turns += 1;
    entry.steps = 0;
    entry.interruptedFor = null;
    entry.updatedAt = now();
    return { turns: entry.turns, promptTokens: entry.promptTokens, turn: entry.turn };
  }

  /** 现在这条会话该不该换新：只看最近一步大小与会话寿命。 */
  function shouldRotate(sessionId) {
    if (cfg.rotatePromptTokens <= 0) return false;
    const entry = sessions.get(sessionId);
    if (!entry) return false;
    if (entry.promptTokens < cfg.rotatePromptTokens) return false;
    return entry.turns >= cfg.rotateMinTurns;
  }

  /** 为什么该轮换（给日志/控制台用）。 */
  function rotateReason(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry || !shouldRotate(sessionId)) return '';
    return `单步 prompt ${entry.promptTokens} token ≥ ${cfg.rotatePromptTokens}，会话已跑 ${entry.turns} 回合`;
  }

  /**
   * 这一次唤醒该不该直接换新会话（空闲刷新）。
   *
   * 依据：缓存过期后，第一步本来就要把整段历史按未命中价重读。空闲越久越确定缓存没了，
   * 所以「空闲够久 + 会话已经不小」时，起一条新会话（带接力）比重读旧历史便宜一个数量级。
   */
  function shouldRefreshIdle(sessionId, at = now()) {
    if (cfg.idleRotateAfterMs <= 0 || cfg.idleRotateTokens <= 0) return false;
    const entry = sessions.get(sessionId);
    if (!entry) return false;
    if (entry.promptTokens < cfg.idleRotateTokens) return false;
    return at - entry.updatedAt >= cfg.idleRotateAfterMs;
  }

  function stats(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    return { ...entry };
  }

  /**
   * 用历史数据回填一条会话的规模。
   *
   * 为什么需要：桥接刚重启时内存里没有任何采样，一条**已经长到 77 万 token** 的老会话
   * 要再走满 `rotateMinTurns` 个回合才够条件，等于刹车在重启后失灵半天。
   * 账本（state/token-usage.jsonl）里有每步的 prompt 大小和回合号，启动时读一次就能填上。
   */
  function seed(sessionId, { promptTokens = 0, turns = 0, turn = null } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const entry = entryOf(sessionId);
    const prompt = Number(promptTokens);
    if (Number.isFinite(prompt) && prompt > entry.promptTokens) entry.promptTokens = prompt;
    const n = Number(turns);
    if (Number.isFinite(n) && n > entry.turns) entry.turns = Math.trunc(n);
    if (Number.isFinite(Number(turn))) entry.turn = Number(turn);
    entry.updatedAt = now();
    return true;
  }

  function forget(sessionId) {
    sessions.delete(sessionId);
  }

  return {
    limits: cfg,
    observe,
    noteTurnEnd,
    shouldRotate,
    rotateReason,
    shouldRefreshIdle,
    stats,
    seed,
    forget,
    size: () => sessions.size,
  };
}

/**
 * 打转检测：同一个工具、同样的参数，在一个回合里反复调用就该停。
 *
 * 为什么不用「同一个工具调几次」：她正常也会连发 3 条消息（qq_send_message × 3，参数不同）、
 * 连续 wait 两次。真正没意义的是**参数一模一样**的重复调用 —— 那只可能是在打转。
 * 调用方负责把可以合法重复的工具（等待、标记已读、设置唤醒）排除在外。
 */
export function createRepeatGuard({ limit = 2 } = {}) {
  const seen = new Map(); // sessionId -> Map<signature, count>

  function note(sessionId, signature) {
    if (limit <= 0 || typeof sessionId !== 'string' || !sessionId || !signature) return false;
    let m = seen.get(sessionId);
    if (!m) {
      m = new Map();
      seen.set(sessionId, m);
    }
    const n = (m.get(signature) || 0) + 1;
    m.set(signature, n);
    return n >= limit;
  }

  /** 回合结束/新回合开始时清掉计数。 */
  function reset(sessionId) {
    seen.delete(sessionId);
  }

  return { note, reset, limit, size: () => seen.size };
}
