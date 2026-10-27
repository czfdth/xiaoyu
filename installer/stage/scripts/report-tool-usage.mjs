// 统计她实际用了哪些工具，写报告
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';
const mcp = fs.readFileSync(ROOT + '/src/mcp-snowluma-safe.js', 'utf8');
const defs = [...new Set([...mcp.matchAll(/^\s*'(qq_[a-z_0-9]+)'/gm)].map((m) => m[1]))];
const counts = Object.fromEntries(defs.map((d) => [d, 0]));
const files = [];
(function walk(p) {
  for (const f of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = p + '/' + f.name;
    if (f.isDirectory()) walk(fp);
    else if (/\.(log|jsonl|md)$/.test(f.name)) files.push(fp);
  }
})(ROOT + '/state');
for (const f of files) {
  let txt = '';
  try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const d of defs) {
    const n = txt.split(d).length - 1;
    if (n) counts[d] += n;
  }
}
const used = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
const idle = Object.entries(counts).filter(([, n]) => n === 0).map(([k]) => k);
const lines = [
  '# 技能使用报告 ' + new Date().toLocaleString('zh-CN'),
  '',
  '工具总数: ' + defs.length + '　用过: ' + used.length + '　没用过: ' + idle.length,
  '',
  '## 用过',
  ...used.map(([k, n]) => k + ' × ' + n),
  '',
  '## 从没用过',
  idle.join(', ')
];
fs.writeFileSync(ROOT + '/state/tool-usage.md', lines.join('\n'), 'utf8');
console.log('used', used.length, '/', defs.length);