#!/usr/bin/env node
// 一次看她"生活系统"是否真的在转：日记 / 梦 / 幻想 / 自省 / 回忆录 / 说说。
// 只读，不改任何东西。早上跑一条命令就知道昨晚有没有断。

import fs from 'node:fs';
import path from 'node:path';

const HOME = path.join(process.env.LOCALAPPDATA || '', 'xiaoyu');
const STATE = path.join(HOME, 'state');

const day = (offset = 0) => {
  const at = Date.now() - offset * 86400000;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
};

const readJsonl = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

const atOf = (row) => Number(row?.at ?? row?.t ?? row?.time ? Date.parse(row?.at ?? row?.t ?? row?.time) : 0) || 0;

function latestOf(file) {
  const rows = readJsonl(file);
  if (!rows.length) return { count: 0, at: 0 };
  const at = Math.max(...rows.map((r) => Number(r.at ?? r.t) || 0).filter((n) => n > 0), 0);
  return { count: rows.length, at };
}

const rows = [];

// 日记：看今天和昨天的文件
for (const offset of [0, 1]) {
  const d = day(offset);
  const file = path.join(STATE, 'diary', d + '.md');
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    rows.push({ 项: '日记 ' + d, 状态: size > 900 ? '✅' : '⚠️ 偏短', 详情: (size / 1024).toFixed(1) + ' KB' });
  } else {
    rows.push({ 项: '日记 ' + d, 状态: '❌ 没有', 详情: '—' });
  }
}

// 梦 / 幻想 / 自省
for (const [label, file] of [
  ['梦', 'dreams.jsonl'],
  ['幻想', 'fantasies.jsonl'],
  ['自省', 'introspection.jsonl'],
]) {
  const full = path.join(STATE, file);
  const { count, at } = latestOf(full);
  if (!count) { rows.push({ 项: label, 状态: '❌ 一条都没有', 详情: '—' }); continue; }
  const hours = at ? Math.round((Date.now() - at) / 3600000) : -1;
  const ok = hours >= 0 && hours <= 30;
  rows.push({
    项: label,
    状态: ok ? '✅' : '⚠️ 超过一天没更新',
    详情: count + ' 条 · ' + (hours >= 0 ? hours + ' 小时前' : '时间未知'),
  });
}

// 回忆录
try {
  const chapters = fs.readdirSync(path.join(STATE, 'memoir')).filter((n) => n.endsWith('.md'));
  const newest = chapters
    .map((n) => ({ n, at: fs.statSync(path.join(STATE, 'memoir', n)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0];
  const hours = newest ? Math.round((Date.now() - newest.at) / 3600000) : -1;
  rows.push({
    项: '回忆录',
    状态: hours <= 36 ? '✅' : '⚠️ 超过一天半没写',
    详情: chapters.length + ' 章 · ' + (hours >= 0 ? hours + ' 小时前' : '—'),
  });
} catch { rows.push({ 项: '回忆录', 状态: '❌ 没有目录', 详情: '—' }); }

// 说说
try {
  const qz = JSON.parse(fs.readFileSync(path.join(STATE, 'qzone-limits.json'), 'utf8').replace(/^\uFEFF/, ''));
  const posts = (qz?.posts ?? []).map((id) => Number(id)).filter((n) => n > 0);
  const today = posts.filter((at) => day(0) === new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at)));
  rows.push({ 项: '说说', 状态: today.length ? '✅' : '⚠️ 今天还没发', 详情: '今天 ' + today.length + ' 条 / 共 ' + posts.length + ' 条' });
} catch { rows.push({ 项: '说说', 状态: '❔ 无记录', 详情: '—' }); }

const w = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));
for (const r of rows) {
  console.log(pad(r.项, 16) + pad(r.状态, 18) + r.详情);
}
