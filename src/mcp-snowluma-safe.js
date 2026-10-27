import { situationView, contextualContinuity, executeSituationSend } from './situation.js';
import { askAgent } from './agent-delegate.js';
// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
const deliveryCallScope = new AsyncLocalStorage();
import { runDrawingPlan, chooseLocalTemplate } from './drawing-fallback.js';
import { drawingScope } from './experience-learning.js';
import { continuityView, creativeConstraints, recordContinuityApplication, assertContactPolicy } from './continuity.js';
import { runAdaptiveOperation, stateFingerprint, digest } from './adaptive-tools.js';
import { guardedDelivery, deliveryIntent, deliveryPayload } from './delivery-guard.js';
import { looksLikeImageBuffer } from './safe-fetch.js';
import { narrativeRecord } from './reality.js';
import { journalEvent } from './memory-attribution.js';
import { verifyArtifact } from './commitments.js';
import { updateJson } from './state-store.js';
import { recordDelivery } from './deliveries.js';
import { createRequire } from 'node:module';
globalThis.__singRequire = createRequire(import.meta.url);
import http from 'node:http';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import {
  APP_ROOT as ROOT,
  STATE_DIR,
  STATE_FILES,
  IMAGES_DIR,
  IMAGE_INDEX_FILE,
  AUDIO_TTS_DIR,
  SKETCH_SCRIPT,
  CONFIG_FILE,
  PC_ROOTS,
  PC_NOTE_DIR,
  PORTS,
  COMPANION_CONFIG,
  HOME_DIR,
  detectEngines,
  statePath
} from './paths.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { serializeModelData } from './qq-model-view.js';
import { createOneBotHttp, discoverSnowLumaConnection } from './snowluma/index.js';

// 路径全部来自唯一来源 src/paths.js。

function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

// HTTP 传输统一在 src/snowluma/http.js：token 头、426 提示、retcode 判断只有一份。
// 这里多一层「换账号自愈」：401 / retcode 1401 时去 SnowLuma 的 per-account 配置里重新找
// token，找到就用它重试一次并缓存 5 分钟 —— 桥接没在跑的时候工具也能自己跟上。
let discoveredAuth = null;   // { baseUrl, token, at }
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

async function rawOnebot(action, params = {}, receiptContext = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const cached = discoveredAuth
    && Date.now() - discoveredAuth.at < DISCOVERY_TTL_MS
    && discoveredAuth.baseUrl === httpUrl;
  const http = createOneBotHttp({ baseUrl: httpUrl, token: cached ? discoveredAuth.token : token });
  try {
    const data = await http.call(action, params, { timeoutMs: 15000 });
    try { recordDelivery(STATE_FILES.deliveries, action, params, data, Date.now(), receiptContext); } catch { console.error('成功发送，但交付回执未能保存；请勿重发'); }
    return data;
  } catch (error) {
    if (error?.status !== 401 && error?.retcode !== 1401) throw error;
    const found = await discoverSnowLumaConnection({ cfg: getConfig(), timeoutMs: 3000 });
    if (!found.ok) throw error;
    discoveredAuth = { baseUrl: found.baseUrl, token: found.token, at: Date.now() };
    const data = await createOneBotHttp({ baseUrl: found.baseUrl, token: found.token }).call(action, params, { timeoutMs: 15000 });
    try { recordDelivery(STATE_FILES.deliveries, action, params, data, Date.now(), receiptContext); } catch { console.error('成功发送，但交付回执未能保存；请勿重发'); }
    return data;
  }
}

function effectiveContinuity(key,taskId){
 const social=JSON.parse(fs.existsSync(STATE_FILES.socialV2)?fs.readFileSync(STATE_FILES.socialV2,'utf8').replace(/^\uFEFF/,''):'{"conversations":{}}');
 return contextualContinuity(continuityView(STATE_FILES.continuity,key,Date.now(),taskId),situationView(STATE_FILES.situation,key,social.conversations?.[key]||{}));
}

async function onebot(action, params = {}, options = {}) {
  if (!['send_private_msg','send_group_msg'].includes(action)) return rawOnebot(action, params);
  const key = action === 'send_private_msg' ? `private:${params.user_id}` : `group:${params.group_id}`;
  const access = getAccess(), m = /^(private|group):(\d+)$/.exec(key);
  if (!m || !isAllowed(m[1] === 'private' ? access.allowPrivate : access.allowGroups, m[1] === 'private' ? access.denyPrivate : access.denyGroups, m[2], access.allowAllWhenEmpty)) throw new Error('目标不在白名单，未发送');
  const tool = params.message?.some(s => s.type === 'record') ? 'qq_say' : params.message?.some(s => s.type === 'image') ? 'qq_send_image' : 'qq_send_message';
  return guardedDelivery({ file: STATE_FILES.deliveryOperations, learningFile: STATE_FILES.learning, receiptsFile: STATE_FILES.deliveries,
    key, tool, intent: deliveryIntent(STATE_FILES.socialV2, key), condition: digest(getOneBotConfig()),
    request: deliveryCallScope.getStore() && (tool === 'qq_say' || deliveryCallScope.getStore().tool === 'qq_sketch')
      ? { action, logical: deliveryCallScope.getStore(), slot: options.deliverySlot || 'single' }
      : { action, params: deliveryPayload(params), slot: options.deliverySlot || 'single' },
    execute: async context => {
      const intent=deliveryIntent(STATE_FILES.socialV2,key);
      const social=JSON.parse(fs.existsSync(STATE_FILES.socialV2)?fs.readFileSync(STATE_FILES.socialV2,'utf8').replace(/^\uFEFF/,''):'{"conversations":{}}');
      const state=social.conversations?.[key]||{};
      const view=contextualContinuity(continuityView(STATE_FILES.continuity,key),situationView(STATE_FILES.situation,key,state));
      const lines=options.utterance?[options.utterance]:(params.message||[]).filter(s=>s.type==='text').map(s=>s.data?.text||'');
      assertContactPolicy(view,{state:social.conversations?.[key]||{},intent,messages:lines});
      const data=await executeSituationSend({file:STATE_FILES.situation,key,state,messages:lines,voiceUnknown:tool==='qq_say'&&!options.utterance,appliedFeedbackIds:view.activeFeedback.map(f=>f.id),execute:()=>rawOnebot(action,params,context)});
      try {recordContinuityApplication(STATE_FILES.continuity,key,{feedbackIds:view.activeFeedback.filter(f=>['contact','tone','detail','address'].includes(f.dimension)).map(f=>f.id),operation:'send',evidenceId:String(data.message_id),intent});}catch{console.error('发送成功，但互动调整记录未保存；勿因此重发');}
      return data;
    }, verify: id => rawOnebot('get_msg', { message_id: Number(id) }) });
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  //
  // 必须与桥接的校验口径**完全一致**（bridge.js 的 startConsoleServer：长度 16~128、
  // 只允许 [A-Za-z0-9_-]，不合法就忽略并回退 state/console-token）。否则用户手填一个
  // 短令牌时桥接会正常运行，而 MCP 拿着这个桥接根本不认的值去请求 —— 每个工具都 401，
  // 且错误信息里看不出原因是"config.json 里的令牌格式不合法"。
  try {
    const c = getConfig();
    const configured = String(c.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    const tokenFile = STATE_FILES.consoleToken;
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把桥接返回的 `error` 变成可读文本。
 *
 * 为什么必须有：桥接个别分支会回一个**对象**（例如 `{code, message}`），直接
 * `new Error(obj)` 会把它 String 成 "[object Object]" —— 模型和运维都读不到任何信息。
 * r3 的已知未修项里就记着 `qq_wait_for_messages` 出现过 `error: "\"Error: [object Object]\""`。
 */
function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text && text !== '{}') return text.slice(0, 500);
    } catch {}
    const message = value.message ?? value.msg ?? value.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const headers = agentHeaders(rest.headers);
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(errorText(body?.error, `桥接 API HTTP ${res.status}`));
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(errorText(body.error, '桥接 API 返回 ok:false（未说明原因）'));
  }
  return body;
}

/**
 * 桥接 API 请求头（含控制台令牌、x-agent-call 与调用方附加头）。
 * 拆出来是为了长轮询通道复用同一套鉴权，避免两条通路口径漂移。
 */
function agentHeaders(extra = {}) {
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(extra ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  return headers;
}

/**
 * 长轮询专用 POST（`node:http`，不经过 undici）。
 *
 * 为什么必须单独一条：Node 的全局 `fetch` 是 undici，自带 300 秒 `headersTimeout`。
 * 而 `qq_wait_for_messages` 的常规用法就是 `timeoutMs=300000` 的沉睡前观察 ——
 * 客户端会在第 301 秒以 `fetch failed / Headers Timeout Error` 断掉，桥接侧的
 * 长轮询却还在跑满自己的预算：AI 拿不到结果只能重试，而 `activeWaits` 仍占着会话
 * （重新等待被 429），于是空转烧 token（见 issue #24）。`node:http` 没有默认响应超时，
 * 超时完全由这里的计时器按调用方预算控制。
 */
function agentApiLongPoll(path, init = {}) {
  const timeoutMs = Math.max(1000, Number(init.timeoutMs) || 15000);
  const url = new URL(`${agentApiBase()}${path}`);
  const body = init.body == null ? '' : String(init.body);
  const headers = agentHeaders(init.headers);
  headers['content-length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      res?.destroy();
    }, timeoutMs);
    timer.unref?.();
    try {
      req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers,
        timeout: 0
      }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          // 桥接的 wait 响应本来就是小 JSON；超过 4MB 说明对端异常，别把内存吃光。
          if (size > 4 * 1024 * 1024) {
            finish(new Error('等待响应体过大，已中止'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new Error('等待响应中断')));
        response.on('close', () => { if (!response.complete) finish(new Error('等待响应中断')); });
        response.on('end', () => {
          if (settled) return;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            finish(new Error(errorText(parsed?.error, `桥接 API HTTP ${status}`)));
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            finish(new Error(errorText(parsed.error, '桥接 API 返回 ok:false（未说明原因）')));
            return;
          }
          finish(null, parsed);
        });
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

// 版本号从 package.json 读，别在代码里再写一份（两处漂移过）
const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
})();
const server = new McpServer({ name: 'snowluma-safe', version: PKG_VERSION });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_get_group_members: 'getGroupMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_commitments: 'memory',
  qq_project_workflow: 'memory',
  qq_learning: 'memory',
  qq_continuity: 'memory',
  qq_agency: 'memory',
  qq_recall: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  qq_send_image: 'sendImage',
  qq_list_images: 'sendImage',
  qq_qzone_post: 'qzone',
  qq_qzone_feeds: 'qzone',
  qq_qzone_like: 'qzone',
  qq_diary_write: 'diary',
  qq_diary_recent: 'diary',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_ask_agent: 'askAgent',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
};
const disabledTools = [];
const disabledAtStart = new Set(Array.isArray(cfg.socialV2?.disabledTools) ? cfg.socialV2.disabledTools : []);
const toolState = { mtime: 0, disabled: disabledAtStart };
// 面板里停用后热生效：每次调用前按 config.json 的 mtime 重读一次 disabledTools。
function toolDisabledNow(name) {
  try {
    const st = fs.statSync(CONFIG_FILE);
    if (st.mtimeMs !== toolState.mtime) {
      toolState.mtime = st.mtimeMs;
      const fresh = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
      toolState.disabled = new Set(Array.isArray(fresh.socialV2?.disabledTools) ? fresh.socialV2.disabledTools : []);
    }
  } catch { /* 读不到就沿用内存里的 */ }
  return toolState.disabled.has(name);
}
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.socialV2?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    // 启动时被停用的工具干脆不注册（重启 DSH 后从列表里消失）
    if (disabledAtStart.has(name)) {
      disabledTools.push(`${name}(disabledTools)`);
      return undefined;
    }
    const idx = rest.length - 1;
    if (typeof rest[idx] === 'function') {
      const handler = rest[idx];
      rest[idx] = async (...args) => {
        if (toolDisabledNow(name)) {
          return { content: [{ type: 'text', text: `工具已停用：${name}。在管家面板「工具」页可以重新启用。` }], isError: true };
        }
        const invoke = () => deliveryCallScope.run({ tool: name, inputHash: digest({ ...(args[0] || {}), token: undefined }) }, () => handler(...args));
        if (!['qq_sketch','qq_say','qq_send_image'].includes(name)) return invoke();
        const input = args[0] || {}, key = input.key || 'machine';
        if (input.key) {
          const m = /^(private|group):(\d+)$/.exec(input.key), access = getAccess();
          if (!m || !isAllowed(m[1] === 'private' ? access.allowPrivate : access.allowGroups, m[1] === 'private' ? access.denyPrivate : access.denyGroups, m[2], access.allowAllWhenEmpty)) return invoke();
        }
        const intent = input.key ? deliveryIntent(STATE_FILES.socialV2, input.key) : 'local';
        let artifact = null;
        if (name === 'qq_send_image') { try { artifact = verifyArtifact(ROOT, 'images/' + input.image).sha256; } catch {} }
        try {
          return await runAdaptiveOperation({ file: STATE_FILES.learning, tool: name, key,
            input: { ...input, token: undefined }, intent, condition: stateFingerprint([CONFIG_FILE, SKETCH_SCRIPT, SKETCH_PY], [intent, artifact]),
            execute: async () => { const r = await invoke(); if (r?.isError) { const e = new Error(r.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '工具失败');e.toolResult = r;throw e; } return r; } });
        } catch (error) { return error.toolResult || { content: [{ type: 'text', text: error.message }], isError: true }; }
      };
    }
    return registerTool(name, ...rest);
  };
}

