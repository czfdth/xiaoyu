// src/paths.js — 小鱼的**唯一路径来源**。
//
// 以前同一个路径散落在四个地方（bridge.js / mcp-*.js / bin\start-all.ps1 / gui\server.mjs），
// 每一份都写死 `C:\Users\best\...`：换一台机器、换一个盘、或者把包挪到别的目录，
// 就有一半功能静默失效（工具还在，但读写的是老路径）。
//
// 现在的规则：
//   · 所有「从哪来」的判断只写在这一个文件里；
//   · 其它模块只 import 常量，不再自己拼 `..`、不再认盘符；
//   · 启动脚本（ps1 / mjs）统一调 `node src/paths.js --json` 拿同一份结果。
//
// 三件事在这一文件里收敛：
//   ① 目录：包根、state、logs、roles、images、audio、scripts……
//   ② 引擎：SnowLuma / GPT-SoVITS / ComfyUI / RVC / ffmpeg 在哪（探测 + 可被 config 覆盖）
//   ③ 首次运行：没有 config.json 就按 config.example.json 生成一份，并把探测到的引擎路径填进去
//
// 只依赖 Node 内置模块，可以在没装 node_modules 的情况下直接跑：
//   node src/paths.js            # 人看的摘要
//   node src/paths.js --json     # 给脚本解析
//   node src/paths.js --init     # 建目录 + 生成 config.json（幂等）
//   node src/paths.js --check    # 自检，缺东西时退出码 1

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 代码根 / 数据根 ─────────────────────────────────────────────────────────
// 默认两者相同（便携版就是一个目录）。分开是为了「接别人的数据跑」：
//   XIAOYU_HOME=<数据目录>  node <代码目录>/src/bridge.js
// 代码（src/scripts/dsh/plugins/public/assets/engines）永远跟着文件走；
// 数据（config/state/roles/images/audio）跟着 XIAOYU_HOME 走。
export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CODE_ROOT = path.resolve(SRC_DIR, '..');
export const APP_ROOT = process.env.XIAOYU_HOME
  ? path.resolve(process.env.XIAOYU_HOME)
  : CODE_ROOT;

// 她的数据（state/logs）默认跟着数据根走；XIAOYU_DATA 可以再单独放（例如放 D 盘）。
// 注意：程序升级不碰 state/ —— 她的记忆不能因为换版本就没了。
export const DATA_DIR = process.env.XIAOYU_DATA
  ? path.resolve(process.env.XIAOYU_DATA)
  : APP_ROOT;

export const CONFIG_FILE = path.join(APP_ROOT, 'config.json');
export const CONFIG_EXAMPLE_FILE = path.join(CODE_ROOT, 'config.example.json');

export const STATE_DIR = process.env.XIAOYU_STATE ? path.resolve(process.env.XIAOYU_STATE) : path.join(DATA_DIR, 'state');
export const LOGS_DIR = process.env.XIAOYU_LOGS ? path.resolve(process.env.XIAOYU_LOGS) : path.join(DATA_DIR, 'logs');

// 这些是「她的东西」：跟着数据根，换程序版本不应该换掉。
export const ROLES_DIR = path.join(APP_ROOT, 'roles');
export const IMAGES_DIR = path.join(APP_ROOT, 'images');
export const AUDIO_DIR = path.join(APP_ROOT, 'audio');
// 这些是「程序的零件」：跟着代码根。
export const ASSETS_DIR = path.join(CODE_ROOT, 'assets');
export const SCRIPTS_DIR = path.join(CODE_ROOT, 'scripts');
export const DSH_DIR = path.join(CODE_ROOT, 'dsh');
export const PRESETS_DIR = path.join(DSH_DIR, 'agent-presets');
export const PLUGINS_DIR = path.join(CODE_ROOT, 'plugins');
export const PUBLIC_DIR = path.join(CODE_ROOT, 'public');
export const ENGINES_DIR = path.join(CODE_ROOT, 'engines');

