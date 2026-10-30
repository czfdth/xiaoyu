// 有时候用声音：文字 vs 语音的选择权交给她，但给一点提示。
//
// 现在她只在被要求时才发语音（qq_say）。用户希望她"偶尔主动用声音"——
// 不是随机发，而是在语气比字更重要的时刻想起来。
//
// 做法：私聊按概率（默认 12%）在提示词里提一句"这轮可以用语音说"。
// 群里不提示（语音在群里太抢戏），且明确要求"一句就够"，避免长篇语音轰炸。

import { readConfig } from './paths.js';

const DEFAULT_CHANCE = 0.12;

/**
 * @param {{key?: string, chance?: number, now?: number}} [opts]
 * @returns {string} 提示词片段；不触发返回空串
 */
export function voiceHint({ key = '', chance } = {}) {
  try {
    if (!key.startsWith('private:')) return '';

    const cfg = readConfig();
    const sent = cfg?.socialV2?.send ?? {};
    const p = Number.isFinite(Number(chance)) ? Number(chance)
      : (Number.isFinite(Number(sent.voiceChance)) ? Number(sent.voiceChance) : DEFAULT_CHANCE);
    if (p <= 0) return '';
    if (Math.random() > p) return '';

    return '【这轮可以用语音】'
      + '如果这句话语气比字更要紧（比如哄人、撒娇、犯困、道晚安），就用 qq_say 说一句，'
      + '一句就够，别念长段。\n'
      + '如果只是普通回话，照常用文字。\n\n';
  } catch {
    return '';
  }
}