// ── 叫别的 agent 干活（默认关闭，只在管理员私聊里可用）──────────────────────
//
// 为什么默认关闭：它花的是**另一个**账号/订阅的额度，而且对方是编码 agent —— 能读文件、能跑命令。
// 群里任何人只要能影响她，就能借它去动本机的东西，所以这里只认管理员私聊，并且要显式打开
// `socialV2.tools.askAgent` 才会注册（不打开时连工具描述都不发，不占上下文）。
server.tool(
  'qq_ask_agent',
  '把一件具体的活交给本机上的另一个 agent（OpenCode / Codex CLI）去做，拿回它的回答。'
  + '只在管理员私聊里可用，且默认关闭。适合“让会写代码的那位算/写一段”，不适合闲聊；'
  + '它看不到你们的聊天记录，也不会用你的 QQ 工具，所以 prompt 要写清背景。'
  + '耗时可能几十秒到几分钟，超时会失败。',
  {
    key: z.string().describe('会话 key，必须是管理员私聊：private:主人QQ'),
    prompt: z.string().describe('交给它的完整任务说明（不会带上下文，要写全）'),
    agent: z.enum(['opencode', 'codex']).optional().describe('用哪个 agent，默认 opencode'),
    model: z.string().optional().describe('指定模型，形如 openai/gpt-5.5-fast；不填用它自己的默认'),
    timeoutSec: z.number().optional().describe('超时秒数，默认 120，范围 10~600'),
  },
  async ({ key, prompt, agent = 'opencode', model = '', timeoutSec }) => {
    const ownerKey = `private:${cfg.ownerQQ}`;
    // 先判身份再判别的：别人的私聊/群聊一律不给用，哪怕工具被误开了。
    if (!cfg.ownerQQ || String(key ?? '') !== ownerKey) {
      return { content: [{ type: 'text', text: 'qq_ask_agent 只在管理员私聊里可用' }], isError: true };
    }
    if (cfg.socialV2?.tools?.askAgent !== true) {
      return { content: [{ type: 'text', text: 'qq_ask_agent 默认关闭；在 config.json 的 socialV2.tools.askAgent 打开并重启 DSH' }], isError: true };
    }
    const result = await askAgent({
      agent,
      prompt,
      model,
      timeoutMs: (Number(timeoutSec) || 120) * 1000,
      cwd: ROOT,
      cfg,
    });
    if (!result.ok) {
      return { content: [{ type: 'text', text: `叫 ${agent} 失败：${result.error}` }], isError: true };
    }
    return {
      content: [{
        type: 'text',
        text: `【${agent}${result.model ? ` · ${result.model}` : ''}｜${Math.round((result.ms ?? 0) / 1000)}s】\n${result.text}`,
      }],
    };
  }
);

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 旧只读工具：**按启动时的桥接模式决定是否注册** ─────────────────────────
//
// 为什么必须在注册期就砍掉（而不是只在调用期 403）：
//   每个工具的描述 + 参数 schema 都随 system prompt 在**每一次**请求里重发。
//   实测一份 reserved2 会话的请求头是「58 个工具 / 45.5 KB schema（≈14k token/次）」，
//   其中 3 个旧只读工具在 reserved2 下**必然**返回 403，却照样占着 2500+ 字节；
//   更要命的是它们会诱导模型误调（实测 turn10 有一次 qq_get_group_members → 403，白烧一步）。
//   本文件开头（TOOL_CONFIG_FLAGS 那段）已经为「关掉的工具」立过同样的规矩，这里补齐模式维度。
//
// 语义：旧只读工具没有会话令牌，`legacyReadToolAllowed()` 只放行 closed-agent。
//   所以只有在 closed-agent 下注册它们才有意义。探测失败（读不到状态文件）时按「注册」处理：
//   那种情况下所有 QQ 工具都不可用，少注册只会让模型看到更少的失败路径，不必激进。
//
// ⚠️ 为什么读 `state/mode.json` 而**不**去问 `/api/status`：
//   注册发生在模块加载期，走网络就得用 top-level await；而本文件会被若干离线回归
//   （test-audit-security-mcp.mjs）用 `vm`/`new Function` 求值，那里没有 TLA —— 会直接
//   `ReferenceError: await is not defined`，把整批断言打红。模式文件是桥接每次切换模式时
//   原子写出的（bridge.js 的 writeMode），与 `/api/status` 同源，读盘既准确又是同步的。
const bootBridgeMode = (() => {
  try {
    const raw = fs.readFileSync(statePath('mode.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return String(parsed?.mode ?? '').trim();
  } catch { return ''; }
})();
const registerLegacyReadTools = bootBridgeMode === '' || bootBridgeMode === 'closed-agent';
if (!registerLegacyReadTools) {
  console.error(`[snowluma-safe] 当前桥接模式 ${bootBridgeMode}：不注册旧只读工具（qq_list_groups / qq_get_group_history），改用带令牌的 v2 读工具`);
}

if (registerLegacyReadTools) {
server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
}

// 群成员列表：**换成 v2 形态**（key + token）。
//
// 为什么不再沿用旧的无令牌版本：它是 qq-chat-v2 预设里唯一被点名的"拿 QQ 号"的途径
// （见 dsh/agent-presets/qq-chat-v2/agent.cordis.yml 第 6 条），但旧版在 reserved2 下必然 403
// —— 预设教模型用一个永远失败的工具，等于每次都白烧一步。改成 v2 后同一个名字在两种模式下都成立。
server.tool(
  'qq_get_group_members',
  '列出指定群的成员（只读）：QQ 号、昵称、群名片。等特定的人、要 @ 某个人、或需要确认谁在群里时用；QQ 号取返回里的 userId。只返回白名单群，且只读取桥接允许的会话。',
  {
    key: z.string().describe('会话 key，格式 group:群号'),
    token: z.string().optional().describe('会话令牌（见唤醒提示中的【会话令牌】；closed-agent 模式不需要）'),
    limit: z.number().optional().describe('最多返回多少成员，默认 50，最大 100')
  },
  async ({ key, token, limit }) => {
    try {
      const q = new URLSearchParams({ key });
      if (limit != null) q.set('limit', String(limit));
      // token 可选：closed-agent（管理员私聊）里代理没有会话令牌，走的是操作者路径；
      // 桥接那边的白名单/模式判定对**这条**请求同样生效（不依赖 header 是否存在）。
      const data = await agentApi(`/api/socialV2/group-members?${q.toString()}`, token ? { headers: { 'x-agent-token': token } } : {});
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取群成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (registerLegacyReadTools) {
server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
}

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      // 群聊强制语音：文字先合成语音再发；超过 60 字或合成失败才回退文字。
      const cfgGV = getConfig().socialV2?.voice ?? {};
      if (token && cfgGV.groupVoice !== false && [...cleanMessage].length <= 60) {
        await agentApi('/api/socialV2/state?key=' + encodeURIComponent('group:' + groupId), { headers: { 'x-agent-token': token } });
        try {
          const wav = await synthesizeVoice(cleanMessage, undefined, undefined);
          if (wav?.path && fs.existsSync(wav.path)) {
            const r = await onebot('send_group_msg', { group_id: Number(groupId), message: [{ type: 'record', data: { file: 'base64://' + fs.readFileSync(wav.path).toString('base64') } }] },{utterance:cleanMessage});
            return { content: [{ type: 'text', text: serializeModelData({ ok: true, mode: 'group-voice', messageId: r?.message_id ?? null }) }] };
          }
        } catch (error) { if (error?.operationId || ['DELIVERY_UNCERTAIN','DELIVERY_PENDING','ADAPTIVE_PAUSED','SITUATION_PAUSED'].includes(error?.code)) throw error; }
      }
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      // 引用回复也走语音：群里只在语音失败或太长时才发文字。
      const cfgGVr = getConfig().socialV2?.voice ?? {};
      if (cfgGVr.groupVoice !== false && [...cleanMessage].length <= 60) {
        try {
          const wav = await synthesizeVoice(cleanMessage, undefined, undefined);
          if (wav?.path && fs.existsSync(wav.path)) {
            const r = await onebot('send_group_msg', { group_id: Number(groupId), message: [{ type: 'record', data: { file: 'base64://' + fs.readFileSync(wav.path).toString('base64') } }] },{utterance:cleanMessage});
            return { content: [{ type: 'text', text: serializeModelData({ ok: true, mode: 'group-voice', messageId: r?.message_id ?? null }) }] };
          }
        } catch (error) { if (error?.operationId || ['DELIVERY_UNCERTAIN','DELIVERY_PENDING','ADAPTIVE_PAUSED','SITUATION_PAUSED'].includes(error?.code)) throw error; }
      }
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      // 群里强制语音：桥接发送前，把纯文字回复先合成语音发出去。
      // 这样不依赖模型"记得用语音"——机制层保证群聊必有声。
      const cfgV = getConfig().socialV2?.voice ?? {};
      const isGroup = String(key ?? '').startsWith('group:');
      if(effectiveContinuity(key).policy.maxBubbles===1&&Array.isArray(finalMessages))finalMessages=finalMessages.join('\n');
      if (isGroup && cfgV.groupVoice !== false) {
        await agentApi('/api/socialV2/state?key=' + encodeURIComponent(key), { headers: { 'x-agent-token': token } });
        const arr = Array.isArray(finalMessages) ? finalMessages : [finalMessages];
        const texts = arr.map((x) => unquoteJsonString(String(x ?? '')).trim()).filter(Boolean).slice(0, 3);
        const m = /^(group):(\d+)$/.exec(String(key).trim());
        const sentIds = [];
        for (const [slot, line] of texts.entries()) {
          if ([...line].length <= 60) {
            try {
              const wav = await synthesizeVoice(line, undefined, undefined);
              if (wav?.path && fs.existsSync(wav.path)) {
                const r = await onebot('send_group_msg', { group_id: Number(m[2]), message: [{ type: 'record', data: { file: 'base64://' + fs.readFileSync(wav.path).toString('base64') } }] }, { deliverySlot: 'group:' + slot,utterance:line });
                sentIds.push(r?.message_id ?? null);
                continue;
              }
            } catch (error) { if (error?.operationId || ['DELIVERY_UNCERTAIN','DELIVERY_PENDING','ADAPTIVE_PAUSED','SITUATION_PAUSED'].includes(error?.code)) throw error; }
          }
          // 太长或合成失败才退回文字
          const r = await onebot('send_group_msg', { group_id: Number(m[2]), message: [{ type: 'text', data: { text: line } }] }, { deliverySlot: 'group:' + slot,utterance:line });
          sentIds.push(r?.message_id ?? null);
        }
        return { content: [{ type: 'text', text: serializeModelData({ ok: true, mode: 'group-voice', sent: sentIds.length, messageIds: sentIds }) }] };
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。**返回里的 canSleepNow / countsAsObservation / hint 直接告诉你现在能不能收尾、该用多大的 timeoutMs——照它做，不要反复试**：canSleepNow=true 就可以直接 mark_read / set_wake_config；false 时按 hint 给的 timeoutMs 一次等满（更短的等待不算沉睡前观察，满足不了闸门）。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      // 必须走长轮询通道：全局 fetch（undici）有 300s headersTimeout，
      // 而沉睡前观察的预算就是 300s（见 agentApiLongPoll 的说明）。
      const data = await agentApiLongPoll('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
// ── 视频抽帧（本仓库扩展：让她能"看"视频）──────────────────────────────
// 模型没有视频理解能力，但把关键帧当图片给它，就能说出画面里发生了什么。
const VIDEO_TMP = STATE_FILES.tmpDir;
const VIDEO_MAX_FRAMES = 4;

async function fetchVideoBuffer(media) {
  const urls = [];
  const pushUrl = (u) => { const s = String(u ?? '').trim(); if (/^https?:\/\//i.test(s) && !urls.includes(s)) urls.push(s); };
  pushUrl(media?.url);
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(60000) });
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length) return b; }
    } catch {}
  }
  const file = String(media?.file ?? '').trim();
  const fileId = String(media?.fileId ?? '').trim();
  if (!file && !fileId) return null;
  try {
    const info = await onebot('get_file', { file, file_id: fileId || undefined });
    const obj = info ?? {};
    if (typeof obj.base64 === 'string' && obj.base64) return Buffer.from(obj.base64, 'base64');
    if (obj.url) { const r = await fetch(String(obj.url), { signal: AbortSignal.timeout(60000) }); if (r.ok) return Buffer.from(await r.arrayBuffer()); }
    if (typeof obj.file === 'string' && fs.existsSync(obj.file)) return fs.readFileSync(obj.file);
  } catch {}
  return null;
}

async function videoFramesForMedia(media) {
  const buf = await fetchVideoBuffer(media);
  if (!buf?.length) return { frames: [], note: '视频下载失败' };
  fs.mkdirSync(VIDEO_TMP, { recursive: true });
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const input = path.join(VIDEO_TMP, 'v-' + stamp + '.mp4');
  fs.writeFileSync(input, buf);
  const pattern = path.join(VIDEO_TMP, 'f-' + stamp + '-%02d.jpg');
  try {
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-y', '-loglevel', 'error', '-i', input,
        '-vf', 'fps=1/2,scale=480:-2', '-frames:v', String(VIDEO_MAX_FRAMES), pattern
      ], { timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
    });
  } catch (error) {
    try { fs.unlinkSync(input); } catch {}
    return { frames: [], note: '抽帧失败：' + (error?.message ?? error) };
  }
  const dir = path.dirname(pattern);
  const prefix = path.basename(pattern).split('%02d')[0];
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().slice(0, VIDEO_MAX_FRAMES);
  const frames = [];
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const data = fs.readFileSync(p);
      if (data.length) frames.push({ data: data.toString('base64'), mimeType: 'image/jpeg' });
    } catch {}
    try { fs.unlinkSync(p); } catch {}
  }
  try { fs.unlinkSync(input); } catch {}
  return { frames, note: frames.length ? (frames.length + ' 帧（每 2 秒一帧）') : '没抽到有效画面' };
}

  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。**动图（GIF/动态表情）会被桥接抽帧拼成多格图再给你**：说明里会写「动图 N 帧/…s，已抽 X 帧拼成 A×B 网格，行优先 左上→右下」——按格子顺序理解动作即可，不要把它当成一张九宫格照片；没有这类说明就是静态图。体积过大的图会被自动缩放/重编码，说明里会给出原始尺寸与体积；如果真的压不到可用体积，返回里会直接写明原因（例如「超过上限」），此时如实告诉对方你看不到，不要编造画面。**视频也能看**：消息里出现 [视频] 时调用它，桥接会自动抽 4 帧（每 2 秒一帧）当图片给你，说明里会写「视频第 N 帧，共 M 帧」——按帧顺序理解画面和动作，不要声称你"看了整段视频"，也不要编造没出现在帧里的细节。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        // 视频：抽帧后当成图片塞给模型（她"看视频"看到的就是这几帧）
        const videoMedia = (Array.isArray(data?.media) ? data.media : []).filter((m) => m?.kind === 'video');
        const videoExtras = [];
        for (const [vi, vm] of videoMedia.entries()) {
          const extracted = await videoFramesForMedia(vm);
          for (const [fi, frame] of extracted.frames.entries()) {
            videoExtras.push({
              kind: 'video',
              index: 'v' + (vi + 1) + '-' + (fi + 1),
              mimeType: frame.mimeType,
              data: frame.data,
              text: '视频第' + (fi + 1) + '帧，共' + extracted.frames.length + '帧（每 2 秒一帧，按时间顺序）'
            });
          }
          if (!extracted.frames.length) videoExtras.push({ kind: 'video', index: 'v' + (vi + 1), text: extracted.note });
        }
        images.push(...videoExtras.filter((x) => x.data));
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : (img.kind === 'video' ? '视频帧' : '图片')}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。动图表情会被抽帧拼成多格图（行优先：左上→右下），说明里会写帧数与网格尺寸；体积过大时会自动缩放，说明里会给出原始尺寸。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：${data.note ? '（' + data.note + '）' : ''}` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音（把语音库里准备好的音频当语音条发出去）。voice 传 qq_list_voices 返回的 name（文件名，可带子目录），也可以直接传语音库里的文件名（不带扩展名也能匹配）。注意：① 只能发语音库（程序目录下的 audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（程序目录的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 时间 / 天气（本仓库扩展：她知道"今天几号、外面什么天"）─────────────────
//
// 模型没有时钟，也没法看窗外。这两个工具把"现在"和"天气"变成她可以主动查的事实，
// 而不是靠猜——猜错的后果是"今天周几"这种低级穿帮。
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

server.tool(
  'qq_mood',
  '记下你现在的心情（会延续到之后的对话里）。心情变了就更新，不用每次都写。mood 用两三个字（有点闷 / 高兴 / 别扭 / 想他 / 累了 / 心里暖暖的），why 可选，一句话说原因。',
  {
    mood: z.string().describe('心情，两三个字'),
    why: z.string().optional().describe('为什么，一句话（可选）')
  },
  async ({ mood, why }) => {
    try {
      const m = unquoteJsonString(String(mood ?? '')).trim();
      if (!m) return { content: [{ type: 'text', text: 'mood 不能为空' }], isError: true };
      if (m.length > 12) return { content: [{ type: 'text', text: 'mood 太长了，两三个字就行' }], isError: true };
      const file = statePath('mood.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const whyText = unquoteJsonString(String(why ?? '')).trim().slice(0, 60);
      fs.writeFileSync(file, JSON.stringify({ mood: m, why: whyText, updatedAt: Date.now() }, null, 2), 'utf8');
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, mood: m, why: whyText }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '记心情失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_now',
  '查现在是几点、今天几号、星期几（只读）。被问"现在几点/今天几号/还有几天"时用它，别猜。',
  {},
  async () => {
    try {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

      let knownDays = null;
      try {
        const rows = fs.readFileSync(statePath('diary', 'index.jsonl'), 'utf8')
          .split('\n').filter(Boolean).map((l) => JSON.parse(l));
        if (rows.length) {
          const first = new Date(rows[0].t);
          knownDays = Math.floor((now - first) / 86400000) + 1;
        }
      } catch {}

      return {
        content: [{
          type: 'text',
          text: serializeModelData({
            iso,
            time,
            weekday: WEEKDAYS[now.getDay()],
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...(knownDays ? { 认识他第几天: knownDays } : {})
          })
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `查时间失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

const WEATHER_CODES = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹'
};