// 常用子路径（写在这里，别的文件不再自己 path.join）
export const STATE_FILES = Object.freeze({
  sessions: path.join(STATE_DIR, 'sessions.json'),
  role: path.join(STATE_DIR, 'current-role.json'),
  slang: path.join(STATE_DIR, 'slang.json'),
  slangSession: path.join(STATE_DIR, 'slang-session.json'),
  socialV2: path.join(STATE_DIR, 'social-v2.json'),
  initialPrompts: path.join(STATE_DIR, 'initial-prompts.json'),
  stickers: path.join(STATE_DIR, 'stickers.json'),
  feedback: path.join(STATE_DIR, 'feedback.json'),
  toolLog: path.join(STATE_DIR, 'tool-calls.jsonl'),
  tokenUsage: path.join(STATE_DIR, 'token-usage.jsonl'),
  activityLog: path.join(STATE_DIR, 'qq-activity.log'),
  bridgeLog: path.join(STATE_DIR, 'bridge.log'),
  diaryRead: path.join(STATE_DIR, 'diary-read.json'),
  lock: path.join(STATE_DIR, 'bridge.lock'),
  pairing: path.join(STATE_DIR, 'pairing.json'),
  consoleToken: path.join(STATE_DIR, 'console-token'),
  mode: path.join(STATE_DIR, 'mode.json'),
  mood: path.join(STATE_DIR, 'mood.json'),
  inner: path.join(STATE_DIR, 'inner.json'),
  body: path.join(STATE_DIR, 'body.json'),
  // 身体/心情的时间序列（面板画趋势用，见 src/vitals.js）
  vitals: path.join(STATE_DIR, 'vitals.jsonl'),
  // 运行告警（余额不足/连续出错/网关掉线/重启过多/备份过期，见 src/alerts.js）
  alerts: path.join(STATE_DIR, 'alerts.json'),
  // 每天的 token 用量与主动次数（日预算用，见 src/usage-budget.js）
  usageDaily: path.join(STATE_DIR, 'usage-daily.json'),
  // 回合失败后没答上的消息（见 src/pending-answers.js）
  pendingAnswers: path.join(STATE_DIR, 'pending-answers.json'),
  // 桥接启动时间戳（重启风暴检测）
  boots: path.join(STATE_DIR, 'boots.json'),
  wants: path.join(STATE_DIR, 'wants.json'),
  dreams: path.join(STATE_DIR, 'dreams.jsonl'),
  fantasies: path.join(STATE_DIR, 'fantasies.jsonl'),
  introspection: path.join(STATE_DIR, 'introspection.jsonl'),
  reminders: path.join(STATE_DIR, 'reminders.json'),
  projects: path.join(STATE_DIR, 'projects.json'),
  commitments: path.join(STATE_DIR, 'commitments.json'),
  deliveries: path.join(STATE_DIR, 'delivery-receipts.jsonl'),
  deliveryOperations: path.join(STATE_DIR, 'delivery-operations.json'),
  realityEvents: path.join(STATE_DIR, 'reality-events.jsonl'),
  learning: path.join(STATE_DIR, 'experience-learning.json'),
  continuity: path.join(STATE_DIR, 'continuity.json'),
  situation: path.join(STATE_DIR, 'situation.json'),
  agency: path.join(STATE_DIR, 'agency.json'),
  qzoneLimits: path.join(STATE_DIR, 'qzone-limits.json'),
  pcAccessLog: path.join(STATE_DIR, 'pc-access.log'),
  drawUsage: path.join(STATE_DIR, 'draw-usage.json'),
  ttsVoice: path.join(STATE_DIR, 'tts-voice.json'),
  tmpDir: path.join(STATE_DIR, 'tmp'),
  diaryDir: path.join(STATE_DIR, 'diary'),
  diaryIndex: path.join(STATE_DIR, 'diary', 'index.jsonl'),
  journalDir: path.join(STATE_DIR, 'journal'),
  memoirDir: path.join(STATE_DIR, 'memoir'),
  knowledgeDir: path.join(STATE_DIR, 'knowledge'),
  knowledgeIndex: path.join(STATE_DIR, 'knowledge', 'index.jsonl'),
  memoryDir: path.join(STATE_DIR, 'memory'),
  longTermMemory: path.join(STATE_DIR, 'memory', 'long-term.json'),
  presetBackups: path.join(STATE_DIR, 'preset-backups'),
  slangAgentDir: path.join(STATE_DIR, 'slang-agent'),
});

