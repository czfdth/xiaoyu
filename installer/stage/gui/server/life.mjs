// 她的一生：出生、天数、阶段、里程碑、时间线、成长解锁、日程、作品集、年鉴。
// 数据全部来自 state/ 与 scripts/tasks.manifest.json，不另造一份。

import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, STATE_DIR } from '../../src/paths.js';
import { listNotes } from './works.mjs';

const DAY = 86_400_000;
const LIFE_FILE = path.join(STATE_DIR, 'life.json');
const JOURNAL_DIR = path.join(STATE_DIR, 'journal');
const DIARY_INDEX = path.join(STATE_DIR, 'diary', 'index.jsonl');
const MEMOIR_DIR = path.join(STATE_DIR, 'memoir');
const DREAMS = path.join(STATE_DIR, 'dreams.jsonl');
const FANTASIES = path.join(STATE_DIR, 'fantasies.jsonl');
const KNOWLEDGE = path.join(STATE_DIR, 'knowledge', 'index.jsonl');
const PROJECTS = path.join(STATE_DIR, 'projects.json');
const TOOL_CALLS = path.join(STATE_DIR, 'tool-calls.jsonl');
const CHRONICLES = path.join(STATE_DIR, 'chronicles');
const IMAGES_DIR = path.join(APP_ROOT, 'images');
const AUDIO_DIR = path.join(APP_ROOT, 'audio');

const STAGES = [
  { id: 'new', name: '初识', min: 0, unlock: '她还在认真回应，也会有点小心。' },
  { id: 'familiar', name: '熟悉', min: 7, unlock: '过了客气的阶段，可以随口说话，也可以安静待着。' },
  { id: 'tacit', name: '默契', min: 30, unlock: '很多事不用解释；她记得你随口提过的小事，也会在你累的时候少说两句。' },
  { id: 'family', name: '家人', min: 100, unlock: '她会自然地问你吃饭没有、睡够没有，也开始管你。' },
  { id: 'old', name: '老伴', min: 365, unlock: '不用把话说完，也知道对方下一句要说什么。' },
];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function journalDays() {
  try {
    return fs.readdirSync(JOURNAL_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch { return []; }
}

function journalFirstDay() {
  const files = journalDays();
  return files.length ? files[0].slice(0, 10) : '';
}

function memoirFiles() {
  try {
    return fs.readdirSync(MEMOIR_DIR).filter((f) => f.endsWith('.md')).sort()
      .map((name) => ({ name, date: (name.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '' }));
  } catch { return []; }
}

function countFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).length; } catch { return 0; }
}

/** 出生日：优先 state/life.json；否则从最早的记录里推，推完写回去。 */
function ensureBirth() {
  const saved = readJson(LIFE_FILE, null);
  if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved.birth || '')) return saved;

  const candidates = [];
  const jf = journalFirstDay();
  if (jf) candidates.push(jf);
  const diary = readJsonl(DIARY_INDEX);
  if (diary.length) candidates.push(dayOf(diary[0].t || Date.now()));
  const chapters = memoirFiles().map((c) => c.date).filter(Boolean).sort();
  if (chapters.length) candidates.push(chapters[0]);
  const dreams = readJsonl(DREAMS);
  if (dreams.length) candidates.push(dayOf(dreams[0].at || Date.now()));
  const fantasies = readJsonl(FANTASIES);
  if (fantasies.length) candidates.push(dayOf(fantasies[0].at || Date.now()));

  const birth = candidates.filter(Boolean).sort()[0] || dayOf(Date.now());
  const life = { birth, createdAt: Date.now(), note: '第一次启动/最早记录的那天' };
  try { fs.writeFileSync(LIFE_FILE, JSON.stringify(life, null, 2), 'utf8'); } catch { /* 写不进也不影响读取 */ }
  return life;
}