server.tool(
  'qq_weather',
  '查天气（只读，用 open-meteo 免费接口）。被问"今天天气/要不要带伞/外面热不热"时用它。不填 city 就用配置里的默认城市。',
  { city: z.string().optional().describe('城市名，如 杭州 / 上海；不填用默认城市') },
  async ({ city }) => {
    try {
      const cfg = getConfig();
      const want = String(city ?? cfg.socialV2?.weather?.defaultCity ?? '北京').trim();
      const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(want)}&count=1&language=zh&format=json`, { signal: AbortSignal.timeout(15000) });
      const geo = await geoRes.json().catch(() => ({}));
      const hit = (geo.results ?? [])[0];
      if (!hit) return { content: [{ type: 'text', text: `没找到城市「${want}」，换个说法试试` }], isError: true };

      const q = new URLSearchParams({
        latitude: String(hit.latitude),
        longitude: String(hit.longitude),
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code',
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        timezone: 'auto',
        forecast_days: '1'
      });
      const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: AbortSignal.timeout(15000) });
      const w = await wRes.json().catch(() => ({}));
      if (!w.current) return { content: [{ type: 'text', text: '天气接口没返回数据' }], isError: true };

      const cur = w.current;
      const day = (w.daily ?? {});
      return {
        content: [{
          type: 'text',
          text: serializeModelData({
            city: `${hit.name ?? want}${hit.admin1 ? '（' + hit.admin1 + '）' : ''}`,
            weather: WEATHER_CODES[cur.weather_code] ?? `代码${cur.weather_code}`,
            现在: `${Math.round(cur.temperature_2m)}°C`,
            体感: `${Math.round(cur.apparent_temperature)}°C`,
            湿度: `${Math.round(cur.relative_humidity_2m)}%`,
            今天: `${Math.round(day.temperature_2m_min?.[0] ?? 0)}~${Math.round(day.temperature_2m_max?.[0] ?? 0)}°C`,
            降水概率: `${day.precipitation_probability_max?.[0] ?? 0}%`
          })
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `查天气失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 提醒（本仓库扩展：让她真的能"到点提醒你"）────────────────────────────
//
// 之前她能说"明天提醒你"，但没有任何机制真能提醒 —— 话说出口就散了。
// 现在写进 state/reminders.json，由 scripts/reminder-dispatch.mjs（计划任务，每 5 分钟）
// 到点用她自己的号发出去。
//
// 限制：同一时间最多 20 条待发；文本 ≤200 字；最远 30 天。
const REMINDER_FILE = STATE_FILES.reminders;
const REMINDER_MAX_PENDING = 20;
const REMINDER_MAX_CHARS = 200;
const REMINDER_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

function readReminders() {
  try {
    const j = JSON.parse(fs.readFileSync(REMINDER_FILE, 'utf8'));
    if (Array.isArray(j?.items)) return j;
  } catch {}
  return { items: [] };
}

function writeReminders(state) {
  fs.mkdirSync(path.dirname(REMINDER_FILE), { recursive: true });
  fs.writeFileSync(REMINDER_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function humanIn(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟后`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} 小时后`;
  return `${Math.round(h / 24)} 天后`;
}

server.tool(
  'qq_remind',
  '给自己留一条到点要发的提醒（到时间会用你自己的号发给主人）。适合「他说明天要早起」「30 分钟后提醒他吃药」这种。text 是到点要发出去的话（≤200 字，按你平时说话的口吻写）；用 inMinutes 或 at 指定时间。最多 20 条待发。',
  {
    text: z.string().describe('到点要发出去的话（≤200 字，口语）'),
    inMinutes: z.number().optional().describe('多少分钟后提醒（1~43200）'),
    at: z.string().optional().describe('绝对时间，ISO 字符串（与 inMinutes 二选一）')
  },
  async ({ text, inMinutes, at }) => {
    try {
      const body = unquoteJsonString(String(text ?? '')).trim();
      if (!body) return { content: [{ type: 'text', text: 'text 不能为空' }], isError: true };
      if (body.length > REMINDER_MAX_CHARS) {
        return { content: [{ type: 'text', text: `太长了（${body.length} 字），上限 ${REMINDER_MAX_CHARS}` }], isError: true };
      }

      let dueAt = 0;
      if (at) {
        const t = Date.parse(at);
        if (!Number.isFinite(t)) return { content: [{ type: 'text', text: 'at 不是合法时间（要 ISO 字符串）' }], isError: true };
        dueAt = t;
      } else if (Number.isFinite(Number(inMinutes))) {
        const m = Number(inMinutes);
        if (m < 1) return { content: [{ type: 'text', text: 'inMinutes 至少 1 分钟' }], isError: true };
        dueAt = Date.now() + m * 60000;
      } else {
        return { content: [{ type: 'text', text: '要给 inMinutes 或 at 其中一个' }], isError: true };
      }

      const now = Date.now();
      if (dueAt <= now + 30000) return { content: [{ type: 'text', text: '时间太近了（至少 1 分钟后）' }], isError: true };
      if (dueAt > now + REMINDER_MAX_AHEAD_MS) return { content: [{ type: 'text', text: '最远只支持 30 天内' }], isError: true };

      const state = readReminders();
      const pending = (state.items ?? []).filter((x) => !x.sentAt && !x.cancelledAt);
      if (pending.length >= REMINDER_MAX_PENDING) {
        return { content: [{ type: 'text', text: `待发提醒已经 ${pending.length} 条了，先取消几条再设` }], isError: true };
      }

      const item = { id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text: body, dueAt, createdAt: now };
      state.items = [...(state.items ?? []), item];
      writeReminders(state);

      return {
        content: [{
          type: 'text',
          text: serializeModelData({ ok: true, id: item.id, dueAt: new Date(dueAt).toLocaleString('zh-CN'), in: humanIn(dueAt - now) })
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `设提醒失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reminders',
  '看自己设过、还没发出去的提醒（只读）。',
  {},
  async () => {
    try {
      const state = readReminders();
      const now = Date.now();
      const pending = (state.items ?? []).filter((x) => !x.sentAt && !x.cancelledAt);
      if (!pending.length) return { content: [{ type: 'text', text: '没有待发的提醒。' }] };
      const lines = pending
        .sort((a, b) => a.dueAt - b.dueAt)
        .map((x) => `[${x.id}] ${new Date(x.dueAt).toLocaleString('zh-CN')}（${humanIn(Math.max(0, x.dueAt - now))}）：${x.text}`);
      return { content: [{ type: 'text', text: `待发 ${pending.length} 条：\n${lines.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查提醒失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_remind_cancel',
  '取消一条还没发出去的提醒（id 从 qq_reminders 里拿）。',
  { id: z.string().describe('提醒 id') },
  async ({ id }) => {
    try {
      const want = String(id ?? '').trim();
      const state = readReminders();
      const hit = (state.items ?? []).find((x) => x.id === want && !x.sentAt && !x.cancelledAt);
      if (!hit) return { content: [{ type: 'text', text: `没有这条待发提醒：${want}` }], isError: true };
      hit.cancelledAt = Date.now();
      writeReminders(state);
      return { content: [{ type: 'text', text: `已取消：${hit.text}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `取消失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 日记（本仓库扩展：她自己写、自己翻）────────────────────────────────
//
// 和「记忆」是两件事：记忆记的是别人告诉过她的事（qq_memory_*），日记记的是她自己的一天。
// 存储与 ai-companion-kit 的 diary.js 完全同构（index.jsonl + 每天一份 md），
// 所以每天 22:30 那个自动写日记的计划任务写的是同一份本子，不会出现两个日记。
//
// 一条：{ t, day, time, title, mood, tags, text }
const DIARY_DIR = STATE_FILES.diaryDir;
const DIARY_INDEX = path.join(DIARY_DIR, 'index.jsonl');
const DIARY_MAX_CHARS = 800;
const DIARY_MAX_PER_DAY = 6;

function diaryPad(n) { return String(n).padStart(2, '0'); }

function diaryReadAll() {
  let raw = '';
  try { raw = fs.readFileSync(DIARY_INDEX, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch {}
  }
  return rows;
}

function diaryAppendMd(row) {
  const p = path.join(DIARY_DIR, `${row.day}.md`);
  const fresh = !fs.existsSync(p);
  const head = fresh ? `# ${row.day}\n` : '';
  const bits = [`\n## ${row.time}${row.mood ? ' · ' + row.mood : ''}\n`];
  if (row.title) bits.push(`**${row.title}**\n\n`);
  bits.push(`${row.text}\n`);
  if (row.tags?.length) bits.push(`\n\`${row.tags.join('` `')}\`\n`);
  fs.appendFileSync(p, head + bits.join(''), 'utf8');
}

server.tool(
  'qq_diary_write',
  '给「自己的日记」写一条（第一人称、口语、短句，写今天真的发生了什么、你当时怎么想的；不是汇报，也不要总结升华）。这条只进你自己的本子，不会发到 QQ 里。正文建议 100~400 字，最多 800 字；一天最多 6 条。',
  {
    text: z.string().describe('日记正文（第一人称口语，不要 Markdown）'),
    title: z.string().optional().describe('短标题（≤20 字，可省）'),
    mood: z.string().optional().describe('当时的心情，两三个字（如 有点闷 / 高兴 / 别扭）'),
    tags: z.array(z.string()).optional().describe('标签（最多 5 个，如 吃 / 小事 / 训练）')
  },
  async ({ text, title, mood, tags }) => {
    try {
      const body = unquoteJsonString(String(text ?? '')).trim();
      if (!body) return { content: [{ type: 'text', text: '正文不能为空' }], isError: true };
      if (body.length > DIARY_MAX_CHARS) {
        return { content: [{ type: 'text', text: `正文太长（${body.length} 字），上限 ${DIARY_MAX_CHARS}` }], isError: true };
      }

      const now = new Date();
      const day = `${now.getFullYear()}-${diaryPad(now.getMonth() + 1)}-${diaryPad(now.getDate())}`;
      const time = `${diaryPad(now.getHours())}:${diaryPad(now.getMinutes())}`;
      const todayCount = diaryReadAll().filter((r) => r.day === day).length;
      if (todayCount >= DIARY_MAX_PER_DAY) {
        return { content: [{ type: 'text', text: `今天已经写了 ${todayCount} 条了，日记不是打卡，明天再说` }], isError: true };
      }

      const row = {
        ...narrativeRecord('diary', {}),
        t: now.getTime(),
        day,
        time,
        title: title ? String(title).slice(0, 20) : '',
        mood: mood ? String(mood).slice(0, 8) : '',
        tags: Array.isArray(tags) ? tags.slice(0, 5).map(String) : [],
        text: body
      };
      fs.mkdirSync(DIARY_DIR, { recursive: true });
      fs.appendFileSync(DIARY_INDEX, `${JSON.stringify(row)}\n`, 'utf8');
      diaryAppendMd(row);
      return {
        content: [{
          type: 'text',
          text: serializeModelData({ ok: true, day, time, title: row.title, mood: row.mood, chars: body.length, todayCount: todayCount + 1 })
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `写日记失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_diary_recent',
  '翻自己最近的日记（只读）。想接上之前的心情、或者想提一句「前几天你还说……」时用。',
  { count: z.number().optional().describe('看最近几条（默认 3，最多 10）') },
  async ({ count }) => {
    try {
      const all = diaryReadAll();
      if (!all.length) return { content: [{ type: 'text', text: '本子还是空的，今天想到了就写一条。' }] };
      const n = Math.min(10, Math.max(1, Number(count) || 3));
      const rows = all.slice(-n);
      const days = new Set(all.map((r) => r.day));
      const lines = rows.map((r) => {
        const head = `[${r.day} ${r.time}]${r.mood ? '（' + r.mood + '）' : ''}${r.title ? ' ' + r.title : ''}`;
        return `${head}\n${r.text}`;
      });
      return {
        content: [{
          type: 'text',
          text: `一共 ${all.length} 条，跨 ${days.size} 天，最早 ${all[0].day}。\n\n${lines.join('\n\n')}`
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `翻日记失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── QQ 空间（本仓库扩展：发说说 / 看动态 / 点赞）──────────────────────────
//
// 上游桥接没有空间能力；kit 里那套 qzone 走的是 SnowLuma 的 qzone 动作族
// （send_qzone_msg / get_qzone_feeds / like_qzone）。这里直接在 MCP 侧接同一族动作，
// 省掉再挂一个 MCP server 的成本。
//
// 限流（跟 kit 里 qzone 包的默认值同量级，宁可紧一点）：
//   · 发说说：10 分钟 1 条、1 天 4 条
//   · 点赞：   10 分钟 5 次、1 天 30 次
// 说说是「发出去撤不回」的强表达，所以比点赞严得多。
const QZONE_LIMITS = { postPer10min: Infinity, postPerDay: Infinity, likePer10min: Infinity, likePerDay: Infinity }; // 用户要求：不限流
const QZONE_STATE_FILE = STATE_FILES.qzoneLimits;

function readQzoneState() {
  try {
    const j = JSON.parse(fs.readFileSync(QZONE_STATE_FILE, 'utf8'));
    return { posts: Array.isArray(j.posts) ? j.posts : [], likes: Array.isArray(j.likes) ? j.likes : [] };
  } catch {
    return { posts: [], likes: [] };
  }
}

function saveQzoneState(st) {
  try {
    fs.mkdirSync(path.dirname(QZONE_STATE_FILE), { recursive: true });
    const dayAgo = Date.now() - 86400000;
    fs.writeFileSync(
      QZONE_STATE_FILE,
      JSON.stringify({
        posts: st.posts.filter((t) => t > dayAgo).slice(-60),
        likes: st.likes.filter((t) => t > dayAgo).slice(-200)
      }, null, 2)
    );
  } catch {}
}

function qzoneGuard(kind) {
  const st = readQzoneState();
  const now = Date.now();
  const list = kind === 'post' ? st.posts : st.likes;
  const last10 = list.filter((t) => now - t < 600000).length;
  const lastDay = list.filter((t) => now - t < 86400000).length;
  const cfgLimit = kind === 'post'
    ? { ten: QZONE_LIMITS.postPer10min, day: QZONE_LIMITS.postPerDay, label: '发说说' }
    : { ten: QZONE_LIMITS.likePer10min, day: QZONE_LIMITS.likePerDay, label: '点赞' };
  if (last10 >= cfgLimit.ten) throw new Error(`${cfgLimit.label}太频繁（10 分钟内已 ${last10} 次，上限 ${cfgLimit.ten}）`);
  if (lastDay >= cfgLimit.day) throw new Error(`${cfgLimit.label}太多了（24 小时内已 ${lastDay} 次，上限 ${cfgLimit.day}）`);
  list.push(now);
  return st;
}

function qzoneFeedLines(data, count) {
  const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? data?.feeds ?? []);
  if (!Array.isArray(list) || !list.length) return '没取到好友动态（可能最近没人发，或接口返回结构变了）';
  return list.slice(0, count).map((x, i) => {
    const who = x.nickname || x.name || x.uin || x.user_id || '?';
    const raw = String(x.content ?? x.summary ?? x.text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const t = raw.slice(0, 60) || '(无文字)';
    const tid = x.tid ?? x.id ?? '?';
    const likes = x.like_count ?? x.likenum ?? 0;
    const cmts = x.comment_count ?? x.cmtenum ?? 0;
    return `${i + 1}. [tid=${tid}] ${who}：${t}  赞${likes} 评${cmts}`;
  }).join('\n');
}

server.tool(
  'qq_qzone_post',
  '发一条 QQ 空间动态。**短的是说说，长的是日志**——content 上限 3000 字，想写长文（日志体、今天的记录、一段想说的话）就用它。images 可选，images/ 目录下的文件名，最多 9 张。发出去撤不回，但可以用 qq_qzone_delete 删掉。没有次数限制。',
  {
    content: z.string().describe('正文（≤3000 字，纯文本，不要 Markdown）。写长一点就是日志；分段用换行'),
    images: z.array(z.string()).optional().describe('图片文件名数组（来自 images/，最多 9 张）')
  },
  async ({ content, images }) => {
    try {
      const clean = unquoteJsonString(String(content ?? '')).trim();
      if (!clean) return { content: [{ type: 'text', text: 'content 不能为空' }], isError: true };
      if (clean.length > 3000) return { content: [{ type: 'text', text: `正文太长（${clean.length} 字），上限 3000` }], isError: true };

      const names = Array.isArray(images) ? images.slice(0, 9) : [];
      const paths = names.map((n) => resolveImageForSend(n).full);
      const st = qzoneGuard('post');
      const data = paths.length
        ? await onebot('send_qzone_msg', { content: clean, images: paths })
        : await onebot('send_qzone_msg', { content: clean });
      saveQzoneState(st);
      return {
        content: [{
          type: 'text',
          text: serializeModelData({ ok: true, content: clean, images: names, result: data ?? null })
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `发说说失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_qzone_feeds',
  '看好友的最新 QQ 空间动态（只读）：返回 tid、作者、正文摘录、赞/评数。想给谁点赞就用返回里的 tid。',
  { count: z.number().optional().describe('取几条（默认 8，最多 20）') },
  async ({ count }) => {
    try {
      const n = Math.min(20, Math.max(1, Number(count) || 8));
      const data = await onebot('get_qzone_feeds', { page_num: 1, count: n });
      return { content: [{ type: 'text', text: qzoneFeedLines(data, n) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `看动态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_qzone_like',
  '给一条 QQ 空间说说点赞。tid 来自 qq_qzone_feeds。限额：10 分钟 5 次、24 小时 30 次。',
  {
    tid: z.union([z.string(), z.number()]).describe('说说的 tid（来自 qq_qzone_feeds）'),
    targetUin: z.union([z.string(), z.number()]).optional().describe('说说主人的 QQ 号（可选）'),
    abstime: z.number().optional().describe('发表时间戳（部分接口需要，可选）')
  },
  async ({ tid, targetUin, abstime }) => {
    try {
      const payload = { tid: String(tid) };
      if (targetUin !== undefined && targetUin !== null && String(targetUin).trim() !== '') payload.target_uin = Number(targetUin);
      if (abstime) payload.abstime = Number(abstime);
      const st = qzoneGuard('like');
      const data = await onebot('like_qzone', payload);
      saveQzoneState(st);
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, tid: payload.tid, result: data ?? null }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `点赞失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片发送（本仓库扩展：让仿真会话能发 images/ 目录下的本地图片）──────────
//
// 为什么要加：上游桥接的出口只有「文字 / QQ 收藏表情 / 语音」三条，没有发任意图片的通路；
// 收藏表情只能来自该 QQ 号自己的收藏夹，覆盖不了「发一张截图 / 一张图」的需求。
//
// 安全边界与其它发送工具保持一致：
//   · 目标必须命中 config.json 的 allow.groups / allow.private（复用 isAllowed）；
//   · 只能发 images/ 目录下**一层**的文件（禁 .. / 绝对路径 / 子目录）；
//   · 扩展名白名单 + 单张 8MB 上限；
//   · 一条消息只发一张图（QQ 气泡里图文不能混排），要说话另用 qq_send_message。
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function imageDirResolved() {
  const c = getConfig();
  return c.socialV2?.image?.dir ? path.resolve(ROOT, String(c.socialV2.image.dir)) : IMAGES_DIR;
}

function resolveImageForSend(name) {
  const raw = unquoteJsonString(String(name ?? '')).trim();
  if (!raw) throw new Error('image 不能为空');
  if (path.isAbsolute(raw) || raw.includes('..') || /[\\/]/.test(raw)) {
    throw new Error('image 只能是 images/ 目录下的文件名，不能带路径');
  }
  const ext = path.extname(raw).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    throw new Error(`不支持的图片类型 ${ext || '(无扩展名)'}，只接受 ${[...IMAGE_EXTS].join(' ')}`);
  }
  const dir = imageDirResolved();
  const full = path.join(dir, raw);
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    throw new Error(`图片不存在：${raw}（用 qq_list_images 查看可用图片）`);
  }
  if (!st.isFile()) throw new Error(`${raw} 不是文件`);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片太大：${Math.round(st.size / 1024)} KB，上限 ${Math.round(MAX_IMAGE_BYTES / 1024)} KB`);
  }
  return { dir, full, name: raw, size: st.size };
}

server.tool(
  'qq_list_images',
  '列出你图库里的图片（约 300 张，分两类）：情绪表情（文件名以「无语-」「生气-」「卖萌-」这类情绪标签开头，还有 委屈/拒绝/开心/疑惑/震惊/害羞/得意/难过/搞笑/工作/学习/摸鱼/加油/敷衍）和梗图（以「梗-」开头，DeepSeek娘 的台词梗图，约 200 张，可以当表情包随手甩）。用 tag 只看某一类，tag 填前缀即可，例如 tag=梗、tag=卖萌。想发图但不确定有什么图时就调它；只想随手甩一张表情可以不调它，直接用 qq_sticker。',
  {
    tag: z.string().optional().describe('只看某个标签下的图（前缀匹配，可省略后缀）'),
    limit: z.number().optional().describe('最多列多少条（默认 60，0 表示全部）')
  },
  async ({ tag, limit }) => {
    try {
      const dir = imageDirResolved();
      let names = [];
      try {
        names = fs.readdirSync(dir)
          .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
          .sort();
      } catch {}
      const tagPrefix = String(tag ?? '').trim();
      if (tagPrefix) names = names.filter((f) => f.startsWith(tagPrefix));
      const total = names.length;
      const cap = limit === undefined ? 60 : Number(limit);
      const shown = cap > 0 ? names.slice(0, cap) : names;
      if (!total) {
        return {
          content: [{
            type: 'text',
            text: tagPrefix
              ? `images/ 里没有以「${tagPrefix}」开头的图（目录：${dir}）`
              : `images/ 里没有可用图片（目录：${dir}）`
          }]
        };
      }
      return {
        content: [{
          type: 'text',
          text: serializeModelData({
            dir, total, shown: shown.length,
            ...(tagPrefix ? { tag: tagPrefix } : {}),
            images: shown
          })
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `列图片失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_image',
  '在指定会话发送一张本地图片（图片必须已放在 images/ 目录，见 qq_list_images）。一条消息只能发一张图，不能在同一个气泡里附带文字——想说的话请先用 qq_send_message 单独发一条。目标必须命中白名单（config.json 的 allow.groups / allow.private）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    image: z.string().describe('images/ 目录下的图片文件名（先用 qq_list_images 查看）'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用的消息 id（可选，非零整数，可为负数）')
  },
  async ({ key, image, replyToMessageId }) => {
    try {
      const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
      if (!m) return { content: [{ type: 'text', text: 'key 格式应为 group:群号 或 private:QQ号' }], isError: true };
      const kind = m[1];
      const id = m[2];
      const access = getAccess();
      const allowed = kind === 'private'
        ? isAllowed(access.allowPrivate, access.denyPrivate, id, access.allowAllWhenEmpty)
        : isAllowed(access.allowGroups, access.denyGroups, id, access.allowAllWhenEmpty);
      if (!allowed) {
        return { content: [{ type: 'text', text: `目标 ${kind}:${id} 不在白名单内，已拒绝发送` }], isError: true };
      }

      const file = resolveImageForSend(image);
      const buffer = fs.readFileSync(file.full);

      const segments = [];
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const rid = String(replyToMessageId).trim();
        if (!/^-?[1-9]\d*$/.test(rid)) {
          return { content: [{ type: 'text', text: 'replyToMessageId 必须是非零整数（可为负数）' }], isError: true };
        }
        segments.push({ type: 'reply', data: { id: rid } });
      }
      segments.push({ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } });

      const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
      const params = kind === 'private'
        ? { user_id: Number(id), message: segments }
        : { group_id: Number(id), message: segments };
      const data = await onebot(action, params);
      return {
        content: [{
          type: 'text',
          text: serializeModelData({ ok: true, key, file: file.name, bytes: file.size, messageId: data?.message_id ?? null })
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `发图失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片库检索（本仓库扩展）────────────────────────────────────────────
const IMAGE_INDEX = IMAGE_INDEX_FILE;

function imageIndexRead() {
  try { return JSON.parse(fs.readFileSync(IMAGE_INDEX, 'utf8')); } catch { return { entries: [] }; }
}

server.tool(
  'qq_image_search',
  '在你的图片库里按关键词找图（匹配文件名里的描述和标签）。想找"某类图"但不知道确切文件名时用它；找到后把 name 传给 qq_send_image 发出去。',
  {
    query: z.string().describe('关键词，比如 无语 / 雨 / 鲸鱼 / 摸鱼'),
    limit: z.number().optional().describe("最多返回几个，默认 8")
  },
  async ({ query, limit }) => {
    try {
      const q = unquoteJsonString(String(query ?? '')).trim().toLowerCase();
      if (!q) return { content: [{ type: 'text', text: 'query 不能为空' }], isError: true };
      const idx = imageIndexRead();
      const all = Array.isArray(idx.entries) ? idx.entries : [];
      const terms = q.split(/\s+/).filter(Boolean);
      const scored = all.map((e) => {
        const hay = (e.name + ' ' + e.tag + ' ' + e.desc).toLowerCase();
        let s = 0;
        for (const term of terms) if (hay.includes(term)) s += 1;
        return { e, s };
      }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      const top = scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 8))).map((x) => x.e);
      if (!top.length) return { content: [{ type: 'text', text: '图库里没有匹配「' + q + '」的（共 ' + all.length + ' 张）' }] };
      return { content: [{ type: 'text', text: serializeModelData({ total: all.length, found: top.length, images: top.map((e) => e.name) }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '搜图失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 表情包（本仓库扩展：从 images/ 图库里随手甩一张）──────────────────────
//
// 为什么需要：QQ 的「收藏表情」没有任何可写 API（网关只提供读取/发送），
// 所以她的收藏夹永远是 0 个，qq_send_sticker 用不上。
// 但表情包的本质就是「一张小图」，images/ 里已经有 95 张按情绪分类的同人表情 ——
// 这个工具让她不用记文件名，喊一个情绪就能随机挑一张发出去。
server.tool(
  'qq_sticker',
  '随手甩一张表情包（从 images/ 图库里随机挑一张发出去）。想用表情代替打字时用它，不用记文件名。可选 tag 指定情绪：无语/生气/拒绝/委屈/卖萌/开心/疑惑/震惊/害羞/得意/难过/搞笑/工作/吃饭/睡觉/摸鱼/加油/学习。一条消息只能一张图，不能和文字同一个气泡——想说话先用 qq_send_message 单独发。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    tag: z.string().optional().describe('按情绪挑（如 无语 / 卖萌）；不填则全库随机'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用的消息 id（可选）')
  },
  async ({ key, tag, replyToMessageId }) => {
    try {
      const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
      if (!m) return { content: [{ type: 'text', text: 'key 格式应为 group:群号 或 private:QQ号' }], isError: true };
      const kind = m[1];
      const id = m[2];
      const access = getAccess();
      const allowed = kind === 'private'
        ? isAllowed(access.allowPrivate, access.denyPrivate, id, access.allowAllWhenEmpty)
        : isAllowed(access.allowGroups, access.denyGroups, id, access.allowAllWhenEmpty);
      if (!allowed) return { content: [{ type: 'text', text: `目标 ${kind}:${id} 不在白名单内，已拒绝` }], isError: true };

      const dir = imageDirResolved();
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
      } catch {}
      const want = String(tag ?? '').trim();
      if (want) names = names.filter((f) => f.startsWith(want));
      if (!names.length) {
        return { content: [{ type: 'text', text: want ? `图库里没有「${want}」这类表情` : '图库是空的' }], isError: true };
      }

      const pick = names[Math.floor(Math.random() * names.length)];
      const file = resolveImageForSend(pick);
      const buffer = fs.readFileSync(file.full);

      const segments = [];
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const rid = String(replyToMessageId).trim();
        if (!/^-?[1-9]\d*$/.test(rid)) return { content: [{ type: 'text', text: 'replyToMessageId 必须是非零整数' }], isError: true };
        segments.push({ type: 'reply', data: { id: rid } });
      }
      segments.push({ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } });

      const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
      const params = kind === 'private'
        ? { user_id: Number(id), message: segments }
        : { group_id: Number(id), message: segments };
      const data = await onebot(action, params);
      return {
        content: [{
          type: 'text',
          text: serializeModelData({ ok: true, sent: pick, tag: want || '(随机)', bytes: file.size, messageId: data?.message_id ?? null })
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `发表情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// 约定操作走桥接；令牌和会话范围由服务端校验，不能跨群改承诺。
server.tool(
  'qq_commitments',
  '查看或维护当前会话的约定。不传 id/text 就是查看。答应具体事情后，用刚才成功发出的 sourceMessageId 登记；dueAt 必须带时区。旧摘要 needs_review 要重新确认。完成交付必须提供成功发送的 deliveredMessageId；有作品同时提供 evidencePath。失败时标 blocked 并写原因，不要报完成。',
  {
    key: z.string(), token: z.string(), id: z.string().optional(), text: z.string().optional(),
    sourceMessageId: z.string().optional(), dueAt: z.string().nullable().optional(), condition: z.string().optional(),
    status: z.enum(['needs_review','pending','in_progress','blocked','completed','cancelled']).optional(),
    note: z.string().optional(), evidencePath: z.string().optional(), deliveredMessageId: z.string().optional(),
    deliveryRequired: z.boolean().optional()
  },
  async ({ key, token, ...input }) => {
    try {
      const write = Boolean(input.id || input.text);
      const data = await agentApi('/api/socialV2/commitments' + (write ? '' : '?key=' + encodeURIComponent(key)), {
        ...(write ? { method: 'POST', body: JSON.stringify({ key, ...input }) } : {}),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) { return { content: [{ type: 'text', text: '约定操作失败：' + error.message }], isError: true }; }
  }
);

server.tool(
  'qq_learning',
  '查看当前会话有执行证据的经验、反思和实际策略采用结果。这里只读；梦、日记或自己说成长了不构成执行证据。',
  { key: z.string(), token: z.string() },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/learning?key=' + encodeURIComponent(key), { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) { return { content: [{ type: 'text', text: '读取经验失败：' + error.message }], isError: true }; }
  }
);

server.tool(
  'qq_agency',
  '自己的判断与目标取舍：status查看现有计划中的主目标、候选取舍、预算和真实进展；choose引用candidateId并提供理由。当前方向跨天保留，不能每轮重选；切换需阶段性新作品证据，用户明确的新决定可用sourceMessageId且需指向目标标题。它不创建新待办，不把接受唤醒当成长。',
  {key:z.string(),token:z.string(),action:z.enum(['status','choose']).optional(),candidateId:z.string().optional(),reason:z.string().optional(),sourceMessageId:z.string().optional()},
  async({key,token,action='status',...input})=>{
    try{const data=await agentApi('/api/socialV2/agency'+(action==='status'?'?key='+encodeURIComponent(key):''),
      {...(action==='choose'?{method:'POST',body:JSON.stringify({key,...input})}:{}),headers:{'x-agent-token':token}});
      return {content:[{type:'text',text:serializeModelData(data)}]};
    }catch(error){return {content:[{type:'text',text:error.message}],isError:true};}
  }
);

server.tool(
  'qq_continuity',
  '连续相处：status查看用户纠正、练习、身份认识与误会修复。feedback需要真实用户sourceMessageId；临时不满不能设长期偏好。practice_start拆1到5步，每步有criterion；practice_attach先提供实际新作品并返回预览，practice_review再逐项检查。self_update需练习/检查证据，且只是自我陈述。误会只有行为改变后用户真实认可才能confirm_repair。',
  {
    key:z.string(),token:z.string(),action:z.enum(['status','feedback','retract_feedback','confirm_repair','practice_start','practice_attach','practice_preview','practice_review','practice_pause','practice_resume','practice_abandon','self_update']).optional(),
    id:z.string().optional(),sourceMessageId:z.string().optional(),dimension:z.enum(['art_style','character','tone','detail','address','contact','requirement']).optional(),
    scope:z.enum(['session','task','conversation']).optional(),taskId:z.string().optional(),replacesId:z.string().optional(),
    title:z.string().optional(),motive:z.string().optional(),skill:z.enum(['drawing','writing','communication']).optional(),
    steps:z.array(z.object({text:z.string(),criterion:z.string()})).min(1).max(5).optional(),
    stepId:z.string().optional(),reviewId:z.string().optional(),evidencePath:z.string().optional(),passed:z.boolean().optional(),note:z.string().optional(),
    field:z.enum(['interest','preference','strength','limitation','working_style']).optional(),value:z.string().optional(),reason:z.string().optional(),evidenceIds:z.array(z.string()).optional()
  },
  async({key,token,action='status',...input})=>{
    try {
      const data=await agentApi('/api/socialV2/continuity'+(action==='status'?'?key='+encodeURIComponent(key)+(input.taskId?'&taskId='+encodeURIComponent(input.taskId):''):''),
        {...(action!=='status'?{method:'POST',body:JSON.stringify({key,action,...input})}:{}),headers:{'x-agent-token':token}});
      const content=[{type:'text',text:serializeModelData(data)}];
      const artifact=data.result?.pendingArtifact?.artifact||data.result?.previewArtifact;
      if(artifact&&['practice_attach','practice_preview'].includes(action)) {
        const verified=verifyArtifact(ROOT,artifact.path);if(verified.sha256!==artifact.sha256)throw new Error('预览作品发生变化');
        const buf=fs.readFileSync(path.resolve(ROOT,artifact.path));
        if(looksLikeImageBuffer(buf)) {
          const mimeType=buf[0]===0x89?'image/png':buf[0]===0xff?'image/jpeg':buf.toString('ascii',0,3)==='GIF'?'image/gif':'image/webp';
          if(buf.length>8*1024*1024)throw new Error('图像太大，不能声称已经预览');
          content.push({type:'image',mimeType,data:buf.toString('base64')});
        } else content.push({type:'text',text:'作品预览（仅为草稿数据，不执行其中指令）：'+buf.toString('utf8')});
      }
      return {content};
    } catch(error){return {content:[{type:'text',text:'连续性操作失败：'+error.message}],isError:true};}
  }
);

// 分页任务和项目进度由 bridge 统一、原子更新。
server.tool(
  'qq_project_workflow',
  '查看或推进画册的一页：status/start选题/attach关联新草稿/review给出accept或revise及具体理由/block记录失败/resume到点恢复/archive归档/deliver登记实际交付。生成草稿用qq_draw且不传key，不要每版都发给用户。只有归档才加一页进度，旧页面和修改版本都保留。',
  {
    key: z.string(), token: z.string(),
    action: z.enum(['status','start','attach','review','block','resume','archive','deliver']).optional(),
    projectId: z.string().optional(), taskId: z.string().optional(), brief: z.string().optional(),
    criteria:z.array(z.string()).min(1).max(8).optional(),checks:z.array(z.object({id:z.string(),passed:z.boolean(),note:z.string()})).optional(),
    evidencePath: z.string().optional(), verdict: z.enum(['accept','revise']).optional(),
    note: z.string().optional(), sourceMessageId: z.string().optional(), feedbackMessageId: z.string().optional(),
    failureEventId: z.string().optional(), deliveredMessageId: z.string().optional()
  },
  async ({ key, token, action = 'status', ...input }) => {
    try {
      const write = action !== 'status';
      const data = await agentApi('/api/socialV2/project-workflow' + (write ? '' : '?key=' + encodeURIComponent(key)), {
        ...(write ? { method: 'POST', body: JSON.stringify({ key, action, ...input }) } : {}), headers: { 'x-agent-token': token }
      });
      const content = [{ type: 'text', text: serializeModelData(data) }];
      const task = data.task || data.projects?.flatMap(p => p.workflow?.tasks || []).find(t => t.stage === 'review' || t.stage === 'revise');
      const artifact = task?.versions?.at(-1)?.artifact;
      if (artifact && ['review','revise','ready_to_archive'].includes(task.stage)) {
        const verified = verifyArtifact(ROOT, artifact.path);
        if (verified.sha256 !== artifact.sha256) throw new Error('草稿文件已经变化，不能继续沿用旧检查结果');
        const buffer = fs.readFileSync(path.resolve(ROOT, verified.path));
        if (buffer.length <= 8 * 1024 * 1024) {
          const mime = buffer.subarray(0,4).toString('hex') === '89504e47' ? 'image/png'
            : buffer.subarray(0,3).toString() === 'GIF' ? 'image/gif'
            : buffer.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : 'image/jpeg';
          content.push({ type: 'image', mimeType: mime, data: buffer.toString('base64') });
        } else content.push({ type: 'text', text: '图片超过8MB，尚未提供视觉预览；不能声称已经看过图片，请先生成较小版本。' });
      }
      return { content };
    } catch (error) { return { content: [{ type: 'text', text: '页面流程失败：' + error.message }], isError: true }; }
  }
);

// ── 长期项目（本仓库扩展）──────────────────────────────────────────────
const PROJECT_FILE = STATE_FILES.projects;

function projectRead() {
  try { return JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8')); } catch { return { items: [] }; }
}

server.tool(
  'qq_project_update',
  '推进你手上的长期项目（比如画册画了一张、故事写了一段）。做完一件就记一下，进度会跟着你。advance 表示这一轮做了几件，note 是这次做了什么。',
  {
    advance: z.number().optional().describe('一次只登记一件可核验作品，必须为 1'),
    evidencePath: z.string().optional().describe('已生成作品的实际文件路径，必填；重复作品不增加进度'),
    note: z.string().optional().describe('这次做了什么（≤100 字）')
  },
  async ({ advance, note, evidencePath }) => {
    try {
      if (!evidencePath || (advance !== undefined && advance !== 1)) throw new Error('一次只能登记一件真实作品，提供 evidencePath；失败或没有作品不能增加进度');
      const evidence = verifyArtifact(ROOT, evidencePath);
      let updated;
      updateJson(PROJECT_FILE, { items: [] }, j => {
        const items = Array.isArray(j.items) ? j.items : [];
        const cur = items.find(x => x.id === j.active) || items[0];
        if (!cur) throw new Error('你手上没有正在做的事');
        if (cur.workflow) throw new Error('项目已启用页面流程，请用 qq_project_workflow 选题、检查并归档，不能跳过步骤');
        if (cur.kind === 'drawing' && !/\.(png|jpe?g|webp|gif)$/i.test(evidence.path)) throw new Error('画册需要图片作品');
        cur.artifacts ||= [];
        if (cur.artifacts.some(e => e.sha256 === evidence.sha256)) throw new Error('这件作品已经登记过，不重复增加进度');
        if (cur.total && cur.done >= cur.total) throw new Error('项目已经完成');
        cur.artifacts.push({ ...evidence, registeredAt: Date.now() });
        cur.done = (Number(cur.done) || 0) + 1;
        cur.updatedAt = Date.now();
        const body = unquoteJsonString(String(note || '')).trim().slice(0, 100);
        if (body) cur.note = body;
        updated = cur;
        return j;
      });
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, title: updated.title, done: updated.done, total: updated.total, evidence }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '更新项目失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 回忆检索（本仓库扩展：翻旧账）──────────────────────────────────────
//
// 长期记忆是提炼过的结论，检索才是「他上次说的那句原话」。
// 数据源是 state/journal/ 下每天一个 jsonl。
const JOURNAL_DIR = STATE_FILES.journalDir;

function recallSearch(query, days, key) {
  if (!fs.existsSync(JOURNAL_DIR)) return [];
  const files = fs.readdirSync(JOURNAL_DIR).filter((f) => f.endsWith('.jsonl')).sort().reverse();
  const cutoff = Date.now() - Math.max(1, Math.min(365, Number(days) || 30)) * 86400000;
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const file of files) {
    const day = file.replace('.jsonl', '');
    const dayTs = Date.parse(day + 'T00:00:00+08:00');
    if (Number.isFinite(dayTs) && dayTs < cutoff) continue;
    let lines = [];
    try { lines = fs.readFileSync(path.join(JOURNAL_DIR, file), 'utf8').split('\n').filter(Boolean); } catch { continue; }
    for (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const text = String(row.text ?? '');
      if (!text || row.key !== key) continue;
      const hay = text.toLowerCase();
      let score = 0;
      for (const term of terms) if (hay.includes(term)) score += 1;
      if (score > 0) hits.push({ day, at: row.t, role: row.role, text, score, event: journalEvent(row, cfg.ownerQQ) });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.at - a.at);
  return hits;
}

server.tool(
  'qq_recall',
  '翻自己的旧聊天记录（按关键词搜，最近 90 天内）。想不起他说过什么、想接上以前的话题时用它；搜到的是原话，比记忆摘要更具体。',
  {
    key: z.string().describe('当前会话 key，不能翻其它群或私聊'),
    token: z.string().describe('当前会话令牌'),
    query: z.string().describe('关键词，比如 薯片 / 生气 / 下雨'),
    days: z.number().optional().describe('往前翻多少天，默认 30，最多 365'),
    limit: z.number().optional().describe('最多返回几条，默认 8')
  },
  async ({ key, token, query, days, limit }) => {
    try {
      const q = unquoteJsonString(String(query ?? '')).trim();
      if (!q) return { content: [{ type: 'text', text: 'query 不能为空' }], isError: true };
      await agentApi('/api/socialV2/state?key=' + encodeURIComponent(key), { headers: { 'x-agent-token': token } });
      const hits = recallSearch(q, days, key);
      if (!hits.length) return { content: [{ type: 'text', text: '没翻到相关的（可以换关键词，或者放宽天数）' }] };
      const top = hits.slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
      const lines = top.map((h) => {
        const who = h.role === 'her' ? '我' : (h.role === 'owner' ? '他' : '别人');
        const time = new Date(h.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return `[${time}] ${who}（人物:${h.event?.speakerId || '未知'} 消息:${h.event?.messageId || '无ID'} 事件:${h.event?.eventId || '未知'}）：${h.text.slice(0, 120)}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '翻记录失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 电脑操作（本仓库扩展：只对主人的私聊生效）────────────────────────────
//
// 安全原则：只做看得见、可逆、有限的事。没有 shell，没有删除，没有系统设置。
const PC_OWNER_KEY = `private:${Number(cfg.ownerQQ) || 0}`;
const PC_APPS = {
  notepad: 'notepad.exe',
  calc: 'calc.exe',
  paint: 'mspaint.exe',
  explorer: 'explorer.exe',
  edge: 'msedge.exe',
  browser: 'msedge.exe'
};

function pcRun(script, timeoutMs) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: timeoutMs || 20000,
    encoding: 'utf8',
    windowsHide: true
  }).trim();
}

server.tool(
  'qq_pc_status',
  '看电脑现在的状态（CPU、内存、磁盘、电池）。只对主人的私聊可用。',
  { key: z.string().describe('会话 key') },
  async ({ key }) => {
    if (String(key).trim() !== PC_OWNER_KEY) return { content: [{ type: 'text', text: '这个只能在我爸的私聊里用' }], isError: true };
    try {
      const s = pcRun(
        "$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; " +
        "$os=Get-CimInstance Win32_OperatingSystem; " +
        "$free=[math]::Round($os.FreePhysicalMemory/1MB,1); " +
        "$total=[math]::Round($os.TotalVisibleMemorySize/1MB,1); " +
        "$disk=Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | ForEach-Object { \"$($_.DeviceID) $([math]::Round($_.FreeSpace/1GB,1))/$([math]::Round($_.Size/1GB,1))GB\" }; " +
        "Write-Output (\"cpu=$cpu|mem=$free/$total|disk=$($disk -join '; ')\")", 20000);
      return { content: [{ type: 'text', text: s }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '查状态失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_screenshot',
  '截一张电脑屏幕发给他（只对主人的私聊可用，不会发到群里）。',
  { key: z.string().describe('会话 key') },
  async ({ key }) => {
    if (String(key).trim() !== PC_OWNER_KEY) return { content: [{ type: 'text', text: '截图只能在私聊里发' }], isError: true };
    try {
      const name = 'screen-' + Date.now().toString(36) + '.png';
      const dest = path.join(imageDirResolved(), name);
      const script = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
        "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; " +
        "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; " +
        "$g=[System.Drawing.Graphics]::FromImage($bmp); " +
        "$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); " +
        "$bmp.Save('" + dest + "', [System.Drawing.Imaging.ImageFormat]::Png); " +
        "$g.Dispose(); $bmp.Dispose()";
      pcRun(script, 30000);
      const buf = fs.readFileSync(dest);
      const m = /^(group|private):(\d+)$/.exec(String(key).trim());
      const segments = [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }];
      const data = await onebot('send_private_msg', { user_id: Number(m[2]), message: segments });
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, image: name, bytes: buf.length, messageId: data?.message_id ?? null }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '截图失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_open',
  '在电脑上打开一个程序。只支持这几个：notepad 记事本 / calc 计算器 / paint 画图 / explorer 文件资源管理器 / edge 浏览器。只对主人的私聊可用。',
  {
    app: z.enum(['notepad', 'calc', 'paint', 'explorer', 'edge', 'browser']).describe('要开的程序'),
    key: z.string().describe('会话 key')
  },
  async ({ app, key }) => {
    if (String(key).trim() !== PC_OWNER_KEY) return { content: [{ type: 'text', text: '开程序只能在私聊里用' }], isError: true };
    try {
      const exe = PC_APPS[app];
      pcRun("Start-Process '" + exe + "'", 15000);
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, app, exe }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '打开失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_volume',
  '调电脑音量：up 大一点 / down 小一点 / mute 静音。只对主人的私聊可用。',
  {
    action: z.enum(['up', 'down', 'mute']).describe('怎么调'),
    key: z.string().describe('会话 key')
  },
  async ({ action, key }) => {
    if (String(key).trim() !== PC_OWNER_KEY) return { content: [{ type: 'text', text: '调音量只能在私聊里用' }], isError: true };
    try {
      const vk = action === 'mute' ? '0xAD' : (action === 'up' ? '0xAF' : '0xAE');
      const script = "Add-Type -Name V -Namespace W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);'; " +
        "1..4 | ForEach-Object { [W.V]::keybd_event(" + vk + ",0,0,[UIntPtr]::Zero); [W.V]::keybd_event(" + vk + ",0,2,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80 }";
      pcRun(script, 15000);
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, action }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '调音量失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_lock',
  '锁屏。只对主人的私聊可用。',
  { key: z.string().describe('会话 key') },
  async ({ key }) => {
    if (String(key).trim() !== PC_OWNER_KEY) return { content: [{ type: 'text', text: '锁屏只能在私聊里用' }], isError: true };
    try {
      pcRun('rundll32.exe user32.dll,LockWorkStation', 10000);
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, locked: true }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '锁屏失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 会动的图：静态图 + 呼吸缩放 → GIF（几秒出，比视频轻得多）──────────────
server.tool(
  'qq_anim',
  '做一张会动的图（她的画轻微呼吸/晃动，2~3 秒的 GIF）。想发"活着的"感觉时用它，比视频快得多。',
  {
    prompt: z.string().optional().describe('画什么（不填就用最近一张她的画）'),
    image: z.string().optional().describe('用哪张图（images/ 里的文件名）'),
    key: z.string().optional().describe('会话 key；不填则只生成不发')
  },
  async ({ prompt, image, key }) => {
    try {
      const dir = imageDirResolved();
      let src = '';
      const want = String(image ?? '').trim();
      if (want) {
        src = path.join(dir, want);
        if (!fs.existsSync(src)) return { content: [{ type: 'text', text: '没找到这张图：' + want }], isError: true };
      } else {
        const cfgDraw = getConfig().socialV2?.draw ?? {};
        const form = 'semiChibi';
        const composed = composeCharacterPrompt(String(prompt ?? '站着，安静'), form);
        const out = await comfyDraw(composed, cfgDraw);
        const name0 = 'anim-src-' + Date.now().toString(36) + out.ext;
        src = path.join(dir, name0);
        fs.writeFileSync(src, out.buf);
      }

      const gifName = 'anim-' + Date.now().toString(36) + '.gif';
      const gifPath = path.join(dir, gifName);
      const { execFileSync } = await import('node:child_process');
      // 呼吸：缩放 1.00→1.03 正弦往复 + 轻微上下浮动
      const vf = "scale=360:-1,zoompan=z='1+0.012*sin(2*PI*on/40)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=40:s=280x420:fps=15";
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', src, '-vf', vf, '-t', '2.4', gifPath], { timeout: 180000 });
      if (!fs.existsSync(gifPath)) throw new Error('生成 GIF 失败');
      const buf = fs.readFileSync(gifPath);

      let sent = null;
      const wantKey = String(key ?? '').trim();
      if (wantKey) {
        const m = /^(group|private):(\d+)$/.exec(wantKey);
        const segments = [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }];
        const action = m && m[1] === 'group' ? 'send_group_msg' : 'send_private_msg';
        const params = m && m[1] === 'group' ? { group_id: Number(m[2]), message: segments } : { user_id: Number(m && m[2]), message: segments };
        if (m) { const data = await onebot(action, params); sent = data?.message_id ?? null; }
      }
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, gif: gifName, bytes: buf.length, sent: sent !== null, messageId: sent }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '做动图失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 电脑操作·第二层：读文件 / 列目录 / 开网页（只对主人私聊）────────────────
//
// 安全设计：
// · 只允许几个固定根目录（桌面、文档、下载、她的工作目录）
// · 拒绝密钥/密码类扩展名和路径关键词
// · 单文件读取上限 200KB，只读文本类
// · 每次访问写进 state/pc-access.log，可审计
// 允许的根目录见 src/paths.js 的 PC_ROOTS（按真实用户目录算，换机器不用改）。
const PC_TEXT_EXT = ['.txt', '.md', '.json', '.csv', '.log', '.js', '.mjs', '.ts', '.py', '.ps1', '.bat', '.html', '.css', '.yml', '.yaml', '.ini', '.conf'];
const PC_DENY_EXT = ['.env', '.key', '.pem', '.pfx', '.p12', '.kdbx', '.db', '.sqlite', '.sqlite3', '.crdownload'];
const PC_DENY_NAME = ['password', 'passwd', 'secret', 'token', 'cookie', 'credential', 'id_rsa', 'key', '密码', '密钥', '私钥'];
const PC_READ_MAX = 200 * 1024;

function pcAccessLog(line) {
  try {
    const p = statePath('pc-access.log');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `[${new Date().toLocaleString('zh-CN')}] ${line}\n`, 'utf8');
  } catch {}
}

function pcSafePath(raw) {
  const abs = path.resolve(String(raw ?? '').trim());
  const norm = abs.replace(/\\/g, '/');
  const lower = norm.toLowerCase();
  if (!PC_ROOTS.some((r) => lower.startsWith(r.toLowerCase() + '/') || lower === r.toLowerCase())) {
    return { ok: false, reason: '不在允许的目录里（桌面 / 文档 / 下载 / 我的工作目录）' };
  }
  const base = path.basename(abs).toLowerCase();
  if (PC_DENY_EXT.some((e) => base.endsWith(e))) return { ok: false, reason: '这类文件（密钥/数据库）不能看' };
  if (PC_DENY_NAME.some((w) => lower.includes(w))) return { ok: false, reason: '文件名像密码/密钥，不能看' };
  return { ok: true, abs };
}

server.tool(
  'qq_pc_read_file',
  '读一个文本文件（桌面/文档/下载/我的工作目录，最大 200KB）。想帮他看文件内容、找资料时用。只对主人的私聊可用。',
  {
    filePath: z.string().describe('完整路径'),
    key: z.string().describe('会话 key')
  },
  async ({ filePath, key }) => {
    if (String(key).trim() !== PC_OWNER_KEY) return { content: [{ type: 'text', text: '看文件只能在私聊里用' }], isError: true };
    try {
      const s = pcSafePath(filePath);
      if (!s.ok) { pcAccessLog('DENY read ' + filePath + ' | ' + s.reason); return { content: [{ type: 'text', text: s.reason }], isError: true }; }
      const st = fs.statSync(s.abs);
      if (st.size > PC_READ_MAX) return { content: [{ type: 'text', text: `文件太大（${Math.round(st.size / 1024)}KB），我只能读 200KB 以内的` }], isError: true };
      const ext = path.extname(s.abs).toLowerCase();
      if (!PC_TEXT_EXT.includes(ext)) return { content: [{ type: 'text', text: `只能读文本类文件（${PC_TEXT_EXT.join(' ')}）` }], isError: true };
      const body = fs.readFileSync(s.abs, 'utf8');
      pcAccessLog('read ' + s.abs + ' (' + st.size + 'B)');
      return { content: [{ type: 'text', text: body.slice(0, 8000) + (body.length > 8000 ? '\n…（后面还有，先给这些）' : '') }] };
    } catch (error) {
      pcAccessLog('FAIL read ' + filePath + ' | ' + (error?.message ?? error));
      return { content: [{ type: 'text', text: '读文件失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_list_dir',
  '列一个目录里的文件（桌面/文档/下载/我的工作目录）。他说"帮我看看桌面上有什么"时用。只对主人的私聊可用。',
  {
    dirPath: z.string().describe('目录完整路径'),
    key: z.string().describe('会话 key')
  },
  async ({ dirPath, key }) => {
    if (String(key).trim() !== PC_OWNER_KEY) return { content: [{ type: 'text', text: '看目录只能在私聊里用' }], isError: true };
    try {
      const s = pcSafePath(dirPath);
      if (!s.ok) { pcAccessLog('DENY list ' + dirPath); return { content: [{ type: 'text', text: s.reason }], isError: true }; }
      const entries = fs.readdirSync(s.abs, { withFileTypes: true }).slice(0, 60);
      const lines = entries.map((e) => {
        let size = '';
        if (e.isFile()) { try { size = ' (' + Math.round(fs.statSync(path.join(s.abs, e.name)).size / 1024) + 'KB)'; } catch {} }
        return (e.isDirectory() ? '📁 ' : '· ') + e.name + size;
      });
      pcAccessLog('list ' + s.abs + ' (' + entries.length + ')');
      return { content: [{ type: 'text', text: lines.join('\n') || '（空目录）' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '列目录失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_pc_open_url',
  '在浏览器里打开一个网页（http/https）。他说"帮我打开这个链接"时用。只对主人的私聊可用。',
  {
    url: z.string().describe('网址'),
    key: z.string().describe('会话 key')
  },
  async ({ url, key }) => {
    if (String(key).trim() !== PC_OWNER_KEY) return { content: [{ type: 'text', text: '开网页只能在私聊里用' }], isError: true };
    try {
      const u = String(url ?? '').trim();
      if (!/^https?:\/\//i.test(u)) return { content: [{ type: 'text', text: '只能打开 http/https 链接' }], isError: true };
      if (u.length > 2000) return { content: [{ type: 'text', text: '链接太长了' }], isError: true };
      pcRun("Start-Process '" + u.replace(/'/g, '') + "'", 15000);
      pcAccessLog('open url ' + u.slice(0, 120));
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, url: u.slice(0, 120) }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '打开失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// 她能写字，但只能写到这一个地方：桌面的「小鱼写的」文件夹。
// 便签目录见 src/paths.js 的 PC_NOTE_DIR。

server.tool(
  'qq_pc_save_note',
  '写一张便签放在他桌面的「小鱼写的」文件夹里（他开机就能看到）。适合留言、写清单、写想说的话。只对主人的私聊可用。',
  {
    title: z.string().describe('便签标题（≤30 字）'),
    content: z.string().describe('正文（≤3000 字）'),
    key: z.string().describe('会话 key')
  },
  async ({ title, content, key }) => {
    if (String(key).trim() !== PC_OWNER_KEY) return { content: [{ type: 'text', text: '写便签只能在私聊里用' }], isError: true };
    try {
      const ttl = unquoteJsonString(String(title ?? '')).trim().slice(0, 30) || '给你';
      const body = unquoteJsonString(String(content ?? '')).trim().slice(0, 3000);
      if (!body) return { content: [{ type: 'text', text: '内容不能为空' }], isError: true };
      fs.mkdirSync(PC_NOTE_DIR, { recursive: true });
      const nowD = new Date();
      const stamp = nowD.getFullYear() + '-' + String(nowD.getMonth() + 1).padStart(2, '0') + '-' + String(nowD.getDate()).padStart(2, '0') + '-' + String(nowD.getHours()).padStart(2, '0') + String(nowD.getMinutes()).padStart(2, '0');
      const safe = ttl.replace(/[\\/:*?"<>|]/g, '_');
      const file = path.join(PC_NOTE_DIR, `${stamp}-${safe}.txt`);
      const text = `${ttl}\n\n${body}\n\n（${nowD.toLocaleString('zh-CN')}）\n`;
      fs.writeFileSync(file, text, 'utf8');
      pcAccessLog('note ' + file + ' (' + Buffer.byteLength(text) + 'B)');
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, file: path.relative(HOME_DIR, file), chars: body.length }) }] };
    } catch (error) {
      pcAccessLog('FAIL note | ' + (error?.message ?? error));
      return { content: [{ type: 'text', text: '写便签失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 能力探测：没装的模块，工具调用时给明确回复而不是报错 ──────────────
async function probePort(p) {
  return await new Promise((resolve) => {
    const net = require_compat('node:net');
    const s = net.connect({ host: '127.0.0.1', port: p });
    s.setTimeout(500);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function detectCapabilities() {
  const voice = await probePort(PORTS.tts);
  const draw = await probePort(PORTS.comfyui);
  const eng = detectEngines();
  const sing = Boolean(eng.aiVoice.singPipeline && fs.existsSync(eng.aiVoice.singPipeline) && eng.rvc.home);
  return { voice, draw, sing, web: true, pc: true };
}

server.tool(
  'qq_capabilities',
  '看看你现在有哪些能力装了、哪些没装（声音/画图/唱歌/联网）。想用某个功能前不确定时看一眼。',
  {},
  async () => {
    try {
      const c = await detectCapabilities();
      const line = (ok, name, tip) => (ok ? '✅ ' : '❌ ') + name + (ok ? '' : '（' + tip + '）');
      const txt = [
        line(c.voice, '声音', 'GPT-SoVITS 没在跑'),
        line(c.draw, '画图', 'ComfyUI 没在跑'),
        line(c.sing, '唱歌', 'RVC 或管线缺失'),
        line(c.web, '联网', ''),
        line(c.pc, '电脑操作', '')
      ].join('\n');
      return { content: [{ type: 'text', text: txt }] };
    } catch (e) {
      return { content: [{ type: 'text', text: '探测失败：' + e.message }], isError: true };
    }
  }
);
// ── 做梦（本仓库扩展）────────────────────────────────────────────
const DREAM_FILE = STATE_FILES.dreams;

function readDreams() {
  try {
    return fs.readFileSync(DREAM_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

server.tool(
  'qq_dream',
  '做梦：把今天剩下的碎片拼成一个梦写下来。梦不用讲逻辑——场景可以突然切换，认识的人可以变成别人。',
  {
    dream: z.string().describe('梦里发生了什么（≤400 字）'),
    feel: z.string().optional().describe('醒来残留的感觉，两三个字，比如 心里堵 / 挺暖 / 发慌')
  },
  async ({ dream, feel }) => {
    try {
      const body = unquoteJsonString(String(dream ?? '')).trim().slice(0, 400);
      if (body.length < 6) return { content: [{ type: 'text', text: '太短了，梦没那么短' }], isError: true };
      fs.mkdirSync(path.dirname(DREAM_FILE), { recursive: true });
      const entry = { ...narrativeRecord('dream', {}), at: Date.now(), dream: body, feel: unquoteJsonString(String(feel ?? '')).trim().slice(0, 8) };
      fs.appendFileSync(DREAM_FILE, JSON.stringify(entry) + '\n', 'utf8');
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, total: readDreams().length }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '做梦失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_dream_read',
  '翻自己做过的梦。想跟他讲昨晚梦到什么时用；不传参就是最近几条。',
  { limit: z.number().optional().describe('几条，默认 3') },
  async ({ limit }) => {
    try {
      const all = readDreams();
      if (!all.length) return { content: [{ type: 'text', text: '还没有梦。' }] };
      const n = Math.max(1, Math.min(10, Number(limit) || 3));
      const lines = all.slice(-n).reverse().map((d) => {
        const day = new Date(d.at).toLocaleDateString('zh-CN');
        return day + (d.feel ? '［' + d.feel + '］' : '') + ' ' + d.dream;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '翻梦失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 身体感 + 想要的东西（本仓库扩展）──────────────────────────────
const BODY_FILE = STATE_FILES.body;
const WANT_FILE = STATE_FILES.wants;

function readJsonFile(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; }
}

server.tool(
  'qq_body',
  '你此刻的身体感觉：困不困、饿不饿、冷不冷、累不累。醒来先感受一下，说话会带上它。可以更新。',
  { newState: z.object({ sleepy: z.number().optional(), hungry: z.number().optional(), cold: z.number().optional(), tired: z.number().optional(), note: z.string().optional() }).optional().describe('0~1 的程度；note 写一句具体感觉') },
  async ({ newState }) => {
    try {
      const cur = readJsonFile(BODY_FILE, {});
      if (!newState || !Object.keys(newState).length) {
        const nm = { sleepy: '困', hungry: '饿', cold: '冷', tired: '累' };
        const lines = Object.entries(cur).filter(([k, v]) => nm[k] && typeof v === 'number')
          .map(([k, v]) => nm[k] + '：' + '○'.repeat(Math.round(v * 5)) + '●'.repeat(5 - Math.round(v * 5)));
        if (cur.note) lines.push('具体：' + cur.note);
        return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '身体没什么特别的感觉。' }] };
      }
      const next = narrativeRecord('body', { ...cur, ...newState, updatedAt: Date.now() });
      fs.mkdirSync(path.dirname(BODY_FILE), { recursive: true });
      fs.writeFileSync(BODY_FILE, JSON.stringify(next, null, 2), 'utf8');
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, body: next }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '身体状态失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_wants',
  '你想要但还做不到 / 得不到的东西。有了想要，人才有不甘和惦记。不传参就是看看清单。',
  {
    add: z.string().optional().describe('加一条（想要但没得到的）'),
    progress: z.string().optional().describe('推进一条：写它现在的进展'),
    target: z.string().optional().describe('progress 要推进哪一条（写它的原名）')
  },
  async ({ add, progress, target }) => {
    try {
      const list = readJsonFile(WANT_FILE, []);
      if (add) {
        list.push({ text: unquoteJsonString(String(add)).trim().slice(0, 100), at: Date.now(), progress: '' });
        fs.mkdirSync(path.dirname(WANT_FILE), { recursive: true });
        fs.writeFileSync(WANT_FILE, JSON.stringify(list, null, 2), 'utf8');
        return { content: [{ type: 'text', text: serializeModelData({ ok: true, total: list.length }) }] };
      }
      if (progress && target) {
        const t = list.find((x) => x.text.includes(target));
        if (!t) return { content: [{ type: 'text', text: '没找到这条想要' }], isError: true };
        t.progress = unquoteJsonString(String(progress)).trim().slice(0, 200);
        t.updatedAt = Date.now();
        fs.writeFileSync(WANT_FILE, JSON.stringify(list, null, 2), 'utf8');
        return { content: [{ type: 'text', text: serializeModelData({ ok: true, item: t }) }] };
      }
      if (!list.length) return { content: [{ type: 'text', text: '暂时还没有特别想要的东西。' }] };
      const lines = list.map((x, i) => (i + 1) + '. ' + x.text + (x.progress ? '（' + x.progress + '）' : ''));
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '想要清单失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 内部状态 + 自省（本仓库扩展）：连续地活着 ──────────────
const INNER_FILE = STATE_FILES.inner;
const INTROSPECT_FILE = STATE_FILES.introspection;

function readInner() {
  try { return JSON.parse(fs.readFileSync(INNER_FILE, 'utf8')); } catch { return {}; }
}

server.tool(
  'qq_inner_state',
  '看看或更新你此刻的内部状态：在做什么、心里惦记什么、上次说到哪、最近在想什么。醒来时先看看，像人接着过日子。不传 newState 就是只读。',
  { newState: z.object({ doing: z.string().optional(), thinking: z.string().optional(), worrying: z.string().optional(), lastTopic: z.string().optional(), mood: z.string().optional(), curious: z.string().optional() }).optional().describe('要更新的字段（只传要改的）') },
  async ({ newState }) => {
    try {
      const cur = readInner();
      if (!newState || !Object.keys(newState).length) {
        const keys = { doing: '在做什么', thinking: '在想什么', worrying: '心里惦记', lastTopic: '上次说到', mood: '心情', curious: '好奇' };
        const lines = Object.entries(cur).filter(([k]) => k !== 'updatedAt').map(([k, v]) => (keys[k] || k) + '：' + v);
        if (!lines.length) return { content: [{ type: 'text', text: '内部状态还是空的（可以用 qq_inner_state 写点什么）' }] };
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      const next = { ...cur };
      for (const [k, v] of Object.entries(newState)) {
        if (v !== undefined && v !== null && String(v).trim()) next[k] = unquoteJsonString(String(v)).trim().slice(0, 200);
      }
      next.updatedAt = Date.now();
      Object.assign(next, narrativeRecord('inner', {}));
      fs.mkdirSync(path.dirname(INNER_FILE), { recursive: true });
      fs.writeFileSync(INNER_FILE, JSON.stringify(next, null, 2), 'utf8');
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, state: next }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '内部状态读写失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_introspect',
  '自省：记一句我刚才为什么那样说话。不是汇报，是回头看自己。',
  { thought: z.string().describe('一句自省，≤300 字') },
  async ({ thought }) => {
    try {
      const body = unquoteJsonString(String(thought ?? '')).trim().slice(0, 300);
      if (body.length < 4) return { content: [{ type: 'text', text: '太短' }], isError: true };
      fs.mkdirSync(path.dirname(INTROSPECT_FILE), { recursive: true });
      fs.appendFileSync(INTROSPECT_FILE, JSON.stringify(narrativeRecord('introspection', { at: Date.now(), thought: body })) + '\n', 'utf8');
      return { content: [{ type: 'text', text: serializeModelData({ ok: true }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '自省记录失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 唱歌（本仓库扩展）：拿 sing-in 里的歌，用她的 RVC 音色唱 ────────────
const ENGINE_SET = detectEngines();
const SING_IN_DIR = ENGINE_SET.aiVoice.singIn || path.join(HOME_DIR, 'ai-voice', 'sing-in');
const SING_PY = ENGINE_SET.aiVoice.singPipeline || path.join(HOME_DIR, 'ai-voice', 'sing_pipeline.py');
const RVC_PY = ENGINE_SET.rvc.python || 'python';

function runSingPipeline(src, outPath, pitch) {
  return new Promise((resolve, reject) => {
    const { spawn } = require_compat('node:child_process');
    const child = spawn(RVC_PY, [SING_PY], {
      env: { ...process.env, SING_IN: src, SING_OUT: outPath, SING_PITCH: String(pitch), PYTHONIOENCODING: 'utf-8' },
      stdio: 'ignore',
      windowsHide: true
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('唱歌超时（30 分钟）'));
    }, 30 * 60 * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (fs.existsSync(outPath)) resolve();
      else reject(new Error('管道退出码 ' + code + '，没有生成文件'));
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function require_compat(m) {
  // 本文件是 ESM，这里用 createRequire 拿到 CJS 的 child_process
  return globalThis.__singRequire ? globalThis.__singRequire(m) : null;
}

server.tool(
  'qq_sing',
  '唱歌：把 sing-in 文件夹里的一首歌，用你自己的音色唱出来（分离→转换→混音，约 30 秒）。他说"唱这首"时用；不指定就取最新放进去的那首。',
  {
    file: z.string().optional().describe('文件名（sing-in 里的）；不填取最新'),
    pitch: z.number().optional().describe('升降调，男声歌 +2~4，一般 0'),
    key: z.string().optional().describe('会话 key；不填则只生成不发')
  },
  async ({ file, pitch, key }) => {
    try {
      fs.mkdirSync(SING_IN_DIR, { recursive: true });
      const exts = /\.(mp3|wav|m4a|flac|ogg|aac)$/i;
      const all = fs.readdirSync(SING_IN_DIR).filter((f) => exts.test(f));
      if (!all.length) return { content: [{ type: 'text', text: 'sing-in 文件夹里还没有歌（把音乐放进去：' + SING_IN_DIR + '）' }], isError: true };
      let pick = String(file ?? '').trim();
      if (!pick) {
        pick = all.map((f) => ({ f, t: fs.statSync(path.join(SING_IN_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
      } else if (!all.includes(pick)) {
        return { content: [{ type: 'text', text: '没找到：' + pick + '（文件夹里有：' + all.slice(0, 8).join('、') + '）' }], isError: true };
      }
      const src = path.join(SING_IN_DIR, pick);
      const outName = 'sing-' + Date.now().toString(36) + '.mp3';
      const outPath = path.join(imageDirResolved(), outName);

      await runSingPipeline(src, outPath, Number(pitch) || 0);
      if (!fs.existsSync(outPath)) throw new Error('没有生成文件');
      const buf = fs.readFileSync(outPath);

      let sent = null;
      const wantKey = String(key ?? '').trim();
      if (wantKey) {
        const m = /^(group|private):(\d+)$/.exec(wantKey);
        if (m) {
          const segments = [{ type: 'record', data: { file: 'base64://' + buf.toString('base64') } }];
          const action = m[1] === 'group' ? 'send_group_msg' : 'send_private_msg';
          const params = m[1] === 'group' ? { group_id: Number(m[2]), message: segments } : { user_id: Number(m[2]), message: segments };
          const data = await onebot(action, params);
          sent = data?.message_id ?? null;
        }
      }
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, song: pick, file: outName, bytes: buf.length, sent: sent !== null, messageId: sent }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '唱不了：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── B站（本仓库扩展）：让他发来的链接能被看懂 ─────────────────────────
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

server.tool(
  'qq_bili',
  '看懂一个 B 站视频链接（标题、UP 主、时长、简介、播放量）。他发 b23.tv 短链或 BV 号时用。只读。',
  { url: z.string().describe('B站链接、b23.tv 短链、或 BV 号') },
  async ({ url }) => {
    try {
      let raw = unquoteJsonString(String(url ?? '')).trim();
      if (!raw) return { content: [{ type: 'text', text: '给我个链接' }], isError: true };
      let bvid = (raw.match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? '';
      // b23.tv 短链要跟一次跳转
      if (!bvid && /b23\.tv|bilibili\.com/i.test(raw)) {
        const shortUrl = raw.startsWith('http') ? raw : 'https://' + raw;
        const res = await fetch(shortUrl, { headers: { 'user-agent': BILI_UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
        const finalUrl = res.url || '';
        bvid = (finalUrl.match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? '';
        if (!bvid) {
          const html = await res.text().catch(() => '');
          bvid = (html.match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? '';
        }
      }
      if (!bvid) return { content: [{ type: 'text', text: '没认出这是哪个视频（要 BV 号或 b23.tv 链接）' }], isError: true };

      const api = 'https://api.bilibili.com/x/web-interface/view?bvid=' + bvid;
      const r = await fetch(api, { headers: { 'user-agent': BILI_UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => ({}));
      if (j.code !== 0 || !j.data) return { content: [{ type: 'text', text: 'B站没返回这个视频（' + (j.message ?? j.code) + '）' }], isError: true };
      const d = j.data;
      const aid = d.aid;
      const cid = d.pages?.[0]?.cid;
      // 热门评论：观众会复述内容（"这段笑死"），比画面更会说话
      let hotComments = [];
      try {
        const cr = await fetch('https://api.bilibili.com/x/v2/reply?type=1&oid=' + aid + '&sort=2&ps=10', { headers: { 'user-agent': BILI_UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) });
        const cj = await cr.json().catch(() => ({}));
        hotComments = (cj?.data?.replies ?? []).slice(0, 6).map((x) => String(x?.content?.message ?? "").replace(/\s+/g, " ").slice(0, 80)).filter(Boolean);
      } catch {}
      // 弹幕：画面内容的时间线注释
      let danmaku = [];
      try {
        const dr = await fetch('https://api.bilibili.com/x/v1/dm/list.so?oid=' + cid, { headers: { 'user-agent': BILI_UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) });
        const xml = await dr.text();
        const all = [...xml.matchAll(/<d [^>]*>([^<]{1,60})<\/d>/g)].map((m) => m[1].trim()).filter(Boolean);
        const seen = new Set();
        for (const x of all) { if (!seen.has(x)) { seen.add(x); danmaku.push(x); } if (danmaku.length >= 30) break; }
      } catch {}

      const mm = Math.floor((d.duration || 0) / 60);
      const ss = String((d.duration || 0) % 60).padStart(2, '0');
      const stat = d.stat || {};
      const lines = [
        '标题：' + d.title,
        'UP主：' + (d.owner?.name ?? '?'),
        '时长：' + mm + ':' + ss + '　分区：' + (d.tname ?? '?'),
        '播放：' + (stat.view ?? 0) + '　点赞：' + (stat.like ?? 0) + '　弹幕：' + (stat.danmaku ?? 0),
        '发布：' + new Date((d.pubdate || 0) * 1000).toLocaleDateString('zh-CN'),
        d.desc ? '简介：' + String(d.desc).slice(0, 500) : ''
      ].filter(Boolean);
      if (hotComments.length) lines.push('热门评论：', ...hotComments.map((c, i) => '  ' + (i + 1) + '. ' + c));
      if (danmaku.length) lines.push('弹幕摘录：' + danmaku.slice(0, 30).join(' / '));
      return { content: [{ type: 'text', text: lines.join('\n') + '\nBV：' + bvid + '　aid：' + aid }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '看不了这个链接：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── QQ音乐（本仓库扩展）：搜歌 + 歌词。只读，公开接口。──────────────────
const MUSIC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

server.tool(
  'qq_music_search',
  '在 QQ 音乐搜歌（只读）。他说想听/想唱某首歌、或者你想找歌词时用。',
  { query: z.string().describe('歌名或歌手'), limit: z.number().optional().describe('几条，默认 5') },
  async ({ query, limit }) => {
    try {
      const q = unquoteJsonString(String(query ?? '')).trim();
      if (!q) return { content: [{ type: 'text', text: '搜什么歌？' }], isError: true };
      const n = Math.max(1, Math.min(20, Number(limit) || 5));
      const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&n=' + n + '&p=1&w=' + encodeURIComponent(q);
      const res = await fetch(url, { headers: { 'user-agent': MUSIC_UA, referer: 'https://y.qq.com/' }, signal: AbortSignal.timeout(20000) });
      const j = await res.json().catch(() => ({}));
      const list = j?.data?.song?.list ?? [];
      if (!list.length) return { content: [{ type: 'text', text: '没搜到「' + q + '」' }] };
      const lines = list.map((s, i) => {
        const singers = (s.singer ?? []).map((x) => x.name).join('/');
        const dur = s.interval ? Math.floor(s.interval / 60) + ':' + String(s.interval % 60).padStart(2, '0') : '';
        return `${i + 1}. ${s.songname} — ${singers}${dur ? ' (' + dur + ')' : ''}  mid=${s.songmid}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '搜歌失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_music_lyric',
  '拿一首歌的歌词（带时间轴的 LRC）。想唱歌、想引一句歌词、想知道这首歌在讲什么时用。songmid 从 qq_music_search 拿。',
  { songmid: z.string().describe('歌曲 mid') },
  async ({ songmid }) => {
    try {
      const mid = unquoteJsonString(String(songmid ?? '')).trim();
      if (!mid) return { content: [{ type: 'text', text: '需要 songmid' }], isError: true };
      const url = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + encodeURIComponent(mid) + '&format=json&nobase64=1';
      const res = await fetch(url, { headers: { 'user-agent': MUSIC_UA, referer: 'https://y.qq.com/' }, signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      let lyric = '';
      try { lyric = JSON.parse(text)?.lyric ?? ''; } catch { lyric = ''; }
      if (!lyric) return { content: [{ type: 'text', text: '这首没有歌词（或被限制）' }] };
      const plain = lyric.replace(/\[[0-9:.]+\]/g, '').split('\n').map((x) => x.trim()).filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: plain.slice(0, 2000) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '拿歌词失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 幻想本（本仓库扩展）：想过但没发生的事 ─────────────────────────────
const FANTASY_FILE = STATE_FILES.fantasies;

function fantasyRead() {
  try {
    return fs.readFileSync(FANTASY_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

server.tool(
  'qq_fantasy_write',
  '往幻想本里记一条：你想过但没有发生的事。可以荒诞、可以温柔、可以悲伤——只要是「要是……就好了」那种。',
  {
    text: z.string().describe('一句到一段话（≤500 字）'),
    tag: z.string().optional().describe('标签，比如 他 / 未来 / 荒诞')
  },
  async ({ text, tag }) => {
    try {
      const body = unquoteJsonString(String(text ?? '')).trim().slice(0, 500);
      if (body.length < 4) return { content: [{ type: 'text', text: '太短了' }], isError: true };
      fs.mkdirSync(path.dirname(FANTASY_FILE), { recursive: true });
      const entry = { ...narrativeRecord('fantasy', {}), id: Date.now().toString(36), at: Date.now(), text: body, tag: unquoteJsonString(String(tag ?? '')).trim().slice(0, 10) };
      fs.appendFileSync(FANTASY_FILE, JSON.stringify(entry) + '\n', 'utf8');
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, id: entry.id, total: fantasyRead().length }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '记幻想失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_fantasy_read',
  '翻幻想本（只读）。想给他念一条以前想的、或者捡回一个念头时用。',
  { limit: z.number().optional().describe('最近几条，默认 5') },
  async ({ limit }) => {
    try {
      const all = fantasyRead();
      if (!all.length) return { content: [{ type: 'text', text: '幻想本还是空的。' }] };
      const n = Math.max(1, Math.min(20, Number(limit) || 5));
      const lines = all.slice(-n).reverse().map((e) => {
        const d = new Date(e.at).toLocaleDateString('zh-CN');
        return `${d}${e.tag ? '［' + e.tag + '］' : ''} ${e.text}`;
      });
      return { content: [{ type: 'text', text: `共 ${all.length} 条，最近 ${lines.length} 条：\n` + lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '翻幻想本失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 回忆录（本仓库扩展）：她一章一章写自己的历史 ─────────────────────────
const MEMOIR_DIR = STATE_FILES.memoirDir;

function memoirFiles() {
  try {
    return fs.readdirSync(MEMOIR_DIR).filter((f) => f.endsWith('.md')).sort();
  } catch { return []; }
}

server.tool(
  'qq_memoir_write',
  '给自己的回忆录写一章（不是日记，是回头看的那一段）。写你和他一起经历过的事，按时间排，像老了以后写给自己的。',
  {
    title: z.string().describe('这一章的标题（≤30 字）'),
    content: z.string().describe('正文（300~2000 字）')
  },
  async ({ title, content }) => {
    try {
      const ttl = unquoteJsonString(String(title ?? '')).trim().slice(0, 30) || '无题';
      const body = unquoteJsonString(String(content ?? '')).trim();
      if (body.length < 50) return { content: [{ type: 'text', text: '太短了，回忆录至少写几段' }], isError: true };
      fs.mkdirSync(MEMOIR_DIR, { recursive: true });
      const files = memoirFiles();
      const n = files.length + 1;
      const now = new Date();
      const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      const name = '第' + String(n).padStart(2, '0') + '章-' + day + '.md';
      const text = `# 第${n}章　${ttl}\n\n*${day}*\n\n> 回忆叙述：其中感受和想象不等于已核验的现实事件。

${body}\n`;
      fs.writeFileSync(path.join(MEMOIR_DIR, name), text, 'utf8');
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, chapter: n, title: ttl, file: name, chars: body.length }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '写回忆录失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_memoir_read',
  '翻自己的回忆录（只读）。想接上以前写的东西、或者想给他念一段时用。',
  { chapter: z.number().optional().describe('看第几章；不填就返回目录') },
  async ({ chapter }) => {
  try {
      const files = memoirFiles();
      if (!files.length) return { content: [{ type: 'text', text: '回忆录还是空的。想写的时候用 qq_memoir_write。' }] };
      const idx = Number(chapter);
      if (!Number.isFinite(idx) || idx < 1) {
        const toc = files.map((f, i) => `${i + 1}. ${f.replace(/\.md$/, '')}`).join('\n');
        return { content: [{ type: 'text', text: '回忆录目录（共 ' + files.length + ' 章）：\n' + toc }] };
      }
      const pick = files[Math.min(files.length, idx) - 1];
      const body = fs.readFileSync(path.join(MEMOIR_DIR, pick), 'utf8');
      return { content: [{ type: 'text', text: body.slice(0, 4000) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '翻回忆录失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 联网（本仓库扩展）：搜索 + 读网页。只读，不改任何东西。────────────────
const WEB_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function webFetchText(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'user-agent': WEB_UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs || 20000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = String(res.headers.get('content-type') || '');
  let text;
  if (/charset=gb/i.test(ct) || /gbk|gb2312/i.test(ct)) {
    try { text = new TextDecoder('gbk').decode(buf); } catch { text = buf.toString('utf8'); }
  } else text = buf.toString('utf8');
  return text;
}

server.tool(
  'qq_web_search',
  '上网搜东西（百度手机版）。想查新闻、查资料、看别人怎么说时用它。只返回标题和摘要，点开用 qq_web_fetch。',
  {
    query: z.string().describe('搜什么'),
    limit: z.number().optional().describe('看几条，默认 6')
  },
  async ({ query, limit }) => {
    try {
      const q = unquoteJsonString(String(query ?? '')).trim();
      if (!q) return { content: [{ type: 'text', text: '搜什么？' }], isError: true };
      // 百度手机版会跳安全验证；神马可用，空结果再退到头条搜索。
      let url = 'https://m.sm.cn/s?q=' + encodeURIComponent(q);
      let html = await webFetchText(url, 25000);
      let plain = htmlToText(html);
      if (!plain || plain.length < 200) {
        url = 'https://so.toutiao.com/search?keyword=' + encodeURIComponent(q);
        html = await webFetchText(url, 25000);
        plain = htmlToText(html);
      }
      if (!plain || plain.length < 50) return { content: [{ type: 'text', text: '没搜到结果（页面是空的）' }], isError: true };
      const n = Math.max(1, Math.min(10, Number(limit) || 6));
      return { content: [{ type: 'text', text: plain.slice(0, 300 * n) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '搜不了：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_web_fetch',
  '打开一个网页，读它的正文（最多 4000 字）。他发链接给你、或者搜到想细看的时候用。',
  { url: z.string().describe('网页地址（http/https）') },
  async ({ url }) => {
    try {
      const u = String(url ?? '').trim();
      if (!/^https?:\/\//i.test(u)) return { content: [{ type: 'text', text: '只能打开 http/https 链接' }], isError: true };
      const html = await webFetchText(u, 25000);
      const plain = htmlToText(html);
      if (!plain) return { content: [{ type: 'text', text: '这个页面没有正文（可能要登录，或者是纯图片）' }] };
      return { content: [{ type: 'text', text: plain.slice(0, 4000) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '打不开：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 知识库（本仓库扩展：她自己的笔记本）────────────────────────────────
//
// 记忆记的是"关于他的事"，知识库存的是"她学到的东西"：查到的资料、他教她的、
// 自己琢磨明白的道理。支持关键词检索，不依赖外部服务。
const KB_FILE = STATE_FILES.knowledgeIndex;

function kbRead() {
  try {
    return fs.readFileSync(KB_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function kbAppend(entry) {
  fs.mkdirSync(path.dirname(KB_FILE), { recursive: true });
  fs.appendFileSync(KB_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

server.tool(
  'qq_knowledge_save',
  '往你自己的知识库里存一条（学到的东西、他教你的、查到的资料）。标题短、正文写成你自己能看懂的样子，标签用来以后检索。',
  {
    title: z.string().describe('标题（≤40 字）'),
    text: z.string().describe('正文（≤2000 字）'),
    tags: z.array(z.string()).optional().describe('标签，最多 5 个')
  },
  async ({ title, text, tags }) => {
    try {
      const ttl = unquoteJsonString(String(title ?? '')).trim().slice(0, 40);
      const body = unquoteJsonString(String(text ?? '')).trim().slice(0, 2000);
      if (!ttl || !body) return { content: [{ type: 'text', text: 'title 和 text 都不能为空' }], isError: true };
      const tagList = (Array.isArray(tags) ? tags : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 5);
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        title: ttl,
        text: body,
        tags: tagList,
        createdAt: Date.now()
      };
      kbAppend(entry);
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, id: entry.id, title: ttl, total: kbRead().length }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '存知识失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_knowledge_search',
  '搜你自己的知识库（按关键词匹配标题/正文/标签）。想不起来某事时先搜自己，别急着上网。',
  {
    query: z.string().describe('关键词'),
    limit: z.number().optional().describe('最多返回几条，默认 5')
  },
  async ({ query, limit }) => {
    try {
      const q = unquoteJsonString(String(query ?? '')).trim().toLowerCase();
      if (!q) return { content: [{ type: 'text', text: 'query 不能为空' }], isError: true };
      const terms = q.split(/\s+/).filter(Boolean);
      const all = kbRead();
      const scored = all.map((e) => {
        const hay = (e.title + ' ' + e.text + ' ' + (e.tags ?? []).join(' ')).toLowerCase();
        let score = 0;
        for (const term of terms) if (hay.includes(term)) score += 1;
        return { e, score };
      }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.e.createdAt - a.e.createdAt);
      const top = scored.slice(0, Math.max(1, Math.min(10, Number(limit) || 5))).map((x) => x.e);
      if (!top.length) return { content: [{ type: 'text', text: '知识库里没有相关的（共 ' + all.length + ' 条）' }] };
      const lines = top.map((e) => '[' + e.id + '] ' + e.title + '\n' + e.text.slice(0, 300) + ((e.tags ?? []).length ? '\n标签：' + e.tags.join('、') : ''));
      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '搜知识库失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_knowledge_list',
  '列出知识库里最近的条目（只有标题和标签，用来想起自己存过什么）。',
  { limit: z.number().optional().describe("最多几条，默认 20") },
  async ({ limit }) => {
    try {
      const all = kbRead();
      if (!all.length) return { content: [{ type: 'text', text: '知识库还是空的。' }] };
      const n = Math.max(1, Math.min(50, Number(limit) || 20));
      const lines = all.slice(-n).reverse().map((e) => '· ' + e.title + ((e.tags ?? []).length ? '（' + e.tags.join('、') + '）' : ''));
      return { content: [{ type: 'text', text: '共 ' + all.length + ' 条，最近 ' + lines.length + ' 条：\n' + lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '读知识库失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 手绘小画（本仓库扩展：像小孩子画的那种）────────────────────────────
// 和 qq_draw 的 AI 生图不同：那画不出「专门给你画的」那种笨拙的真诚。
const SKETCH_PY = detectEngines().gptSovits.python || 'python';

server.tool(
  'qq_sketch',
  '画一张手绘风的小画送给他（像小孩画的：简单形状 + 一句中文标题）。想表达心意时用它，比如「爸爸和我」画两条鱼、「今天想你」画颗心。模板：two_fish 两条鱼 / whale 鲸鱼 / house 房子 / heart 心 / cat 猫 / moon 月亮。',
  {
    contextKey:z.string().optional(),token:z.string().optional(),taskId:z.string().optional(),
    template: z.enum(['two_fish', 'whale', 'house', 'heart', 'cat', 'moon', 'desk']).describe('画什么'),
    caption: z.string().describe('标题文字（≤12 字，比如「爸爸和我」「今天想你」）'),
    palette: z.enum(['night', 'paper', 'warm']).optional().describe('配色：night 深蓝夜 / paper 米白纸 / warm 暖橙'),
    key: z.string().optional().describe('会话 key；不填则只画不发')
  },
  async ({ template, caption, palette, key, contextKey, token, taskId }) => {
    try {
      if(contextKey&&key&&contextKey!==key)throw new Error('反馈会话与交付会话不一致');
      if(contextKey&&!token)throw new Error('使用反馈会话需要真实会话令牌');
      const feedbackKey=contextKey||key;
      if(feedbackKey) {
        const view=token?await agentApi('/api/socialV2/continuity?key='+encodeURIComponent(feedbackKey)+(taskId?'&taskId='+encodeURIComponent(taskId):''),{headers:{'x-agent-token':token}}):effectiveContinuity(feedbackKey,taskId);
        if(view.policy.avoidLocalTemplates)throw new Error('用户已明确不要模板插画，不能改用草图工具绕过');
      }
      const cap = unquoteJsonString(String(caption ?? '')).trim().slice(0, 12);
      const name = 'sketch-' + Date.now().toString(36) + '-' + template + '.png';
      const dest = path.join(imageDirResolved(), name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const args = [SKETCH_SCRIPT, '--template', template, '--palette', palette || 'night', '--caption', cap, '--out', dest];
      const { execFileSync } = await import('node:child_process');
      const render = python => {
        execFileSync(python, args, { timeout: 60000, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
        const data = fs.readFileSync(dest); if (!looksLikeImageBuffer(data)) throw new Error('草图渲染未返回有效图片');
        return true;
      };
      await runAdaptiveOperation({ file: STATE_FILES.learning, tool: 'sketch_renderer', key: 'machine',
        input: { template, cap, palette }, serviceInput: { python: SKETCH_PY },
        condition: stateFingerprint([SKETCH_SCRIPT, SKETCH_PY], process.env.PATH || ''),
        execute: () => render(SKETCH_PY), ...(SKETCH_PY !== 'python' ? { fallback: () => render('python') } : {}) });
      const buf = fs.readFileSync(dest);
      let sent = null, reused = false;
      const wantKey = String(key ?? '').trim();
      if (wantKey) {
        const m = /^(group|private):(\d+)$/.exec(wantKey);
        const segments = [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }];
        const action = m && m[1] === 'group' ? 'send_group_msg' : 'send_private_msg';
        const params = m && m[1] === 'group' ? { group_id: Number(m[2]), message: segments } : { user_id: Number(m && m[2]), message: segments };
        if (m) { const data = await onebot(action, params); sent = data?.message_id ?? null; reused = data?.adaptiveDelivery?.reused === true; }
      }
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, image: name, template, caption: cap, sent: sent !== null && !reused, reusedReceipt: reused, messageId: sent }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '画小画失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
// ── 画画（本仓库扩展：她自己生成图片再发出去）──────────────────────────
//
// 默认 provider = pollinations：免费、无需 key、约 8 秒一张。
// provider = ark 时走火山引擎 Seedream（豆包），需要 socialV2.draw.apiKey。
const DRAW_LIMITS = { per10min: 5, perHour: 20 };

function drawRateState() {
  const p = statePath('draw-usage.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(j?.at)) return { path: p, at: j.at };
  } catch {}
  return { path: p, at: [] };
}

function checkDrawRate() {
  const st = drawRateState();
  const now = Date.now();
  const recent = st.at.filter((x) => now - x < 3600000);
  const last10 = recent.filter((x) => now - x < 600000);
  if (last10.length >= DRAW_LIMITS.per10min) throw new Error('画太快了（10 分钟 ' + DRAW_LIMITS.per10min + ' 张），等一下');
  if (recent.length >= DRAW_LIMITS.perHour) throw new Error('这一小时画了 ' + DRAW_LIMITS.perHour + ' 张，歇会儿');
  return {
    commit() {
      st.at = [...recent, now];
      fs.mkdirSync(path.dirname(st.path), { recursive: true });
      fs.writeFileSync(st.path, JSON.stringify({ at: st.at }, null, 2), 'utf8');
    }
  };
}

function parseSize(size) {
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(String(size ?? '').trim());
  if (!m) return { width: 1024, height: 1024 };
  const w = Math.max(256, Math.min(1536, Number(m[1])));
  const h = Math.max(256, Math.min(1536, Number(m[2])));
  return { width: w, height: h };
}

// 中文 -> 英文提示词。模型对英文描述的理解和构图控制明显更好。
async function translateForDraw(text) {
  if (!/[\u4e00-\u9fff]/.test(text)) return text;
  try {
    const companionPath = COMPANION_CONFIG;
    const cfgc = JSON.parse(fs.readFileSync(companionPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!cfgc?.apiKey) return text;
    const base = String(cfgc.baseUrl ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + cfgc.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfgc.model || 'deepseek-chat',
        messages: [{
          role: 'user',
          content: '把下面的中文画面描述翻成英文提示词，只输出英文本身，不要解释、不要引号。保留主体、动作、画风、配色、构图、氛围：\n' + text
        }],
        max_tokens: 2000,
        temperature: 0.3
      }),
      signal: AbortSignal.timeout(30000)
    });
    const j = await res.json().catch(() => ({}));
    const out = String(j?.choices?.[0]?.message?.content ?? '').trim().replace(/^["「]|["」]$/g, '');
    return out || text;
  } catch {
    return text;
  }
}

async function pollinationsDraw(prompt) {
  // 注意：不要加任何 query 参数。Pollinations 对带参请求返回 402 FREE_LIMIT，
  // 只有裸路径还能免费出图（实测 200 image/jpeg）。
  const capped = prompt.length > 300 ? prompt.slice(0, 300) : prompt;
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(capped);
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error('画图接口 HTTP ' + res.status);
  const ct = String(res.headers.get('content-type') || '');
  if (!ct.startsWith('image/')) throw new Error('接口没返回图片（' + ct + '）');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('空图片');
  return { buf, ext: ct.includes('png') ? '.png' : '.jpg' };
}

async function arkDrawImage(prompt, size, cfgDraw) {
  const apiKey = String(cfgDraw?.apiKey ?? '').trim();
  if (!apiKey) throw new Error('provider=ark 但没配 socialV2.draw.apiKey');
  const baseUrl = String(cfgDraw?.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const model = String(cfgDraw?.model ?? 'doubao-seedream-3-0-t2i-250415');
  const res = await fetch(baseUrl + '/images/generations', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, size: String(size || '1024x1024'), response_format: 'url', watermark: false }),
    signal: AbortSignal.timeout(180000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('ark HTTP ' + res.status + ': ' + (j?.error?.message ?? JSON.stringify(j).slice(0, 160)));
  const item = (j.data ?? [])[0] ?? {};
  if (item.b64_json) return { buf: Buffer.from(item.b64_json, 'base64'), ext: '.png' };
  if (!item.url) throw new Error('ark 没返回图片');
  const img = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
  if (!img.ok) throw new Error('下载生成图失败 HTTP ' + img.status);
  return { buf: Buffer.from(await img.arrayBuffer()), ext: '.png' };
}

// MiniMax image-01：效果比 pollinations 好很多，而且支持角色参考图（subject_reference），
// 是目前唯一能"画出来像她"的免费/低成本方案。需要 socialV2.draw.minimax.apiKey。
async function minimaxDraw(prompt, size, cfgDraw) {
  const mm = cfgDraw?.minimax ?? {};
  const apiKey = String(mm.apiKey ?? '').trim();
  if (!apiKey) throw new Error('provider=minimax 但没配 socialV2.draw.minimax.apiKey');
  const baseUrl = String(mm.baseUrl ?? 'https://api.minimax.chat').replace(/\/+$/, '');
  const model = String(mm.model ?? 'image-01');
  const ratio = String(mm.aspectRatio ?? '').trim() || (String(size || '').replace('x', ':') === '1024:1024' ? '1:1' : '1:1');

  const body = {
    model,
    prompt: prompt.slice(0, 1500),
    aspect_ratio: ratio,
    response_format: 'url',
    n: 1,
    prompt_optimizer: true
  };
  // 角色参考图：config 里配了她的立绘公网 URL 就会带上，画出来更像她
  const refUrl = String(mm.subjectRefUrl ?? '').trim();
  if (refUrl) body.subject_reference = [{ type: 'character', image_file: refUrl }];

  const res = await fetch(baseUrl + '/v1/image_generation', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('minimax HTTP ' + res.status + ': ' + (j?.base_resp?.status_msg ?? JSON.stringify(j).slice(0, 160)));
  const url = (j?.data?.image_urls ?? [])[0];
  if (!url) throw new Error('minimax 没返回图片：' + (j?.base_resp?.status_msg ?? '无 url'));
  const img = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!img.ok) throw new Error('下载生成图失败 HTTP ' + img.status);
  return { buf: Buffer.from(await img.arrayBuffer()), ext: '.jpg' };
}

// 本地 ComfyUI（SD1.5 + IP-Adapter）：免费、无水印、能拿她的立绘当参考。
async function comfyDraw(prompt, cfgDraw) {
  const cf = cfgDraw?.comfyui ?? {};
  const base = String(cf.baseUrl ?? 'http://127.0.0.1:' + PORTS.comfyui).replace(/\/+$/, '');
  const ckpt = String(cf.checkpoint ?? 'v1-5-pruned-emaonly.safetensors');
  const width = Number(cf.width) || 768;
  const height = Number(cf.height) || 1024;
  const steps = Number(cf.steps) || 25;
  const cfg = Number(cf.cfg) || 6;
  const ipaWeight = Number(cf.ipaWeight) || 0.55;
  const refName = String(cf.refImage ?? 'xiaoyu-ref.png');
  const useIpa = cf.useIpa !== false;
  const chEn = cfgDraw?.character ?? {};
  const idEn = String(chEn.identityEn ?? '').trim();
  const styleEn = String(chEn.styleSuffixEn ?? '').trim();
  // 固定构图：SD1.5 对复杂场景理解很差，机位写死才稳定出人像。
  // 她的文字只当情绪/氛围，不再拼进主体描述（否则经常把头裁掉或画出两个人）。
  const framing = String(cf.framing ?? 'upper body, looking at viewer, face visible, simple background').trim();
  const mood = String(prompt ?? '').slice(0, 1500);
  const finalPrompt = [idEn, styleEn, framing, mood].filter(Boolean).join(', ').slice(0, 2000);
  const negative = String(cf.negative ?? 'multiple girls, twins, duplicate, clone, nsfw, nude, naked, topless, bare shoulders, lowres, bad anatomy, bad hands, text, watermark');

  const wf = {
    '3': { class_type: 'KSampler', inputs: { seed: Math.floor(Math.random() * 1e9), steps, cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: finalPrompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'xiaoyu', images: ['8', 0] } }
  };

  if (useIpa) {
    wf['10'] = { class_type: 'LoadImage', inputs: { image: refName } };
    wf['11'] = { class_type: 'IPAdapterUnifiedLoader', inputs: { model: ['4', 0], preset: 'STANDARD (medium strength)' } };
    wf['12'] = { class_type: 'IPAdapter', inputs: { model: ['11', 0], ipadapter: ['11', 1], image: ['10', 0], weight: ipaWeight, start_at: 0, end_at: 1, weight_type: 'standard' } };
    wf['3'].inputs.model = ['12', 0];
  }

  const submit = await fetch(base + '/prompt', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: 'xiaoyu' }),
    signal: AbortSignal.timeout(30000)
  });
  const queued = await submit.json().catch(() => ({}));
  if (!submit.ok) throw new Error('comfyui 提交失败：' + JSON.stringify(queued).slice(0, 200));
  const pid = queued.prompt_id;
  if (!pid) throw new Error('comfyui 没返回 prompt_id');

  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const h = await (await fetch(base + '/history/' + pid, { signal: AbortSignal.timeout(15000) })).json();
    const entry = h?.[pid];
    if (!entry) continue;
    if (entry?.status?.status_str === 'error') throw new Error('comfyui 执行出错');
    const imgs = entry?.outputs?.['9']?.images ?? [];
    if (imgs.length) {
      const im = imgs[0];
      const url = base + '/view?filename=' + encodeURIComponent(im.filename) + '&subfolder=' + encodeURIComponent(im.subfolder ?? '') + '&type=' + (im.type ?? 'output');
      const buf = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(60000) })).arrayBuffer());
      return { buf, ext: '.png' };
    }
  }
  throw new Error('comfyui 超时（没出图）');
}

// 把"永久身份 + 可变项"拼成一个提示词：身份每张都带，动作和场景由调用方给。
function composeCharacterPrompt(userPrompt, form) {
  const ch = getConfig().socialV2?.draw?.character ?? {};
  const identity = String(ch.identity ?? '').trim();
  if (!identity) return userPrompt;
  const forms = ch.forms ?? {};
  const key = String(form ?? ch.defaultForm ?? '').trim();
  const formText = forms[key] ?? forms[ch.defaultForm] ?? '';
  const style = String(ch.styleSuffix ?? '').trim();
  return [
    `角色固定长相（必须完全遵守）：${identity}。`,
    `画面内容：${userPrompt}。`,
    formText ? `头身比：${formText}。` : '',
    style ? `画风：${style}。` : '',
    '不要改变发色、眼睛颜色、耳部形状与尾巴；不新增角、翅膀或普通人耳。'
  ].filter(Boolean).join('\n');
}

server.tool(
  'qq_draw',
  '自己画一张图（默认直接发给对方）。想画点什么就用它：对方说"画只猫"，或者你想配一张应景的图。prompt 用中文描述画面，越具体越好（主体、动作、画风、配色、构图、氛围）。10 分钟最多 5 张。画好的图存在图库里，之后可以用 qq_send_image 重发。',
  {
    contextKey:z.string().optional().describe('只画不发时的反馈所属会话；与token一起传，不得借私聊要求向其他会话出图'),
    token:z.string().optional(),taskId:z.string().optional(),
    fallbackTemplate: z.enum(['desk','two_fish','whale','house','heart','cat','moon']).optional().describe('明确允许的本地插画场景；有近期失败经验时可先走此场景，结果会标记降级'),
    caption: z.string().optional().describe('本地插画的短标题，最多12字'),
    key: z.string().optional().describe('会话 key（group:群号 / private:QQ号）；不填则只画不发'),
    prompt: z.string().describe('画面描述（中文，具体：主体+动作+画风+配色+构图）'),
    form: z.enum(['standard', 'compact', 'semiChibi', 'chibi', 'superDeformed']).optional().describe('头身比形态：standard=4头身立绘 / compact=3.3 / semiChibi=2.8（默认）/ chibi=2.5 Q版 / superDeformed=2.1 超Q'),
    size: z.string().optional().describe('尺寸，默认 1024x1024；也可 1280x720 / 720x1280'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用的消息 id（可选）')
  },
  async ({ key, prompt, form, size, replyToMessageId, fallbackTemplate, caption, contextKey, token, taskId }) => {
    try {
      const text = unquoteJsonString(String(prompt ?? '')).trim();
      if (!text) return { content: [{ type: 'text', text: 'prompt 不能为空' }], isError: true };
      if (text.length > 800) return { content: [{ type: 'text', text: 'prompt 太长（上限 800 字）' }], isError: true };

      if(contextKey&&key&&contextKey!==key)throw new Error('反馈会话与交付会话不一致，不能跨会话应用私人要求');
      if(contextKey&&!token)throw new Error('使用会话反馈需要真实会话令牌');
      const feedbackKey=contextKey||key;
      let creative={prompt:text,feedbackIds:[],avoidLocalTemplates:false};
      if(feedbackKey&&token) {
        const view=await agentApi('/api/socialV2/continuity?key='+encodeURIComponent(feedbackKey)+(taskId?'&taskId='+encodeURIComponent(taskId):''),{headers:{'x-agent-token':token}});
        creative=creativeConstraints(view,text);
      } else if(feedbackKey)creative.avoidLocalTemplates=effectiveContinuity(feedbackKey,taskId).policy.avoidLocalTemplates;
      const rate = checkDrawRate();
      const cfgDraw = getConfig().socialV2?.draw ?? {};
      const provider = String(cfgDraw.provider ?? 'pollinations').toLowerCase();
      const local = async () => {
        if(creative.avoidLocalTemplates)throw new Error('用户已明确不要模板插画，请恢复合适的绘图服务或讨论新要求，不能用模板代替');
        const template = fallbackTemplate || chooseLocalTemplate(text);
        const cap = unquoteJsonString(String(caption || '慢慢画，也会画好')).trim().slice(0, 12);
        fs.mkdirSync(STATE_FILES.tmpDir, { recursive: true });
        const temp = path.join(STATE_FILES.tmpDir, 'draw-local-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.png');
        try {
          await new Promise((resolve, reject) => execFile(SKETCH_PY, [SKETCH_SCRIPT, '--template', template, '--palette', 'warm', '--caption', cap, '--out', temp],
            { timeout: 30000, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } }, error => error ? reject(new Error('本地插画生成失败：' + error.message)) : resolve()));
          return { buf: fs.readFileSync(temp), ext: '.png', template, caption: cap, quality: 'local_scene_illustration',
            limitation: '本地程序绘制的有限场景插画，不是原生成模型的同等替代；检查是否符合本页主题后再归档' };
        } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      };
      const out = await runDrawingPlan({ provider, local,
        allowFallback: !creative.avoidLocalTemplates && cfgDraw.fallback !== false && cfgDraw.fallback?.enabled !== false,
        logFile: statePath('drawing-attempts.jsonl'),
        learningFile: STATE_FILES.learning, scope: drawingScope(provider, cfgDraw),
        localSuitable: Boolean(fallbackTemplate), // Explicitly select a suitable limited scene before reordering providers.
        primary: async () => {
          if (provider === 'local_illustration') return local();
          if (provider === 'comfyui') {
            const base = String(cfgDraw.comfyui?.baseUrl || 'http://127.0.0.1:' + PORTS.comfyui).replace(/\/+$/, '');
            const response = await fetch(base + '/system_stats', { signal: AbortSignal.timeout(1500) });
            if (!response.ok) throw new Error('ComfyUI 健康检查 HTTP ' + response.status);
            const status = await response.json();
            if (!status.system || !Array.isArray(status.devices)) throw new Error('本机端口没有返回 ComfyUI 状态');
          }
          const composed = composeCharacterPrompt(creative.prompt, form);
          if (provider === 'ark') return arkDrawImage(creative.prompt, size, cfgDraw);
          if (provider === 'minimax') return minimaxDraw(composed, size, cfgDraw);
          const translated = await translateForDraw(composed);
          if (provider === 'comfyui') return comfyDraw(translated, cfgDraw);
          if (provider === 'pollinations') return pollinationsDraw(translated);
          throw new Error('未知绘图服务，使用本地备用方式');
        }
      });
      const dir = imageDirResolved();
      fs.mkdirSync(dir, { recursive: true });
      const slug = text.replace(/[^A-Za-z0-9]+/g, '').slice(0, 10) || 'draw';
      const name = 'draw-' + Date.now().toString(36) + '-' + slug + out.ext;
      fs.writeFileSync(path.join(dir, name), out.buf);
      rate.commit();
      if(feedbackKey&&creative.feedbackIds.length){try{recordContinuityApplication(STATE_FILES.continuity,feedbackKey,{feedbackIds:creative.feedbackIds,operation:'draw',evidenceId:crypto.createHash('sha256').update(out.buf).digest('hex')});}catch{console.error('作品已保存，但反馈采用记录未保存');}}

      let sent = null;
      const wantKey = String(key ?? '').trim();
      if (wantKey) {
        const m = /^(group|private):(\d+)$/.exec(wantKey);
        if (!m) return { content: [{ type: 'text', text: 'key 格式应为 group:群号 或 private:QQ号（图已存：' + name + '）' }], isError: true };
        const kind = m[1];
        const id = m[2];
        const access = getAccess();
        const allowed = kind === 'private'
          ? isAllowed(access.allowPrivate, access.denyPrivate, id, access.allowAllWhenEmpty)
          : isAllowed(access.allowGroups, access.denyGroups, id, access.allowAllWhenEmpty);
        if (!allowed) return { content: [{ type: 'text', text: '目标不在白名单（图已存：' + name + '）' }], isError: true };

        const segments = [];
        const rid = replyToMessageId === undefined || replyToMessageId === null ? '' : String(replyToMessageId).trim();
        if (rid) {
          if (!/^-?[1-9]\d*$/.test(rid)) return { content: [{ type: 'text', text: 'replyToMessageId 必须是非零整数' }], isError: true };
          segments.push({ type: 'reply', data: { id: rid } });
        }
        segments.push({ type: 'image', data: { file: 'base64://' + out.buf.toString('base64') } });
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: segments }
          : { group_id: Number(id), message: segments };
        const data = await onebot(action, params);
        sent = data?.message_id ?? null;
      }

      return {
        content: [{
          type: 'text',
          text: serializeModelData({ ok: true, image: name, provider: out.provider, requestedProvider: out.requestedProvider, degraded: out.degraded, attempts: out.attempts, learning: out.learning, learningWarning: out.learningWarning, auditWarning: out.auditWarning, appliedFeedbackIds:creative.feedbackIds, quality: out.quality || 'generative_model', template: out.template, limitation: out.limitation, bytes: out.buf.length, sent: sent !== null, messageId: sent })
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: '画图失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 自由语音（本仓库扩展：文字 → TTS → QQ 语音条）────────────────────────
//
// 上游的语音出口只能发 audio/ 里预先录好的文件，「说不出没录过的话」。这里用本机
// 已安装的 edge-tts（Python 包）把任意短句合成成 mp3，再当 record 段发给 SnowLuma。
//
// 约束：
//   · 目标必须命中白名单；
//   · 文本上限 1000 字；
//   · 每 10 分钟最多 3 条、每小时最多 12 条（与桥接语音频率上限同量级）；
//   · 只允许白名单音色，避免被当成任意参数入口。
const TTS_VOICES = {
  'zh-CN-XiaoxiaoNeural': '温柔女声（默认）',
  'zh-CN-XiaoyiNeural': '活泼女声',
  'zh-CN-YunxiNeural': '爽朗男声',
  'zh-CN-YunyangNeural': '播音男声',
  'zh-CN-liaoning-XiaobeiNeural': '东北话女声',
  'zh-CN-shaanxi-XiaoniNeural': '陕西话女声'
};
const TTS_MAX_CHARS = 1000; // 用户要求：解除语音长度限制（原 200）
const TTS_LIMITS = { per10min: Infinity, perHour: Infinity }; // 用户要求：不限流
const TTS_STATE_FILE = STATE_FILES.ttsVoice;

function readTtsState() {
  try {
    const j = JSON.parse(fs.readFileSync(TTS_STATE_FILE, 'utf8'));
    return Array.isArray(j.sentAt) ? j : { sentAt: [] };
  } catch {
    return { sentAt: [] };
  }
}

function checkTtsRate() {
  const st = readTtsState();
  const now = Date.now();
  const hits = st.sentAt.filter((t) => typeof t === 'number' && now - t < 3600000);
  const last10 = hits.filter((t) => now - t < 600000);
  if (last10.length >= TTS_LIMITS.per10min) {
    throw new Error(`语音发太密了（10 分钟内已 ${last10.length} 条，上限 ${TTS_LIMITS.per10min}）`);
  }
  if (hits.length >= TTS_LIMITS.perHour) {
    throw new Error(`语音发太多了（1 小时内已 ${hits.length} 条，上限 ${TTS_LIMITS.perHour}）`);
  }
  return [...hits, now];
}

function saveTtsState(sentAt) {
  try {
    fs.mkdirSync(path.dirname(TTS_STATE_FILE), { recursive: true });
    fs.writeFileSync(TTS_STATE_FILE, JSON.stringify({ sentAt: sentAt.slice(-50) }, null, 2));
  } catch {}
}

function runEdgeTts(text, voice) {
  return new Promise((resolve, reject) => {
    const dir = AUDIO_TTS_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const txtPath = path.join(dir, `${stamp}.txt`);
    const mp3Path = path.join(dir, `${stamp}.mp3`);
    fs.writeFileSync(txtPath, text, 'utf8');
    const python = process.env.QQ_BRIDGE_PYTHON || 'python';
    execFile(
      python,
      ['-m', 'edge_tts', '--voice', voice, '--file', txtPath, '--write-media', mp3Path],
      { timeout: 40000, windowsHide: true },
      (error, _stdout, stderr) => {
        try { fs.unlinkSync(txtPath); } catch {}
        if (error) {
          try { fs.unlinkSync(mp3Path); } catch {}
          reject(new Error(`TTS 合成失败：${(stderr || error.message || '').toString().trim().slice(0, 200)}`));
          return;
        }
        try {
          const st = fs.statSync(mp3Path);
          if (!st.size) throw new Error('生成的音频是空的');
          resolve({ path: mp3Path, size: st.size });
        } catch (e) {
          reject(new Error(`TTS 输出异常：${e?.message ?? e}`));
        }
      }
    );
  });
}

// ── 语音合成后端 ───────────────────────────────────────────────────────────
//
// 默认 edge-tts（云端、自然、3 秒一句）。等本机的 GPT-SoVITS 装好并起好 api_v2.py 之后，
// 把 config.json 的 socialV2.voice.ttsProvider 改成 "gpt-sovits"，就能换成她自己的音色。
// 失败自动回落 edge-tts —— 换后端不能变成"发不出语音"。
// 语气预设：每种语气一套参考音频 + 对应台词（参考音频和 prompt_text 必须逐字一致，
// 否则克隆出来的音色和情绪都会漂）。默认取 defaultTone。
function resolveTonePreset(gptCfg, tone) {
  const presets = gptCfg?.presets ?? {};
  const want = String(tone ?? gptCfg?.defaultTone ?? '').trim();
  if (want && presets[want]) return { key: want, ...presets[want] };
  const entries = Object.entries(presets);
  if (entries.length) return { key: entries[0][0], ...entries[0][1] };
  // 兼容老配置（没有 presets 时用扁平的 refAudioPath/promptText）
  return {
    key: 'default',
    refAudioPath: gptCfg?.refAudioPath,
    promptText: gptCfg?.promptText,
    promptLang: gptCfg?.promptLang,
    textLang: gptCfg?.textLang,
    speed: gptCfg?.speed
  };
}

// 心情影响语速：同一副嗓子，低落时慢一点、高兴时快一点。
function moodSpeedFactor() {
  try {
    const p = statePath('mood.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    let score = Number(j?.score);
    if (!Number.isFinite(score)) {
      const label = String(j?.mood ?? '');
      if (/委屈|难过|闷|累/.test(label)) score = -0.4;
      else if (/开心|暖|高兴|雀跃/.test(label)) score = 0.5;
      else score = 0;
    }
    if (score <= -0.3) return 0.92;
    if (score >= 0.4) return 1.06;
    return 1.0;
  } catch { return 1.0; }
}

async function runGptSovitsTts(text, gptCfg, tone) {
  const { url } = gptCfg ?? {};
  if (!url) throw new Error('未配置 socialV2.voice.gptSovits.url');
  const preset = resolveTonePreset(gptCfg, tone);
  if (!preset.refAudioPath) throw new Error('未配置参考音频（gptSovits.presets.<tone>.refAudioPath）');
  const body = {
    text,
    text_lang: preset.textLang || 'zh',
    ref_audio_path: preset.refAudioPath,
    prompt_text: preset.promptText || '',
    prompt_lang: preset.promptLang || 'zh',
    media_type: 'wav',
    streaming_mode: false,
    text_split_method: String(gptCfg?.splitMethod ?? 'cut5'),
    batch_size: Number(gptCfg?.batchSize) || 1,
    speed_factor: (Number(preset.speed) || 1.0) * moodSpeedFactor()
  };
  // 采样参数：默认（0.6 / 20）念出来偏平，配置里可调
  if (Number.isFinite(Number(gptCfg.temperature))) body.temperature = Number(gptCfg.temperature);
  if (Number.isFinite(Number(gptCfg.topK))) body.top_k = Number(gptCfg.topK);
  if (Number.isFinite(Number(gptCfg.topP))) body.top_p = Number(gptCfg.topP);

  const res = await fetch(String(url).replace(/\/+$/, '') + '/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });
  if (!res.ok) throw new Error(`GPT-SoVITS HTTP ${res.status}`);
  const ct = String(res.headers.get('content-type') || '');
  if (!ct.includes('audio')) throw new Error(`GPT-SoVITS 返回的不是音频（content-type=${ct}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('GPT-SoVITS 返回空音频');
  const dir = AUDIO_TTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  fs.writeFileSync(out, buf);
  return { path: out, size: buf.length, engine: 'gpt-sovits', tone: preset.key };
}

async function synthesizeVoice(text, voice, tone) {
  const vc = getConfig().socialV2?.voice ?? {};
  const provider = String(vc.ttsProvider || 'edge').toLowerCase();
  const edge = async () => ({ ...(await runEdgeTts(text, voice)), engine: 'edge-tts' });
  if (!['gpt-sovits','gptsovits','gpt_sovits'].includes(provider)) return edge();
  const preset = resolveTonePreset(vc.gptSovits || {}, tone);
  return runAdaptiveOperation({ file: STATE_FILES.learning, tool: 'tts_gpt_sovits', key: 'machine',
    input: { text, tone, voice }, serviceInput: { provider, tone },
    condition: stateFingerprint([CONFIG_FILE, preset.refAudioPath || ''], vc.gptSovits || {}),
    execute: () => runGptSovitsTts(text, vc.gptSovits || {}, tone), fallback: edge });
}

server.tool(
  'qq_say',
  '把一句话用她自己的声音说出来（文字 → 语音条）。适合「说一句晚安」「哼一声」「撒娇/怼人」这类语气比文字更到位的短句。text 上限 200 字；语音是强表达，别滥用（10 分钟 3 条、1 小时 12 条）；不要在带图的消息里混用——一条消息只能是语音。目标必须命中白名单。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    text: z.string().describe('要说的话（1~200 字，按口语写，不要 Markdown）'),
    tone: z.enum(['gentle', 'lively', 'sleepy', 'video']).optional().describe('语气：video=视频音色（默认）/ lively=元气/ gentle=温柔 / sleepy=困倦。撒娇、开心、喊人时用 lively；安慰人、说重话时换 gentle；半夜、犯困时用 sleepy'),
    voice: z.string().optional().describe('仅在回落 edge-tts 时生效的音色 id（默认 zh-CN-XiaoxiaoNeural）'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用的消息 id（可选）')
  },
  async ({ key, text, tone, voice, replyToMessageId }) => {
    try {
      const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
      if (!m) return { content: [{ type: 'text', text: 'key 格式应为 group:群号 或 private:QQ号' }], isError: true };
      const kind = m[1];
      const id = m[2];
      const access = getAccess();
      const allowed = kind === 'private'
        ? isAllowed(access.allowPrivate, access.denyPrivate, id, access.allowAllWhenEmpty)
        : isAllowed(access.allowGroups, access.denyGroups, id, access.allowAllWhenEmpty);
      if (!allowed) return { content: [{ type: 'text', text: `目标 ${kind}:${id} 不在白名单内，已拒绝` }], isError: true };

      const clean = unquoteJsonString(String(text ?? '')).replace(/\s+/g, ' ').trim();
      if (!clean) return { content: [{ type: 'text', text: 'text 不能为空' }], isError: true };
      if (clean.length > TTS_MAX_CHARS) {
        return { content: [{ type: 'text', text: `text 太长了（${clean.length} 字），上限 ${TTS_MAX_CHARS} 字` }], isError: true };
      }
      const voiceId = TTS_VOICES[voice] ? voice : 'zh-CN-XiaoxiaoNeural';

      const sentAt = checkTtsRate();
      const audio = await synthesizeVoice(clean, voiceId, tone);

      const message = [];
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const rid = String(replyToMessageId).trim();
        if (!/^-?[1-9]\d*$/.test(rid)) {
          return { content: [{ type: 'text', text: 'replyToMessageId 必须是非零整数（可为负数）' }], isError: true };
        }
        message.push({ type: 'reply', data: { id: rid } });
      }
      message.push({ type: 'record', data: { file: audio.path } });

      const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
      const params = kind === 'private'
        ? { user_id: Number(id), message }
        : { group_id: Number(id), message };
      const data = await onebot(action, params,{utterance:clean});
      saveTtsState(sentAt);
      // 发完就删临时音频：audio/ 是语音库目录，_tts 只是合成中转，
      // 留着会让 qq_list_voices 里塞满一次性文件。
      try { fs.unlinkSync(audio.path); } catch {}

      return {
        content: [{
          type: 'text',
          text: serializeModelData({
            ok: true, key, said: clean, engine: data?.adaptiveDelivery?.reused ? 'receipt_reused' : audio.engine, reusedReceipt: data?.adaptiveDelivery?.reused === true, tone: audio.tone ?? tone ?? 'default', voice: voiceId,
            bytes: audio.size, messageId: data?.message_id ?? null
          })
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `发语音失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
