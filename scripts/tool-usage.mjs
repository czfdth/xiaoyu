// 统计工具使用情况：哪些从没被调用过。
import fs from 'node:fs';
import path from 'node:path';

const home = path.join(process.env.LOCALAPPDATA, 'xiaoyu');
const callsFile = path.join(home, 'state', 'tool-calls.jsonl');
const mcpFile = 'src/mcp-snowluma-safe.js';

// 注册的工具名：从代码里抓 'qq_xxx'
const src = fs.readFileSync(mcpFile, 'utf8');
const registered = new Set();
for (const m of src.matchAll(/'qq_[a-z0-9_]+'/g)) registered.add(m[0].replace(/'/g, ''));

const used = new Map();
let total = 0;
try {
  for (const line of fs.readFileSync(callsFile, 'utf8').split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== 'call') continue;
    const name = String(row.tool ?? '').replace(/^mcp__[^_]+__/, '');
    if (!name) continue;
    used.set(name, (used.get(name) ?? 0) + 1);
    total += 1;
  }
} catch { console.log('没有 tool-calls.jsonl'); }

const unused = [...registered].filter((n) => !used.has(n)).sort();
const top = [...used.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

console.log(`注册工具 ${registered.size} 个 · 调用过 ${used.size} 个 · 总调用 ${total} 次`);
console.log(`\n从没用过：${unused.length} 个`);
const chunks = [];
for (let i = 0; i < unused.length; i += 4) chunks.push(unused.slice(i, i + 4).join('  '));
console.log(chunks.map((c) => '  ' + c).join('\n'));

console.log('\n用得最多：');
for (const [name, n] of top) console.log(`  ${name}  ${n} 次`);