export const IMAGE_INDEX_FILE = path.join(IMAGES_DIR, '_index.json');
export const IMAGES_TTS_DIR = path.join(IMAGES_DIR, '_tts');
export const AUDIO_TTS_DIR = path.join(AUDIO_DIR, '_tts');
export const SKETCH_SCRIPT = path.join(SCRIPTS_DIR, 'sketch_render.py');
export const CONSOLE_HTML = path.join(PUBLIC_DIR, 'console.html');

/** state/ 下的路径：statePath('diary') -> <state>\diary */
export function statePath(...parts) { return path.join(STATE_DIR, ...parts); }
/** 包根下的路径：rootPath('dsh', 'agent-presets') -> <root>\dsh\agent-presets */
export function rootPath(...parts) { return path.join(APP_ROOT, ...parts); }
/** 图库里的路径 */
export function imagePath(...parts) { return path.join(IMAGES_DIR, ...parts); }
/** 语音库里的路径 */
export function audioPath(...parts) { return path.join(AUDIO_DIR, ...parts); }
/** scripts/ 下的路径 */
export function scriptPath(...parts) { return path.join(SCRIPTS_DIR, ...parts); }

// ── 端口 ────────────────────────────────────────────────────────────────────
// 启动脚本、状态面板、GUI 都从这里取，避免三份各自写数字。
export const PORTS = Object.freeze({
  gateway: 3000,     // SnowLuma OneBot HTTP
  gatewayWs: 3001,   // SnowLuma OneBot WebSocket
  bridge: 3100,      // bridge 控制台 / 健康检查
  tts: 9880,         // GPT-SoVITS api_v2
  comfyui: 8188,     // ComfyUI
  gui: 8765,         // 小鱼管家面板
});

// ── 用户目录 ────────────────────────────────────────────────────────────────
function firstExisting(list) {
  for (const p of list) { if (p && safeExists(p)) return p; }
  return '';
}

function safeExists(p) { try { return fs.existsSync(p); } catch { return false; } }
function safeIsFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function safeIsDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function safeListDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => { try { return e.isDirectory() || e.isSymbolicLink(); } catch { return false; } })
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

function which(exe) {
  if (!exe) return '';
  if (path.isAbsolute(exe) && safeIsFile(exe)) return exe;
  const exts = process.platform === 'win32'
    ? (path.extname(exe) ? [''] : ['.exe', '.cmd', '.bat', ''])
    : [''];
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, exe + ext);
      if (safeIsFile(p)) return p;
    }
  }
  return '';
}

export const HOME_DIR = os.homedir();
const ONE_DRIVE = process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial || '';

// 桌面可能被 OneDrive 重定向过 —— 两个都列出来，优先用真实存在的那个。
export const DESKTOP_DIR = firstExisting([
  path.join(ONE_DRIVE, 'Desktop'),
  path.join(ONE_DRIVE, '桌面'),
  path.join(HOME_DIR, 'Desktop'),
  path.join(HOME_DIR, '桌面'),
]) || path.join(HOME_DIR, 'Desktop');

export const DOCUMENTS_DIR = firstExisting([
  path.join(ONE_DRIVE, 'Documents'),
  path.join(ONE_DRIVE, '文档'),
  path.join(HOME_DIR, 'Documents'),
  path.join(HOME_DIR, '文档'),
]) || path.join(HOME_DIR, 'Documents');

export const DOWNLOADS_DIR = firstExisting([path.join(HOME_DIR, 'Downloads'), path.join(HOME_DIR, '下载')])
  || path.join(HOME_DIR, 'Downloads');

export const PICTURES_DIR = firstExisting([
  path.join(ONE_DRIVE, 'Pictures'),
  path.join(HOME_DIR, 'Pictures'),
]) || path.join(HOME_DIR, 'Pictures');

/** 她写便签的地方（只有这一个写入口）。 */
export const PC_NOTE_DIR = process.env.XIAOYU_NOTE_DIR
  ? path.resolve(process.env.XIAOYU_NOTE_DIR)
  : path.join(DESKTOP_DIR, '小鱼写的');

// 「电脑操作」工具允许访问的根目录。以前写死成 5 条 C:\Users\best\...，
// 换机器就等于全拒；现在按真实用户目录算，包本身也算一个。
export const PC_ROOTS = Object.freeze([...new Set(
  [DESKTOP_DIR, DOCUMENTS_DIR, DOWNLOADS_DIR, APP_ROOT].filter(Boolean)
)]);

