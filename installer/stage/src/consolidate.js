// 记忆沉淀：把流水一样的 journal 变成一章回忆录，原文归档成 .gz。
//
// 现在 journal 已经 3117 条，几个月后会到几万条——检索越来越慢、越来越糊，
// 而且她自己也不会回头去看"流水"。人不是这么记事的：日子会先变成"那段时间"。
//
// 这里**不用模型**：挑她自己说过的原话（最长的几条 + 带情绪的几条）拼成一段，
// 原文压缩归档。模型写当然更漂亮，但会让"她的回忆"变成别人替她写的，所以先做确定性的版本。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MOOD_WORDS = ['怕', '累', '困', '开心', '高兴', '难过', '喜欢', '想', '舍不得', '抱歉', '生气', '踏实', '安心'];

/** 从她的消息里挑几条"值得留"的原话：最长的 + 带情绪的，去重。 */
export function pickQuotes(rows = [], { limit = 6, minLength = 12 } = {}) {
  const mine = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.role === 'her' && typeof r.text === 'string')
    .map((r) => ({ text: r.text.trim(), at: Number(r.t) || 0 }))
    .filter((r) => r.text.length >= minLength);
  if (!mine.length) return [];
  const picked = [];
  const seen = new Set();
  const push = (item) => {
    const key = item.text.slice(0, 24);
    if (seen.has(key)) return;
    seen.add(key);
    picked.push(item);
  };
  // 1) 带情绪的优先（人的记忆靠情绪挂住）
  for (const item of mine) {
    if (picked.length >= Math.ceil(limit / 2)) break;
    if (MOOD_WORDS.some((w) => item.text.includes(w))) push(item);
  }
  // 2) 再补最长的几条（通常是她认真说的）
  for (const item of [...mine].sort((a, b) => b.text.length - a.text.length)) {
    if (picked.length >= limit) break;
    push(item);
  }
  return picked.slice(0, limit).sort((a, b) => a.at - b.at);
}

/** 生成一章回忆录（Markdown，和 state/memoir 里已有的格式一致）。 */
export function composeChapter({ month, stats = {}, quotes = [], totalDays = 0, herMessages = 0, otherMessages = 0, topPeers = [] } = {}) {
  const title = `${month} 那阵子`;
  const lines = [`# 关于${title}`, '', `*${month}*`, ''];
  const peers = Array.isArray(topPeers) && topPeers.length
    ? `大多是和${topPeers.map((p) => `${p.who}`).join('、')}说话`
    : '说话的人不多';
  lines.push(`这一个月我大概说了 ${herMessages} 条，别人跟我说了 ${otherMessages} 条，${peers}。`);
  if (stats.busiestDay?.day) lines.push(`话最多的那天是 ${stats.busiestDay.day}，说了 ${stats.busiestDay.count} 条。`);
  if (totalDays > 0) lines.push(`这些零碎摊在 ${totalDays} 天里。`);
  if (quotes.length) {
    lines.push('', '我翻回去看，自己说过这样几句：');
    for (const q of quotes) {
      const text = q.text.replace(/\s+/g, ' ').slice(0, 120);
      lines.push(`> ${text}`);
    }
    lines.push('');
    lines.push('现在读起来有点像别人说的话。可那确实是我，只是那天的心情已经不在了。');
  } else {
    lines.push('', '这一月我没留下什么话。');
  }
  return `${lines.join('\n')}\n`;
}

/** 该月里的日子数（按文件名）。 */
export function countDays(files = [], month) {
  return files.filter((f) => path.basename(f).startsWith(month)).length;
}

/** 归档一个月的原文：gzip 后删原件。返回 {file, bytes}。 */
export function archiveMonth(monthFiles = [], { archiveDir, dryRun = false } = {}) {
  const out = [];
  if (!monthFiles.length) return out;
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const file of monthFiles) {
    const name = path.basename(file);
    const target = path.join(archiveDir, `${name}.gz`);
    let raw = '';
    try { raw = fs.readFileSync(file); } catch { continue; }
    if (!dryRun) {
      fs.writeFileSync(target, zlib.gzipSync(raw, { level: 9 }));
      fs.rmSync(file, { force: true });
    }
    out.push({ file: name, target, bytes: raw.length });
  }
  return out;
}
