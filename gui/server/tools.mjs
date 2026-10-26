// 工具清单：直接问三个 MCP server 要 tools/list，按用途分组给面板展示。
// 结果缓存 60 秒；刷新用 ?refresh=1。

import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_ROOT, STATE_DIR, readConfig, detectEngines, capabilities } from '../../src/paths.js';
import { saveToolDisabled } from './data.mjs';

const SERVERS = [
  { id: 'qq', label: 'QQ 工具', script: 'src/mcp-snowluma-safe.js' },
  { id: 'host', label: '网关探活', script: 'src/mcp-host-server.js' },
  { id: 'web', label: '联网', script: 'src/mcp-web-search-safe.js' },
];

// 配置里关掉的是 flag 名，这里映射回工具名，面板上才能显示"哪几个被关了"
const FLAG_TO_NAME = {
  getMessageDetail: 'qq_get_message_detail',
  getActiveMembers: 'qq_get_active_members',
  getForwardMsg: 'qq_get_forward_msg',
  getSelfImage: 'qq_get_self_image',
  setStickerRemark: 'qq_set_sticker_remark',
  stickerNote: 'qq_sticker_note',
  slangQuery: 'qq_slang_query',
  slangSubmit: 'qq_slang_submit',
};

const GROUP_ORDER = [
  ['send', '发消息'],
  ['read', '看消息 / 等待'],
  ['media', '表情、图片、语音'],
  ['create', '画图、唱歌、动图'],
  ['memory', '记忆与自我'],
  ['time', '时间、提醒、天气'],
  ['qzone', 'QQ 空间'],
  ['pc', '电脑操作'],
  ['net', '联网'],
  ['ops', '状态与运维'],
];

function groupOf(name) {
  if (/^qq_pc_/.test(name)) return 'pc';
  if (/^qq_qzone_/.test(name)) return 'qzone';
  if (/^qq_draw$|^qq_anim$|^qq_sketch$|^qq_sing$|^qq_music_|^qq_bili$/.test(name)) return 'create';
  if (/^qq_send_|^qq_reply$|^qq_say$/.test(name)) return 'send';
  if (/^qq_get_|^qq_wait_for_messages$|^qq_recall$|^qq_mark_read$|^qq_social_state$|^qq_get_prompt$|^qq_status$/.test(name)) return 'read';
  if (/^qq_(send_image|send_sticker|sticker|list_stickers|collect_sticker|get_sticker_image|list_images|image_search|send_voice|list_voices|get_message_images)$/.test(name)) return 'media';
  if (/^qq_(diary_|memoir_|dream|fantasy_|knowledge_|memory_|inner_state|mood|body|wants|introspect|project_update)/.test(name)) return 'memory';
  if (/^qq_(remind|reminders|now|weather)/.test(name)) return 'time';
  if (/^qq_(web_|capabilities|report_feedback|set_wake_config)/.test(name)) return 'ops';
  if (/^(web_search|web_fetch|snowluma_status)$/.test(name)) return 'net';
  return 'ops';
}

function tagsFor(name, caps) {
  const tags = [];
  if (/^qq_pc_/.test(name)) tags.push('仅主人私聊');
  if (/^qq_(draw|anim)$/.test(name)) tags.push(caps.draw ? '画图已装' : '需要 ComfyUI');
  if (/^qq_(sing|music_)/.test(name)) tags.push(caps.sing ? '唱歌已装' : '需要 RVC');
  if (/^qq_(say|send_voice|list_voices)$/.test(name)) tags.push(caps.voice ? '声音已装' : '需要 GPT-SoVITS');
  if (/^qq_sketch$/.test(name)) tags.push('需要 python');
  if (/^qq_bili$|^qq_web_|^web_/.test(name)) tags.push('需要联网');
  if (/write|^qq_send_|^qq_reply$|^qq_mark_read$|^qq_set_wake_config$|^qq_remind$|^qq_qzone_post$|^qq_qzone_like$|^qq_collect_sticker$/.test(name)) tags.push('会改状态');
  return tags.slice(0, 2);
}

function listFrom(script) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'timeout', tools: [] }), 25000);
    (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [script],
        cwd: APP_ROOT,
        env: { ...process.env },
        stderr: 'ignore',
      });
      const client = new Client({ name: 'console-tools', version: '1' }, { capabilities: {} });
      try {
        await client.connect(transport);
        const r = await client.listTools();
        resolve({
          ok: true,
          tools: r.tools.map((t) => ({ name: t.name, desc: String(t.description || '').split('\n')[0].slice(0, 140) })),
        });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message ?? error), tools: [] });
      } finally {
        clearTimeout(timer);
        await client.close().catch(() => {});
      }
    })();
  });
}