// 可选：复用人格卡/翻译用的 companion 配置（装了 ai-companion-kit 才有）。
// 优先级：环境变量 > 数据根下的 companion.json（迁移时拷进来）> 兄弟目录里的 companion。
export const COMPANION_CONFIG = (() => {
  const candidates = [
    process.env.XIAOYU_COMPANION_CONFIG ? path.resolve(process.env.XIAOYU_COMPANION_CONFIG) : '',
    path.join(APP_ROOT, 'companion.json'),
    path.resolve(APP_ROOT, '..', 'ai-companion-kit', 'packages', 'companion', 'config.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return candidates[candidates.length - 1];
})();

// ── 配置读取（无副作用、坏文件不抛） ────────────────────────────────────────
export function readConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

export function configExists() { return safeIsFile(CONFIG_FILE); }

// ── 引擎探测 ────────────────────────────────────────────────────────────────
// 只查候选目录（不递归扫全盘），单次 < 50ms；全部失败就返回空值，让上层优雅降级。
// 优先级：环境变量 > config.engines > 常见安装位置 > 包内 engines/。
const DRIVE_ROOTS = ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\'];

function snowlumaCandidates(cfg) {
  const e = cfg?.engines ?? {};
  return [
    process.env.SNOWLUMA_HOME,
    e.snowluma,
    e.snowlumaHome,
    cfg?.snowluma?.homeDir,
    path.join(ENGINES_DIR, 'SnowLuma'),
    path.join(HOME_DIR, 'SnowLuma'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'SnowLuma'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'SnowLuma'),
    ...DRIVE_ROOTS.map((d) => path.join(d, 'SnowLuma')),
  ].filter(Boolean);
}

function aiVoiceCandidates(cfg) {
  const e = cfg?.engines ?? {};
  return [
    process.env.XIAOYU_AI_VOICE,
    process.env.AI_VOICE_HOME,
    e.aiVoice,
    path.join(ENGINES_DIR, 'ai-voice'),
    ...DRIVE_ROOTS.map((d) => path.join(d, 'ai-voice')),
    path.join(HOME_DIR, 'ai-voice'),
  ].filter(Boolean);
}

function gptSovitsCandidates(cfg, aiVoice) {
  const e = cfg?.engines ?? {};
  // ai-voice\GPT-SoVITS\<版本目录>\api_v2.py —— 版本号会变，所以按目录列出来找
  const underAiVoice = aiVoice
    ? safeListDirs(path.join(aiVoice, 'GPT-SoVITS')).filter((d) => safeExists(path.join(d, 'api_v2.py')))
    : [];
  return [
    process.env.GPT_SOVITS_HOME,
    e.gptSovits,
    e.gptSovitsHome,
    ...underAiVoice,
    aiVoice && path.join(aiVoice, 'GPT-SoVITS'),
    path.join(ENGINES_DIR, 'GPT-SoVITS'),
    path.join(HOME_DIR, 'GPT-SoVITS'),
    ...DRIVE_ROOTS.map((d) => path.join(d, 'GPT-SoVITS')),
  ].filter(Boolean);
}

function comfyCandidates(cfg) {
  const e = cfg?.engines ?? {};
  const inEngines = safeListDirs(ENGINES_DIR).filter((d) => /comfy/i.test(d));
  return [
    process.env.COMFYUI_HOME,
    e.comfyui,
    e.comfyuiHome,
    ...inEngines,
    path.join(ENGINES_DIR, 'ComfyUI'),
    path.join(HOME_DIR, 'ComfyUI'),
    ...DRIVE_ROOTS.map((d) => path.join(d, 'ComfyUI')),
    ...DRIVE_ROOTS.map((d) => path.join(d, 'MiniMaxH3', 'ComfyUI')),
  ].filter(Boolean);
}

function rvcPython(rvcHome) {
  if (!rvcHome) return '';
  const direct = path.join(rvcHome, 'runtime', 'python.exe');
  if (safeIsFile(direct)) return direct;
  for (const sub of safeListDirs(rvcHome)) {
    const p = path.join(sub, 'runtime', 'python.exe');
    if (safeIsFile(p)) return p;
  }
  return which('python');
}

function comfyPython(comfyHome) {
  if (!comfyHome) return '';
  const candidates = [
    path.join(path.dirname(comfyHome), 'venv', 'Scripts', 'python.exe'),   // 有些安装把 venv 放在 ComfyUI 的上一层
    path.join(comfyHome, 'venv', 'Scripts', 'python.exe'),
    path.join(comfyHome, '.venv', 'Scripts', 'python.exe'),
    path.join(comfyHome, 'python_embeded', 'python.exe'),
  ];
  for (const p of candidates) if (safeIsFile(p)) return p;
  return which('python');
}

function buildEngines(cfg) {
  const aiVoice = firstExisting(aiVoiceCandidates(cfg));
  const snowHome = firstExisting(snowlumaCandidates(cfg));

  const snowLuma = snowHome
    ? {
        home: snowHome,
        launcher: firstExisting([
          path.join(snowHome, 'start.bat'),
          path.join(snowHome, 'launcher.bat'),
          path.join(snowHome, 'SnowLuma.exe'),
        ]),
        node: firstExisting([path.join(snowHome, 'node.exe')]),
        entry: firstExisting([path.join(snowHome, 'index.mjs')]),
      }
    : { home: '', launcher: '', node: '', entry: '' };

  const gptHomeRaw = firstExisting(gptSovitsCandidates(cfg, aiVoice));
  // 允许直接指到版本目录的上层
  const gptHome = gptHomeRaw && !safeExists(path.join(gptHomeRaw, 'api_v2.py'))
    ? (safeListDirs(gptHomeRaw).find((d) => safeExists(path.join(d, 'api_v2.py'))) ?? '')
    : gptHomeRaw;
  const gptPython = gptHome
    ? firstExisting([
        path.join(gptHome, 'runtime', 'python.exe'),
        path.join(gptHome, 'python.exe'),
      ]) || which('python')
    : '';

  const comfyRaw = firstExisting(comfyCandidates(cfg));
  const comfyHome = comfyRaw && !safeExists(path.join(comfyRaw, 'main.py'))
    ? (safeListDirs(comfyRaw).find((d) => safeExists(path.join(d, 'main.py'))) ?? comfyRaw)
    : comfyRaw;

  const rvcCandidates = [
    process.env.RVC_HOME,
    cfg?.engines?.rvc,
    aiVoice && path.join(aiVoice, 'RVC'),
  ].filter(Boolean);
  const rvcHome = firstExisting(rvcCandidates);

  return {
    aiVoice: {
      home: aiVoice,
      singIn: aiVoice ? path.join(aiVoice, 'sing-in') : '',
      singPipeline: aiVoice ? path.join(aiVoice, 'sing_pipeline.py') : '',
    },
    snowluma: snowLuma,
    gptSovits: {
      home: gptHome,
      python: gptPython,
      apiScript: gptHome ? path.join(gptHome, 'api_v2.py') : '',
      apiConfig: gptHome ? path.join(gptHome, 'GPT_SoVITS', 'configs', 'tts_infer.yaml') : '',
    },
    comfyui: {
      home: comfyHome,
      python: comfyPython(comfyHome),
      main: comfyHome ? path.join(comfyHome, 'main.py') : '',
    },
    rvc: {
      home: rvcHome,
      python: rvcPython(rvcHome),
    },
    ffmpeg: {
      exe: firstExisting([process.env.FFMPEG_PATH]) || which('ffmpeg'),
    },
    node: { exe: process.execPath },
    python: { exe: which('python') },
  };
}

let enginesCache = null;
/** 探测结果（带缓存）。cfg 变化后调用 detectEngines({ refresh: true })。 */
export function detectEngines({ cfg = readConfig(), refresh = false } = {}) {
  if (enginesCache && !refresh) return enginesCache;
  enginesCache = buildEngines(cfg);
  return enginesCache;
}

export function resetEngineCache() { enginesCache = null; }

/** 「有没有装」的布尔视图，给能力探测用。 */
export function capabilities(engineSet = detectEngines()) {
  return {
    snowluma: Boolean(engineSet.snowluma.home),
    voice: Boolean(engineSet.gptSovits.home),
    draw: Boolean(engineSet.comfyui.home),
    sing: Boolean(engineSet.aiVoice.singPipeline && engineSet.rvc.home),
    ffmpeg: Boolean(engineSet.ffmpeg.exe),
  };
}

// ── 首次运行：建目录 + 生成默认 config ──────────────────────────────────────
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function baseConfig() {
  try {
    const text = fs.readFileSync(CONFIG_EXAMPLE_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return deepClone(parsed);
  } catch { /* 模板缺失/损坏时用下面的最小配置 */ }
  return {
    ownerQQ: null,
    sessionCwd: '',
    agentPreset: 'qq-chat',
    allow: { private: [], groups: [] },
    deny: { private: [], groups: [] },
    allowAllWhenEmpty: false,
    dsh: { baseUrl: 'http://127.0.0.1:3080', provider: 'deepseek-official', model: 'deepseek-flash' },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: '' },
  };
}

/** 把探测到的引擎写进 config.engines（用户手改过的值不覆盖空字符串以外的内容）。 */
function withDetectedEngines(cfg, engineSet) {
  const out = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? { ...cfg } : {};
  const existing = out.engines && typeof out.engines === 'object' ? out.engines : {};
  const keep = (k, detected) => (existing[k] && String(existing[k]).trim() ? existing[k] : detected || '');
  out.engines = {
    aiVoice: keep('aiVoice', engineSet.aiVoice.home),
    snowluma: keep('snowluma', engineSet.snowluma.home),
    gptSovits: keep('gptSovits', engineSet.gptSovits.home),
    comfyui: keep('comfyui', engineSet.comfyui.home),
    rvc: keep('rvc', engineSet.rvc.home),
    ffmpeg: keep('ffmpeg', engineSet.ffmpeg.exe),
    gptSovitsPython: keep('gptSovitsPython', engineSet.gptSovits.python),
    comfyuiPython: keep('comfyuiPython', engineSet.comfyui.python),
    rvcPython: keep('rvcPython', engineSet.rvc.python),
  };
  // SnowLuma 的启动器位置 bridge 也会读，顺手填好（用户已填则不动）
  if (out.snowluma && typeof out.snowluma === 'object') {
    if (!out.snowluma.homeDir && engineSet.snowluma.home) out.snowluma.homeDir = engineSet.snowluma.home;
    if (!out.snowluma.launcherPath && engineSet.snowluma.launcher) out.snowluma.launcherPath = engineSet.snowluma.launcher;
  }
  return out;
}

/**
 * 首次运行准备：建 state/logs，缺 config.json 就从模板生成（含引擎探测）。
 * 幂等；已有 config.json 一个字都不动。
 */
export function ensureRuntime({ create = true, quiet = false } = {}) {
  const createdDirs = [];
  for (const dir of [STATE_DIR, LOGS_DIR, STATE_FILES.tmpDir, STATE_FILES.diaryDir, STATE_FILES.memoirDir, STATE_FILES.journalDir]) {
    if (safeExists(dir)) continue;
    if (!create) { if (!quiet) console.error(`[paths] 缺少目录：${dir}`); continue; }
    fs.mkdirSync(dir, { recursive: true });
    createdDirs.push(dir);
  }

  let createdConfig = false;
  if (!configExists()) {
    if (!create) throw new Error(`config.json 不存在：${CONFIG_FILE}`);
    const engineSet = detectEngines({ cfg: {}, refresh: true });
    const cfg = withDetectedEngines(baseConfig(), engineSet);
    cfg._meta = {
      generatedBy: 'src/paths.js',
      generatedAt: new Date().toISOString(),
      note: '首次运行自动生成。ownerQQ / allow / snowluma.accessToken / dsh.baseUrl 需要按自己情况填。',
    };
    try {
      fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    } catch (error) {
      throw new Error(`无法写入 config.json（${CONFIG_FILE}）：${error?.message ?? error}。若装在 Program Files 下，请改安装到有写权限的目录（如 %LOCALAPPDATA%\\xiaoyu）。`);
    }
    createdConfig = true;
    resetEngineCache();
    if (!quiet) {
      console.error(`[paths] 首次运行：已生成 ${CONFIG_FILE}`);
      console.error('[paths] 还需要填：ownerQQ、allow.private/groups、snowluma.accessToken、dsh.baseUrl');
    }
  }

  return { createdConfig, createdDirs, configFile: CONFIG_FILE, engines: detectEngines({ refresh: true }) };
}

// ── 汇总（给 CLI / 启动脚本 / GUI 用同一份） ────────────────────────────────
export function snapshot({ init = false } = {}) {
  let createdConfig = false;
  let createdDirs = [];
  if (init) {
    const r = ensureRuntime({ create: true, quiet: true });
    createdConfig = r.createdConfig;
    createdDirs = r.createdDirs;
  }
  const engineSet = detectEngines({ refresh: init });
  return {
    ok: true,
    root: APP_ROOT,
    codeRoot: CODE_ROOT,
    srcDir: SRC_DIR,
    dataDir: DATA_DIR,
    config: CONFIG_FILE,
    configExample: CONFIG_EXAMPLE_FILE,
    configExists: configExists(),
    createdConfig,
    createdDirs,
    dirs: {
      state: STATE_DIR,
      logs: LOGS_DIR,
      roles: ROLES_DIR,
      images: IMAGES_DIR,
      audio: AUDIO_DIR,
      scripts: SCRIPTS_DIR,
      dsh: DSH_DIR,
      presets: PRESETS_DIR,
      plugins: PLUGINS_DIR,
      public: PUBLIC_DIR,
      assets: ASSETS_DIR,
      engines: ENGINES_DIR,
      note: PC_NOTE_DIR,
    },
    user: {
      home: HOME_DIR,
      desktop: DESKTOP_DIR,
      documents: DOCUMENTS_DIR,
      downloads: DOWNLOADS_DIR,
      pictures: PICTURES_DIR,
    },
    engines: {
      aiVoice: engineSet.aiVoice,
      snowluma: engineSet.snowluma,
      gptSovits: engineSet.gptSovits,
      comfyui: engineSet.comfyui,
      rvc: engineSet.rvc,
      ffmpeg: engineSet.ffmpeg,
      node: engineSet.node,
    },
    capabilities: capabilities(engineSet),
    ports: PORTS,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = new Set(process.argv.slice(2));
  const wantJson = args.has('--json');
  const wantInit = args.has('--init');
  const wantCheck = args.has('--check');

  let snap;
  try {
    snap = snapshot({ init: wantInit });
  } catch (error) {
    console.error(`[paths] 初始化失败：${error?.message ?? error}`);
    process.exit(2);
  }

  if (wantJson) {
    process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
  } else {
    const mark = (ok) => (ok ? '✅' : '❌');
    console.log('');
    console.log('=== 小鱼 · 路径与引擎 ===');
    console.log(`  代码目录  ${snap.codeRoot}`);
    console.log(`  数据目录  ${snap.root}${snap.root === snap.codeRoot ? '' : '（XIAOYU_HOME）'}`);
    console.log(`  状态/日志 ${snap.dataDir}${snap.dataDir === snap.root ? '' : '（XIAOYU_DATA）'}`);
    console.log(`  配置      ${snap.config} ${snap.configExists ? '' : '（不存在，运行 --init 生成）'}`);
    console.log('');
    console.log(`  ${mark(snap.capabilities.snowluma)} QQ 网关   ${snap.engines.snowluma.home || '没找到 SnowLuma'}`);
    console.log(`  ${mark(snap.capabilities.voice)} 声音      ${snap.engines.gptSovits.home || '没找到 GPT-SoVITS'}`);
    console.log(`  ${mark(snap.capabilities.draw)} 画图      ${snap.engines.comfyui.home || '没找到 ComfyUI'}`);
    console.log(`  ${mark(snap.capabilities.sing)} 唱歌      ${snap.engines.rvc.home || '没找到 RVC'}`);
    console.log(`  ${mark(snap.capabilities.ffmpeg)} ffmpeg    ${snap.engines.ffmpeg.exe || 'PATH 里没有'}`);
    if (snap.createdConfig) console.log('\n  已生成 config.json（首次运行）');
    if (snap.createdDirs.length) console.log(`  已创建目录 ${snap.createdDirs.length} 个`);
    console.log('');
  }

  if (wantCheck) {
    const missing = [];
    if (!snap.configExists) missing.push('config.json');
    if (!safeExists(snap.dirs.state)) missing.push('state/');
    if (!safeExists(snap.dirs.roles)) missing.push('roles/');
    if (missing.length) {
      console.error(`[paths] 自检失败：缺少 ${missing.join('、')}`);
      process.exit(1);
    }
    if (!wantJson) console.log('✅ 自检通过');
  }
}
