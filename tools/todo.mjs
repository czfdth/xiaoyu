// 待办清单：她还没有"未定时间的任务"这个概念。
//
// qq_remind 是"到点提醒"，管的是时间；这里管的是"要记得做，但不用定几点"。
// 数据存在 state/todo.json，纯本地，不联网。
//
// 复制这个文件改一改就是你的自定义工具模板。

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { STATE_DIR } from '../src/paths.js';

export const name = 'qq_todo';

export const description =
  '待办清单：加一条（add）、看还没做的（list）、标记做完（done）。'
  + '和 qq_remind 不同，这里不等时间，只记"要记得做"。';

export const schema = {
  action: z.enum(['add', 'list', 'done']).describe('要做什么'),
  text: z.string().optional().describe('add 时的内容'),
  id: z.string().optional().describe('done 时那条的 id（list 里能看到）'),
};

const FILE = path.join(STATE_DIR, 'todo.json');

function read() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
    const store = JSON.parse(raw);
    return Array.isArray(store?.items) ? store.items : [];
  } catch {
    return [];
  }
}

function write(items) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ items }, null, 2) + '\n', 'utf8');
}

export async function run({ action, text = '', id = '' }) {
  const items = read();

  if (action === 'add') {
    const body = String(text).trim().slice(0, 200);
    if (!body) return { error: '要加什么？说一句就行' };
    const now = Date.now();
    const item = { id: 't' + now.toString(36), text: body, at: now, doneAt: 0 };
    items.push(item);
    write(items);
    const open = items.filter((i) => !i.doneAt).length;
    return `记下了：${body}（现在共 ${open} 件没做）`;
  }

  if (action === 'list') {
    const open = items.filter((i) => !i.doneAt);
    if (!open.length) return '清单是空的，没有欠着的事。';
    return open.map((i) => `- [${i.id}] ${i.text}`).join('\n') + `\n共 ${open.length} 件`;
  }

  if (action === 'done') {
    const target = String(id).trim();
    const hit = items.find((i) => i.id === target || i.text.includes(target));
    if (!hit) return { error: '没找到这条待办（先 list 看看编号）' };
    if (hit.doneAt) return `「${hit.text}」早就划掉了`;
    hit.doneAt = Date.now();
    write(items);
    const open = items.filter((i) => !i.doneAt).length;
    return `划掉了：${hit.text}（还剩 ${open} 件）`;
  }

  return { error: 'action 只能是 add / list / done' };
}