let cache = { at: 0, data: null };

/** 从 MCP 源码里读「工具名 → 配置开关」的映射（唯一权威在 mcp-snowluma-safe.js）。 */
function toolFlagMap() {
  try {
    const src = fs.readFileSync(path.join(APP_ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
    const start = src.indexOf('const TOOL_CONFIG_FLAGS = {');
    if (start < 0) return {};
    const block = src.slice(start, src.indexOf('};', start));
    const map = {};
    for (const m of block.matchAll(/([A-Za-z0-9_]+):\s*'([A-Za-z0-9_]+)'/g)) map[m[1]] = m[2];
    return map;
  } catch { return {}; }
}

/** 从 state/tool-calls.jsonl 汇总：每个工具被调几次、成功/失败、最近一次。 */
function usageStats() {
  const stats = new Map();
  try {
    const file = path.join(STATE_DIR, 'tool-calls.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-20000);
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const short = String(e.tool || '').replace(/^mcp__.+?__/, '');
      if (!short) continue;
      const s = stats.get(short) || { calls: 0, ok: 0, fail: 0, lastAt: 0, lastKey: '' };
      if (e.type === 'call') s.calls += 1;
      else if (e.type === 'result') { if (e.ok) s.ok += 1; else s.fail += 1; }
      const t = Date.parse(e.time) || 0;
      if (t > s.lastAt) { s.lastAt = t; s.lastKey = e.key || ''; }
      stats.set(short, s);
    }
  } catch { /* 没日志就是没用过 */ }
  return stats;
}

/** 最近调用明细：按 call/result 配对，返回时间、工具、会话、成败。 */
function recentCalls(limit = 60) {
  const items = [];
  const pending = new Map();
  try {
    const file = path.join(STATE_DIR, 'tool-calls.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-5000);
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!String(e.tool || '').startsWith('mcp__')) continue;
      const short = String(e.tool).replace(/^mcp__.+?__/, '');
      if (!short) continue;
      const at = Date.parse(e.time) || 0;
      const k = `${e.key || ''}|${short}`;
      if (e.type === 'call') {
        const item = { at, tool: short, key: e.key || '', ok: null };
        items.push(item);
        if (!pending.has(k)) pending.set(k, []);
        pending.get(k).push(item);
      } else if (e.type === 'result') {
        const item = pending.get(k)?.shift();
        if (item) item.ok = e.ok !== false;
      }
    }
  } catch { /* 没日志就是没用过 */ }
  return items.slice(-limit).reverse();
}


/** 工具元数据快照：停用后 MCP 下次启动就不再列出它，靠快照仍能在面板里显示并重新启用。 */
function loadSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'tool-catalog.json'), 'utf8'));
  } catch { return {}; }
}

function saveSnapshot(tools) {
  try {
    const map = loadSnapshot();
    for (const tool of tools) {
      map[tool.name] = { desc: tool.desc, source: tool.source };
    }
    fs.writeFileSync(path.join(STATE_DIR, 'tool-catalog.json'), JSON.stringify(map, null, 2));
  } catch { /* 快照写不进去不影响主流程 */ }
}

