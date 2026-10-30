// 偶尔说长一点：不是每句都要短。
//
// 她现在的默认节奏是"短句 + 分几条"（人格卡要求的），但一直这样会显得没内容——
// 用户明确提过：希望她有时也能认真说一段。
//
// 做法：按概率（默认 18%）在提示词里加一句"这次可以写长一点"，
// 并且只在私聊生效——群里发长文很劝退。

import { readConfig } from './paths.js';

const DEFAULT_CHANCE = 0.18;

/**
 * 该不该给"这次可以写长"的提示。
 * @param {{key?: string, now?: number, chance?: number}} [opts]
 * @returns {string} 要拼进提示词的一段；不该触发返回空串
 */
export function longFormHint({ key = '', chance } = {}) {
  try {
    if (!key.startsWith('private:')) return '';   // 群里不发长文

    const cfg = readConfig();
    const sent = cfg?.socialV2?.send ?? {};
    const p = Number.isFinite(Number(chance)) ? Number(chance)
      : (Number.isFinite(Number(sent.longFormChance)) ? Number(sent.longFormChance) : DEFAULT_CHANCE);
    if (p <= 0) return '';
    if (Math.random() > p) return '';

    return '【这次可以写长一点】'
      + '如果这个话题你有话说，就认真写一段（一百到三百字），把它说透，不用拆成短句。\n'
      + '如果确实没什么可说的，就按平时的节奏来，别硬凑。\n\n';
  } catch {
    return '';
  }
}