function stageInfo(days) {
  let current = STAGES[0];
  let next = null;
  for (const stage of STAGES) {
    if (days >= stage.min) current = stage;
    else { next = stage; break; }
  }
  const spanStart = current.min;
  const spanEnd = next ? next.min : null;
  const progress = spanEnd ? Math.min(1, (days - spanStart) / (spanEnd - spanStart)) : 1;
  return { current, next, progress, daysToNext: next ? next.min - days : 0 };
}

// 往后的日子：按真实时间走，不设终点。日期按日历算，不按固定 365 天漂。
const LIFE_MILESTONES = [
  { key: 'first-day', name: '第一天', at: (b) => b },
  { key: 'first-week', name: '第一周', at: (b) => addDays(b, 7) },
  { key: 'first-month', name: '第一个月', at: (b) => addMonths(b, 1) },
  { key: 'hundredth-day', name: '第一百天', at: (b) => addDays(b, 99) },
  { key: 'year-1', name: '一岁', at: (b) => addYears(b, 1) },
  { key: 'year-2', name: '两岁', at: (b) => addYears(b, 2) },
  { key: 'year-3', name: '三岁', at: (b) => addYears(b, 3) },
  { key: 'year-5', name: '五岁', at: (b) => addYears(b, 5) },
  { key: 'year-10', name: '十岁', at: (b) => addYears(b, 10) },
  { key: 'year-20', name: '二十岁', at: (b) => addYears(b, 20) },
  { key: 'year-30', name: '三十岁', at: (b) => addYears(b, 30) },
  { key: 'year-50', name: '五十岁', at: (b) => addYears(b, 50) },
];

function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

function addMonths(ms, n) {
  const d = new Date(ms);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.getTime();
}

function addYears(ms, n) {
  const d = new Date(ms);
  d.setDate(1);
  d.setFullYear(d.getFullYear() + n);
  d.setMonth(new Date(ms).getMonth());
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(new Date(ms).getDate(), last));
  return d.getTime();
}

function futureMilestones(birthMs) {
  const today = startOfDay(Date.now());
  const items = LIFE_MILESTONES.map((m) => {
    const at = m.at(birthMs);
    return {
      key: m.key,
      name: m.name,
      date: dayOf(at),
      reached: startOfDay(at) <= today,
      daysLeft: Math.max(0, Math.round((startOfDay(at) - today) / DAY)),
    };
  });
  return { items, next: items.find((m) => !m.reached) || null };
}

