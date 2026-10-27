// 把一个任务交给别的 agent（OpenCode / Codex 这类 CLI）去做，拿回一段文本。
//
// 为什么单独一个模块：桥接（QQ 事件流）和 MCP 工具进程都可能要调它，而「怎么找到那个 CLI、
// 传什么参数、怎么清理输出」这些细节不该散在两处。这里只做进程调用，不碰 QQ、不写 state。
//
// 边界（很重要）：
//   · 只接受白名单里的 agent id，不接受任意命令；
//   · prompt 有长度上限、有超时、有输出上限 —— 对方是真会花额度的；
//   · 不用 shell，cwd 由调用方给（默认程序目录），不让模型自己决定跑在哪；
//   · 谁能调由 MCP 工具那一层管（只允许管理员私聊，默认关闭）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const AGENT_PROMPT_MAX_CHARS = 4000;
export const AGENT_OUTPUT_MAX_CHARS = 4000;
export const AGENT_TIMEOUT_DEFAULT_MS = 120000;
export const AGENT_TIMEOUT_MIN_MS = 10000;
export const AGENT_TIMEOUT_MAX_MS = 600000;

/** 支持的 agent：id -> 怎么找它、怎么传参、怎么清理输出。 */
const AGENTS = {
  opencode: {
    label: 'OpenCode',
    // OpenCode 桌面版自带一份 CLI，不用另外装；也允许用户自己装一份到 PATH。
    candidates: () => [
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe'),
    ],
    args: ({ prompt, model }) => ['run', ...(model ? ['-m', model] : []), prompt],
    // OpenCode 会在正文前打印一行 `> build · 模型名`，不属于回答。
    stripsStatus: true,
  },
  codex: {
    label: 'Codex CLI',
    candidates: () => [
      path.join(os.homedir(), '.local', 'bin', 'codex.cmd'),
      path.join(os.homedir(), '.local', 'bin', 'codex.exe'),
    ],
    args: ({ prompt, model }) => ['exec', ...(model ? ['--model', model] : []), prompt],
    stripsStatus: false,
  },
};

export const AGENT_IDS = Object.freeze(Object.keys(AGENTS));

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 截断 prompt：超长就拒绝而不是偷偷截断，免得对方只看到半句话还认真作答。 */
export function clampPrompt(text, max = AGENT_PROMPT_MAX_CHARS) {
  const s = String(text ?? '').trim();
  if (!s) return { ok: false, error: 'prompt 不能为空' };
  if (s.length > max) return { ok: false, error: `prompt 太长（${s.length} 字，上限 ${max}）` };
  return { ok: true, text: s };
}

/** 清掉 ANSI、OpenCode 的状态行、多余空行，并截断到输出上限。 */
export function cleanAgentOutput(raw, { stripsStatus = false, max = AGENT_OUTPUT_MAX_CHARS } = {}) {
  let text = String(raw ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  if (stripsStatus) {
    text = text.split('\n').filter((line) => !/^\s*>\s*(build|plan|agent)\b/.test(line)).join('\n');
  }
  text = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > max) text = `${text.slice(0, max)}\n…（已截断）`;
  return text;
}

/**
 * 找到某个 agent 的可执行文件。
 * 优先级：config 里显式指定的路径 > 已知安装位置。找不到返回 ''。
 */
export function resolveAgentPath(id, { cfg, exists = fs.existsSync } = {}) {
  const spec = AGENTS[id];
  if (!spec) return '';
  const configured = cfg?.socialV2?.agents?.[id]?.path;
  if (typeof configured === 'string' && configured.trim() && exists(configured.trim())) return configured.trim();
  for (const candidate of spec.candidates()) {
    if (candidate && exists(candidate)) return candidate;
  }
  return '';
}

/** 面板/工具用：目前装了哪些、在哪、能不能用。 */
export function agentCatalog({ cfg, exists = fs.existsSync } = {}) {
  return AGENT_IDS.map((id) => {
    const bin = resolveAgentPath(id, { cfg, exists });
    return {
      id,
      label: AGENTS[id].label,
      path: bin,
      ready: Boolean(bin),
      enabled: cfg?.socialV2?.tools?.askAgent === true,
      hint: bin ? '' : `没找到 ${AGENTS[id].label}；装好后可以在 config.json 的 socialV2.agents.${id}.path 里写死路径`,
    };
  });
}

/**
 * 让别的 agent 做一件事。
 *
 * @param {object} options
 * @param {'opencode'|'codex'} options.agent
 * @param {string} options.prompt
 * @param {string} [options.model]  形如 `openai/gpt-5.5-fast`；不传就用对方默认
 * @param {number} [options.timeoutMs]
 * @param {string} [options.cwd]
 * @param {object} [options.cfg]    读 socialV2.agents / tools 用
 * @param {Function} [options.spawnImpl] 测试注入
 * @returns {Promise<{ok:boolean, text?:string, error?:string, agent?:string, model?:string, ms?:number}>}
 */
export async function askAgent({
  agent = 'opencode', prompt, model = '', timeoutMs = AGENT_TIMEOUT_DEFAULT_MS,
  cwd = process.cwd(), cfg, spawnImpl = spawn,
} = {}) {
  const spec = AGENTS[agent];
  if (!spec) return { ok: false, error: `不支持的 agent：${agent}（可用：${AGENT_IDS.join(' / ')}）` };
  const checked = clampPrompt(prompt);
  if (!checked.ok) return { ok: false, error: checked.error };

  const bin = resolveAgentPath(agent, { cfg });
  if (!bin) return { ok: false, error: `没找到 ${spec.label} 的可执行文件` };

  const waitMs = clampInt(timeoutMs, AGENT_TIMEOUT_DEFAULT_MS, AGENT_TIMEOUT_MIN_MS, AGENT_TIMEOUT_MAX_MS);
  const useModel = String(model ?? '').trim();
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, spec.args({ prompt: checked.text, model: useModel }), {
        cwd,
        windowsHide: true,
        // 不用 shell：prompt 里出现引号/反引号也不会被当成命令分隔符。
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (error) {
      resolve({ ok: false, error: `启动 ${spec.label} 失败：${error?.message ?? error}` });
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ agent, model: useModel, ms: Date.now() - startedAt, ...payload });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
      done({ ok: false, error: `${spec.label} 超时（${Math.round(waitMs / 1000)} 秒）` });
    }, waitMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      // 只留前 4 倍上限，防止对方疯狂输出把内存撑爆
      if (out.length < AGENT_OUTPUT_MAX_CHARS * 4) out += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (err.length < 2000) err += chunk.toString('utf8');
    });
    child.on('error', (error) => done({ ok: false, error: `启动 ${spec.label} 失败：${error?.message ?? error}` }));
    child.on('close', (code) => {
      const text = cleanAgentOutput(out, { stripsStatus: spec.stripsStatus });
      if (code === 0 && text) {
        done({ ok: true, text });
        return;
      }
      // 有的 CLI 把错误也写在 stdout；两边都带上，方便一眼看出是没登录还是没模型。
      const detail = cleanAgentOutput(err || out, { stripsStatus: spec.stripsStatus, max: 600 });
      done({ ok: false, error: `${spec.label} 退出码 ${code}${detail ? `：${detail}` : ''}` });
    });
  });
}
