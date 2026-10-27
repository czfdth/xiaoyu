import fs from 'node:fs';
import path from 'node:path';
import { looksLikeImageBuffer } from './safe-fetch.js';
import { chooseDrawingBehavior, recordDrawingExperience } from './experience-learning.js';

export function drawError(error) {
  const code = error?.cause?.code || error?.code || '';
  let detail = `${code ? code + ': ' : ''}${error?.message || String(error)}`;
  detail = detail.replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '***')
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1***');
  const category = /ECONNREFUSED|ENOTFOUND|fetch failed|network|connect/i.test(detail) ? 'unavailable'
    : /timeout|timed? out|abort/i.test(detail) ? 'timeout'
    : /401|403|api.?key|not configured|没配/i.test(detail) ? 'configuration'
    : /image|图片/i.test(detail) ? 'invalid_image' : 'provider_error';
  return { category, detail: detail.slice(0, 350) };
}

export function chooseLocalTemplate(prompt) {
  const text = String(prompt);
  if (/书桌|画册|握.*笔|写字|desk|notebook|drawing book/i.test(text)) return 'desk';
  if (/鲸|whale/i.test(text)) return 'whale';
  if (/猫|cat/i.test(text)) return 'cat';
  if (/月|moon/i.test(text)) return 'moon';
  if (/房|house/i.test(text)) return 'house';
  if (/心|heart/i.test(text)) return 'heart';
  return 'two_fish';
}

export async function runDrawingPlan({ provider, primary, local, allowFallback = true, logFile, now = Date.now,
  learningFile, scope, localSuitable = false }) {
  const attempts = [];
  let behavior = null, learningWarning;
  if (learningFile && scope) {
    try { behavior = chooseDrawingBehavior(learningFile, { scope, provider, allowFallback, localSuitable, now: now() }); }
    catch { learningWarning = '经验状态不可用，按原计划执行；未覆盖经验文件'; }
  }
  const reflect = () => {
    if (!learningFile || !scope) return;
    try { recordDrawingExperience(learningFile, { scope, provider, attempts, at: now(), applicationId: behavior?.id }); }
    catch { learningWarning = '执行结果已保留，但经验写入失败；不能声称已学会'; }
  };
  const log = entry => {
    if (!logFile) return;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify({ at: now(), ...entry }) + '\n', { encoding: 'utf8', mode: 0o600 });
  };
  const primaryStrategy = { name: provider, run: primary }, localStrategy = { name: 'local_illustration', run: local };
  const strategies = behavior ? [localStrategy, primaryStrategy]
    : [primaryStrategy, ...(allowFallback && provider !== 'local_illustration' ? [localStrategy] : [])];
  for (const strategy of strategies) {
    try {
      const output = await strategy.run();
      if (!Buffer.isBuffer(output?.buf) || !looksLikeImageBuffer(output.buf)) throw new Error('绘图返回的不是有效图片');
      attempts.push({ provider: strategy.name, outcome: 'succeeded' });
      reflect();
      const result = { ...output, provider: strategy.name, requestedProvider: provider,
        degraded: strategy.name !== provider, attempts,
        ...(behavior ? { learning: { applicationId: behavior.id, reflectionId: behavior.reflectionId,
          changedPlan: true, baseline: behavior.baseline, chosen: behavior.chosen, reason: behavior.reason, probeAt: behavior.probeAt } } : {}),
        ...(learningWarning ? { learningWarning } : {}) };
      // Logging must not turn a completed image into a failed generation or trigger duplicates.
      try { log({ ...result, buf: undefined }); } catch { result.auditWarning = '图片已生成，但尝试记录未能保存，请勿因此重复生成'; }
      return result;
    } catch (error) {
      attempts.push({ provider: strategy.name, outcome: 'failed', ...drawError(error) });
      try { log({ requestedProvider: provider, attempt: attempts.at(-1) }); } catch { /* keep original error */ }
    }
  }
  reflect();
  const failure = new Error('所有绘图方式均失败：' + attempts.map(a => `${a.provider}: ${a.detail}`).join('；'));
  failure.attempts = attempts;
  throw failure;
}