function ageParts(birthMs, nowMs) {
  const b = new Date(birthMs);
  const n = new Date(nowMs);
  let years = n.getFullYear() - b.getFullYear();
  let months = n.getMonth() - b.getMonth();
  let days = n.getDate() - b.getDate();
  if (days < 0) {
    months -= 1;
    days += new Date(n.getFullYear(), n.getMonth(), 0).getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  years = Math.max(0, years);
  months = Math.max(0, months);
  days = Math.max(0, days);
  return { years, months, days, text: `${years} 岁 ${months} 个月 ${days} 天` };
}

function nextBirthdayInfo(birthMs, nowMs) {
  const b = new Date(birthMs);
  const n = new Date(nowMs);
  const today = startOfDay(nowMs);
  let next = new Date(n.getFullYear(), b.getMonth(), b.getDate());
  if (startOfDay(next.getTime()) <= today) next = new Date(n.getFullYear() + 1, b.getMonth(), b.getDate());
  const daysLeft = Math.max(0, Math.round((startOfDay(next.getTime()) - today) / DAY));
  return { date: dayOf(next.getTime()), daysLeft, ageAt: next.getFullYear() - b.getFullYear() };
}

/** 她的一天：从计划任务清单里找每天固定时间的条目。 */
function scheduleView() {
  const manifest = readJson(path.join(APP_ROOT, 'scripts', 'tasks.manifest.json'), { tasks: [] });
  const labels = {
    'xiaoyu-dream': '做梦', 'xiaoyu-memory': '把昨天收进长期记忆', 'xiaoyu-world': '看外面的世界',
    'xiaoyu-morning': '起床', 'xiaoyu-anniversary': '纪念日', 'xiaoyu-life-1': '自己过一会儿',
    'xiaoyu-life-2': '自己过一会儿', 'xiaoyu-life-3': '自己过一会儿', 'xiaoyu-memoir': '写回忆录',
    'xiaoyu-night': '睡前', 'xiaoyu-cost': '算账', 'xiaoyu-tool-report': '工具使用报告',
    'xiaoyu-backup': '备份记忆',
  };
  const items = (manifest.tasks || [])
    .filter((t) => t.mode === 'daily' && t.time && t.name !== 'xiaoyu-asr-start')
    .map((t) => ({ time: t.time, name: t.name, label: labels[t.name] || t.name }))
    .sort((a, b) => a.time.localeCompare(b.time));
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  let next = '';
  for (const item of items) { if (item.time >= hhmm) { next = item.time; break; } }
  return { items, now: hhmm, next: next || (items[0] ? items[0].time : '') };
}

function worksView() {
  const projects = readJson(PROJECTS, { items: [] });
  const images = (() => { try { return fs.readdirSync(IMAGES_DIR).filter((f) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f)).length; } catch { return 0; } })();
  const audio = (() => { try { return fs.readdirSync(AUDIO_DIR).filter((f) => /\.(mp3|wav|ogg|m4a|flac|silk|amr)$/i.test(f)).length; } catch { return 0; } })();
  const memoir = memoirFiles().length;
  return {
    images,
    audio,
    notes: listNotes({ limit: 1 }).total,
    memoir,
    projects: (projects.items || []).map((p) => ({
      id: p.id, title: p.title, kind: p.kind, done: p.done ?? 0, total: p.total ?? 0, note: p.note || '', updatedAt: p.updatedAt || 0,
    })),
  };
}