export async function toolCatalog({ refresh = false } = {}) {
  if (!refresh && cache.data) {
    const fresh = Date.now() - cache.at < 60_000;
    const failed = (cache.data.sources || []).some((s) => !s.ok);
    if (fresh && !failed) return cache.data;
  }

  const cfg = readConfig();
  const engineSet = detectEngines({ cfg });
  const caps = capabilities(engineSet);
  const flagOf = toolFlagMap();
  const usage = usageStats();
  const flagCount = {};
  for (const flag of Object.values(flagOf)) flagCount[flag] = (flagCount[flag] || 0) + 1;
  const disabledSet = new Set(Array.isArray(cfg.socialV2?.disabledTools) ? cfg.socialV2.disabledTools : []);

  let results = await Promise.all(SERVERS.map(async (s) => ({ ...s, ...(await listFrom(s.script)) })));
  // 冷启动时三个 MCP 同时 spawn 偶尔会超时：失败的单独补一次（串行，避开争用）
  for (const item of results.filter((r) => !r.ok)) {
    const retry = await listFrom(item.script);
    if (retry.ok) Object.assign(item, retry);
  }
  const all = results.flatMap((r) => r.tools.map((t) => ({ ...t, source: r.id })));
  const realAll = all.slice();
  saveSnapshot(realAll);
  // 被停用的工具可能已经不在 MCP 的列表里：用快照补回来，面板才能重新启用
  const snapshot = loadSnapshot();
  for (const name of disabledSet) {
    if (all.some((x) => x.name === name)) continue;
    const info = snapshot[name] || {};
    all.push({ name, desc: info.desc || '（已停用；重启 DSH 后不再从 MCP 列出）', source: info.source || 'qq' });
  }

  const groups = new Map();
  for (const tool of all) {
    const gid = groupOf(tool.name);
    if (!groups.has(gid)) groups.set(gid, []);
    const flag = flagOf[tool.name] || '';
    const used = usage.get(tool.name) || { calls: 0, ok: 0, fail: 0, lastAt: 0, lastKey: '' };
    groups.get(gid).push({
      name: tool.name,
      desc: tool.desc,
      tags: tagsFor(tool.name, caps),
      source: tool.source,
      flag,
      enabled: !disabledSet.has(tool.name) && (!flag || cfg.socialV2?.tools?.[flag] !== false),
      shared: flag ? (flagCount[flag] || 1) : 1,
      usage: used,
    });
  }

  const ordered = GROUP_ORDER
    .filter(([id]) => groups.has(id))
    .map(([id, label]) => ({ id, label, tools: groups.get(id).sort((a, b) => a.name.localeCompare(b.name)) }));

  const disabled = [
    ...Object.entries(cfg.socialV2?.tools ?? {})
      .filter(([, v]) => v === false)
      .map(([flag]) => ({ flag, name: FLAG_TO_NAME[flag] || flag, kind: 'flag' })),
    ...[...disabledSet].map((name) => ({ flag: '', name, kind: 'tool' })),
  ];

  const enabledTotal = ordered.reduce((n, g) => n + g.tools.filter((t) => t.enabled).length, 0);

  const data = {
    generatedAt: Date.now(),
    total: all.length,
    enabledTotal,
    disabledTotal: all.length - enabledTotal,
    capabilities: caps,
    disabled,
    sources: results.map(({ id, label, ok, error }) => ({ id, label, ok, error: error || '' })),
    groups: ordered,
    recent: recentCalls(60),
  };
  cache = { at: Date.now(), data };
  return data;
}

/** 验证一个工具“现在的实际效果”：配置是否放行、运行中的 MCP 是否还列出它。 */
export async function verifyTool(name) {
  if (!name) {
    const error = new Error('缺少工具名');
    error.statusCode = 400;
    throw error;
  }
  const cfg = readConfig();
  const disabledSet = new Set(Array.isArray(cfg.socialV2?.disabledTools) ? cfg.socialV2.disabledTools : []);
  const flag = toolFlagMap()[name] || '';
  const flagOff = Boolean(flag && cfg.socialV2?.tools?.[flag] === false);
  const configuredEnabled = !disabledSet.has(name) && !flagOff;

  const catalog = await toolCatalog();
  let listedInMcp = false;
  let source = '';
  for (const group of catalog.groups || []) {
    const hit = group.tools.find((t) => t.name === name);
    if (hit) { listedInMcp = true; source = hit.source || ''; break; }
  }

  const needRestart = configuredEnabled !== listedInMcp;

  let verdict;
  if (configuredEnabled && listedInMcp) verdict = '已启用，MCP 列表里也有：可以直接用';
  else if (configuredEnabled && !listedInMcp) verdict = '已启用，但 MCP 还没列出：重启 DSH 后才会出现';
  else if (!configuredEnabled && listedInMcp) verdict = '已停用，桥接会立即拒绝；MCP 仍列出，重启 DSH 后消失';
  else verdict = '已停用，MCP 里也已经没有了';

  return {
    name, configuredEnabled, listedInMcp, needRestart, verdict, source,
    flag, flagOff, disabledByList: disabledSet.has(name),
    checkedAt: Date.now(),
  };
}

/** 单个工具的开关：写 config.socialV2.disabledTools，并让缓存失效。 */export async function setToolEnabled(name, enabled) {
  if (typeof enabled !== 'boolean') {
    const error = new Error('enabled 必须是布尔');
    error.statusCode = 400;
    throw error;
  }
  const result = saveToolDisabled(name, !enabled);
  cache = { at: 0, data: null };
  return { ok: true, name, enabled, disabledTools: result.disabledTools, backup: result.backup };
}