export function lifeView() {
  const life = ensureBirth();
  const birthMs = new Date(`${life.birth}T00:00:00`).getTime();
  const days = Math.max(1, Math.floor((startOfDay(Date.now()) - birthMs) / DAY) + 1);
  const stage = stageInfo(days);

  const diary = readJsonl(DIARY_INDEX);
  const dreams = readJsonl(DREAMS);
  const fantasies = readJsonl(FANTASIES);
  const knowledge = readJsonl(KNOWLEDGE);
  const projects = readJson(PROJECTS, { items: [] });
  const entries = [];
  const add = (at, kind, title, text = '') => {
    if (!at) return;
    const ms = typeof at === 'number' ? at : new Date(`${String(at).slice(0, 10)}T12:00:00`).getTime();
    if (!ms || Number.isNaN(ms)) return;
    entries.push({ at: ms, day: dayOf(ms), n: Math.max(1, Math.floor((startOfDay(ms) - birthMs) / DAY) + 1), kind, title, text: String(text || '').slice(0, 180) });
  };

  add(birthMs, 'birth', '出生', '第一次启动，她开始有记忆。');
  if (diary.length) add(diary[0].t, 'diary', `第一篇日记：${diary[0].title}`, diary[0].text);
  for (const chapter of memoirFiles()) {
    add(chapter.date ? new Date(`${chapter.date}T21:00:00`).getTime() : null, 'memoir', `回忆录 ${chapter.name.replace(/\.md$/, '')}`);
  }
  if (dreams.length) add(dreams[0].at, 'dream', '第一个梦', dreams[0].dream);
  if (fantasies.length) add(fantasies[0].at, 'fantasy', '第一条幻想', fantasies[0].text);
  if (knowledge.length) add(knowledge[0].createdAt, 'knowledge', `学会：${knowledge[0].title}`, knowledge[0].text);

  for (const item of (projects.items || [])) {
    add(item.createdAt, 'project', `开始一个长期项目：${item.title}`, item.note || '');
    if (item.updatedAt && item.updatedAt !== item.createdAt) {
      add(item.updatedAt, 'project', `项目进展：${item.title}（${item.done ?? 0}/${item.total ?? '?'}）`, item.note || '');
    }
  }

  const seenTools = new Set();
  const toolLabels = {
    qq_draw: '第一次画画', qq_sketch: '第一次手绘', qq_sing: '第一次唱歌', qq_say: '第一次用自己的声音说话',
    qq_send_voice: '第一次发语音', qq_qzone_post: '第一次发 QQ 空间', qq_bili: '第一次看 B 站',
    qq_pc_screenshot: '第一次看他的屏幕', qq_get_message_images: '第一次收到图片',
  };
  for (const call of readJsonl(TOOL_CALLS)) {
    const name = String(call.tool || '').replace(/^mcp__.+?__/, '');
    if (call.type !== 'call' || !toolLabels[name] || seenTools.has(name)) continue;
    seenTools.add(name);
    add(Date.parse(call.time) || 0, 'tool', toolLabels[name], '');
  }

  for (const file of journalDays()) {
    const rows = readJsonl(path.join(JOURNAL_DIR, file));
    for (const row of rows) {
      if (row.role !== 'her' && !/她/.test(row.role || '')) continue;
      if (/移出|踢出|踢了|踢我|赶出/.test(String(row.text || ''))) {
        add(row.t, 'wound', '第一次被移出群', String(row.text || ''));
        break;
      }
    }
    if (entries.some((e) => e.kind === 'wound')) break;
  }

  for (const d of diary.slice(1)) add(d.t, 'diary', d.title, d.text);
  for (const d of dreams.slice(1)) add(d.at, 'dream', '一个梦', d.dream);
  for (const f of fantasies.slice(1)) add(f.at, 'fantasy', '一条幻想', f.text);

  const seen = new Set();
  const timeline = entries
    .sort((a, b) => b.at - a.at)
    .filter((e) => { const key = `${e.kind}:${e.at}:${e.title}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, 120);

  const journalMessages = journalDays().reduce((n, file) => n + readJsonl(path.join(JOURNAL_DIR, file)).length, 0);
  const project = (projects.items || [])[0] || null;
  const works = worksView();
  const schedule = scheduleView();
  const nowMs = Date.now();
  const future = futureMilestones(birthMs);

  return {
    birth: life.birth,
    days,
    future: {
      age: ageParts(birthMs, nowMs),
      birthday: nextBirthdayInfo(birthMs, nowMs),
      next: future.next,
      items: future.items,
    },
    stage: {
      id: stage.current.id,
      name: stage.current.name,
      next: stage.next ? stage.next.name : '',
      daysToNext: stage.daysToNext,
      progress: Number(stage.progress.toFixed(3)),
      unlock: stage.current.unlock,
      unlocks: STAGES.map((s) => ({ name: s.name, min: s.min, unlock: s.unlock, unlocked: days >= s.min })),
    },
    stages: STAGES.map((s) => ({ name: s.name, min: s.min })),
    stats: {
      diary: diary.length,
      memoir: memoirFiles().length,
      dreams: dreams.length,
      fantasies: fantasies.length,
      knowledge: knowledge.length,
      messages: journalMessages,
      days: journalDays().length,
    },
    works,
    schedule,
    project: project ? { title: project.title, done: project.done ?? 0, total: project.total ?? 0, note: project.note || '', updatedAt: project.updatedAt || 0 } : null,
    milestones: timeline.filter((e) => !['diary', 'dream', 'fantasy'].includes(e.kind)).slice(0, 40),
    timeline,
    now: Date.now(),
  };
}

/** 年鉴：把最近 N 天的日记/回忆录/里程碑整理成一段 Markdown，存到 state/chronicles/。 */
export function generateChronicle({ days = 100 } = {}) {
  const life = ensureBirth();
  const birthMs = new Date(`${life.birth}T00:00:00`).getTime();
  const totalDays = Math.max(1, Math.floor((startOfDay(Date.now()) - birthMs) / DAY) + 1);
  const span = Math.max(1, Math.min(Number(days) || 100, totalDays));
  const from = Date.now() - span * DAY;
  const to = Date.now();

  const diary = readJsonl(DIARY_INDEX).filter((e) => (e.t || 0) >= from);
  const dreams = readJsonl(DREAMS).filter((e) => (e.at || 0) >= from);
  const fantasies = readJsonl(FANTASIES).filter((e) => (e.at || 0) >= from);
  const chapters = memoirFiles().filter((c) => !c.date || new Date(`${c.date}T00:00:00`).getTime() >= from);
  const knowledge = readJsonl(KNOWLEDGE).filter((e) => (e.createdAt || 0) >= from);
  const projects = readJson(path.join(STATE_DIR, 'projects.json'), { items: [] });

  const moodCount = {};
  for (const d of diary) if (d.mood) moodCount[d.mood] = (moodCount[d.mood] || 0) + 1;
  const topMoods = Object.entries(moodCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const lines = [];
  lines.push(`# 她的这一段：第 ${Math.max(1, totalDays - span + 1)} ~ ${totalDays} 天`);
  lines.push('');
  lines.push(`- 出生：${life.birth}`);
  lines.push(`- 这一段：${dayOf(from)} → ${dayOf(to)}（${span} 天）`);
  lines.push(`- 日记 ${diary.length} 篇 · 回忆录 ${chapters.length} 章 · 梦 ${dreams.length} 个 · 幻想 ${fantasies.length} 条 · 学会 ${knowledge.length} 件`);
  if (topMoods.length) lines.push(`- 最常出现的心情：${topMoods.map(([m, n]) => `${m}（${n}）`).join('、')}`);
  const project = (projects.items || [])[0];
  if (project) lines.push(`- 长期项目：${project.title} ${project.done ?? 0}/${project.total ?? 0}`);
  lines.push('');
  lines.push('## 她写下的');
  const sorted = diary.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
  for (const d of sorted.slice(0, 40)) {
    lines.push('');
    lines.push(`### ${d.day || dayOf(d.t)} · ${d.title || '（无题）'}${d.mood ? `（${d.mood}）` : ''}`);
    lines.push(String(d.text || '').trim());
  }
  if (chapters.length) {
    lines.push('');
    lines.push('## 回忆录');
    for (const c of chapters) lines.push(`- ${c.name.replace(/\.md$/, '')}`);
  }
  if (dreams.length) {
    lines.push('');
    lines.push('## 梦');
    for (const d of dreams.slice(0, 10)) lines.push(`- ${d.dream}`);
  }
  if (fantasies.length) {
    lines.push('');
    lines.push('## 幻想');
    for (const f of fantasies.slice(0, 10)) lines.push(`- ${f.text}`);
  }

  const markdown = `${lines.join('\n')}\n`;
  fs.mkdirSync(CHRONICLES, { recursive: true });
  const label = `${life.birth}-${String(totalDays).padStart(4, '0')}d`;
  const file = path.join(CHRONICLES, `chronicle-${label}.md`);
  fs.writeFileSync(file, markdown, 'utf8');
  return { ok: true, file, label, days: span, markdown, size: Buffer.byteLength(markdown) };
}

export function chronicleList() {
  try {
    return fs.readdirSync(CHRONICLES).filter((f) => f.endsWith('.md')).sort().reverse().map((name) => {
      const full = path.join(CHRONICLES, name);
      const stat = fs.statSync(full);
      return { name, size: stat.size, at: stat.mtimeMs };
    });
  } catch { return []; }
}

/** 读一份年鉴。 */
export function readChronicle(name) {
  const safe = path.basename(String(name || ''));
  if (!/^chronicle-[A-Za-z0-9._-]+\.md$/.test(safe)) {
    const error = new Error('文件名不合法');
    error.statusCode = 400;
    throw error;
  }
  return { ok: true, name: safe, markdown: fs.readFileSync(path.join(CHRONICLES, safe), 'utf8') };
}
