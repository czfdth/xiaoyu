// Fastify 应用：REST API + 静态前端。
//
// 约定：
//   · 所有接口都在 /api 下，返回 JSON（出错统一 { error }）
//   · 前端是 Vite 构建出来的 SPA，非 /api 的 GET 一律回 index.html
//   · 写操作先过 guard.assertLocalRequest（只认 127.0.0.1 + 同源 + JSON）

import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { STATE_DIR } from '../../src/paths.js';
import { assertLocalRequest, HttpError } from './guard.mjs';
import {
  overview, configView, saveConfig, saveAvatar, runSetup, saveContextBudget, usageBudgetView, saveUsageLimits,
  herState, journal, journalDays, journalSearch, memoryList, memoryRead, memoryCounts, memorySearch,
  securityBlocks,
  roleList, roleRead, roleWrite, logList, logTail,
  pairingView, startPairing, cancelPairing,
  discoverDshForUi, applyDshBaseUrl, gpuMode, setGpuMode,
  listBackups, createBackupNow, restoreBackup, exportLifeMarkdown, backupFilePath,
} from './data.mjs';
import { actionList, runAction } from './actions.mjs';
import { gatewayState, launchGateway } from './gateway.mjs';
import { replaySecurity, exportSecurity } from './security.mjs';
import { toolCatalog, setToolEnabled, setToolsEnabled, verifyTool } from './tools.mjs';
import { tokenOverview } from './tokens.mjs';
import { vitalsView } from './vitals.mjs';
import { opsView, runOps, runCleanup } from './ops.mjs';
import { lifeView, generateChronicle, chronicleList, readChronicle } from './life.mjs';
import { listImages, listAudio, imagePath, decorImages, portraitImage, emotionImage, avatarImage, avatarChoices, listNotes, notePath } from './works.mjs';
import { listActions, actionFile } from './pet.mjs';
import { desktopPetStatus, startDesktopPet, stopDesktopPet } from './desktoppet.mjs';

const BUILD_HINT = `<!doctype html><meta charset="utf-8"><title>小鱼管家</title>
<style>body{background:#0d1117;color:#c9d1d9;font-family:system-ui,"Microsoft YaHei";padding:40px;line-height:1.7}
code{background:#161b22;padding:2px 6px;border-radius:6px}</style>
<h2>🐋 小鱼管家还没有构建前端</h2>
<p>在 <code>gui</code> 目录里跑一次：</p>
<pre><code>npm install
npm run build</code></pre>
<p>然后刷新这个页面。</p>`;

export async function buildApp({ guiDir }) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const distDir = path.resolve(guiDir, 'dist');

  // 前端没构建时给一张说明页，而不是 500
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), BUILD_HINT, 'utf8');
  }

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api') && !assertLocalRequest(req, reply)) return reply;
    // 写操作：浏览器同源请求放行；本机其他程序/脚本必须带 x-console-token
    const fromBrowser = Boolean(req.headers.origin) || req.headers['sec-fetch-site'] === 'same-origin';
    if (req.url.startsWith('/api') && req.method === 'GET' && !fromBrowser && /^\/api\/(memory|journal|her|roles)/.test(req.url)) {
      const READ_GUARD = true;
      try {
        const token = fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim();
        if (token && req.headers['x-console-token'] !== token) {
          return reply.code(401).send({ error: '本机外部读取记忆需要 x-console-token' });
        }
      } catch { /* 没令牌文件就放行 */ }
    }
    if (req.url.startsWith('/api') && req.method !== 'GET') {
      const fromBrowser = Boolean(req.headers.origin) || req.headers['sec-fetch-site'] === 'same-origin';
      if (!fromBrowser) {
        try {
          const token = fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim();
          if (token && req.headers['x-console-token'] !== token) {
            return reply.code(401).send({ error: '本机外部调用需要 x-console-token（见 state/console-token）' });
          }
        } catch { /* 没有令牌文件就不拦 */ }
      }
    }
  });

  app.setErrorHandler((error, req, reply) => {
    const status = error instanceof HttpError ? error.status : (error.statusCode ?? 500);
    if (status >= 500) console.error('[console]', req.method, req.url, error);
    reply.code(status).send({ error: error.message || '服务器错误' });
  });

  // ── 只读 ────────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/overview', async () => overview());

  app.get('/api/config', async () => configView());

  app.get('/api/her', async () => herState());
  // 她的状态可视化：当前值 + 24 小时身体/心情序列 + 当天聊天分桶
  app.get('/api/vitals', async (req) => vitalsView({ hours: Number(req.query?.hours) || 24, day: req.query?.day }));

  app.get('/api/journal', async (req) => journal(req.query?.day));

  app.get('/api/journal/search', async (req) => journalSearch(req.query?.q ?? ''));

  app.get('/api/journal/days', async () => ({ days: journalDays(60) }));

  app.get('/api/memory/summary', async () => memoryCounts());

  app.get('/api/memory/search', async (req) => memorySearch(req.query?.q ?? ''));

  app.get('/api/security/blocks', async (req) => securityBlocks(Number(req.query?.limit) || 200));
  app.get('/api/security/export', async (req, reply) => {
    const data = securityBlocks(5000);
    const out = exportSecurity({
      items: data.items,
      format: req.query?.format === 'jsonl' ? 'jsonl' : 'csv',
      reason: req.query?.reason || 'all',
      q: req.query?.q || '',
      limit: 5000,
    });
    reply.header('content-type', out.contentType);
    reply.header('content-disposition', `attachment; filename="${out.filename}"`);
    return reply.send(out.body);
  });
  app.post('/api/security/replay', async (req) => replaySecurity({
    text: req.body?.text,
    knownToken: req.body?.knownToken === true,
  }));

  app.get('/api/memory/:kind', async (req) => ({
    kind: req.params.kind,
    items: memoryList(req.params.kind),
  }));

  app.get('/api/memory/:kind/:id', async (req) => memoryRead(req.params.kind, req.params.id));

  app.get('/api/roles', async () => ({ roles: roleList() }));

  app.get('/api/roles/:name', async (req) => roleRead(req.params.name));

  app.get('/api/logs', async () => ({ files: logList() }));

  app.get('/api/logs/:name', async (req) => logTail(req.params.name, req.query?.lines));

  app.get('/api/actions', async () => ({ actions: actionList() }));

  app.get('/api/pairing', async () => pairingView());
  app.post('/api/pairing', async () => startPairing());
  app.delete('/api/pairing', async () => cancelPairing());

  app.get('/api/dsh', async () => discoverDshForUi());
  app.post('/api/dsh', async (req) => applyDshBaseUrl(req.body?.baseUrl));

  // ── 写入 ────────────────────────────────────────────────────────────────
  app.put('/api/config', async (req) => saveConfig(req.body ?? {}));

  app.post('/api/setup', async (req) => runSetup(req.body ?? {}));

  app.put('/api/roles/:name', async (req) => roleWrite(req.params.name, req.body?.content));

  app.post('/api/actions/:name', async (req) => runAction(req.params.name));

  // 网关：只读状态 + 用户显式确认后启动（不安装、不静默启动）
  app.get('/api/gateway', async () => gatewayState());
  app.get('/api/gpu-mode', async () => ({ mode: gpuMode() }));
  app.post('/api/gpu-mode', async (req) => setGpuMode(req.body?.mode));
  app.get('/api/backups', async () => ({ backups: listBackups() }));
  app.post('/api/backups', async () => createBackupNow());
  app.post('/api/backups/restore', async (req) => restoreBackup(req.body?.name));
  app.get('/api/backups/:name/download', async (req, reply) => {
    const file = backupFilePath(req.params.name);
    return reply.type('application/zip').send(fs.createReadStream(file));
  });
  app.get('/api/export/life.md', async (req, reply) => {
    const { filename, markdown } = exportLifeMarkdown();
    return reply.type('text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(markdown);
  });

  app.get('/api/tools', async (req) => toolCatalog({ refresh: req.query?.refresh === '1' }));
  app.post('/api/tools/toggle', async (req) => setToolEnabled(req.body?.name, req.body?.enabled === true));
  // 工具瘦身：一次关/开一批（从没用过的工具留在每次请求里白烧 token）
  app.post('/api/tools/toggle-bulk', async (req) => setToolsEnabled(req.body?.names, req.body?.enabled === true));
  app.get('/api/tools/verify', async (req) => verifyTool(req.query?.name));
  // 花费与上下文预算：token 账本的折算结果 + 两道刹车（步数上限 / 轮换阈值）
  app.get('/api/tokens', async (req) => tokenOverview({
    days: Number(req.query?.days) || 7,
    sessions: Number(req.query?.sessions) || 12,
  }));
  app.post('/api/tokens/budget', async (req) => saveContextBudget(req.body ?? {}));
  // 日预算：今天用了多少 / 上限多少 / 是否已拦主动
  app.get('/api/usage/budget', async () => usageBudgetView());
  // 运维体检：磁盘 / 密钥 / 备份演练 / 索引召回；POST 现场跑，cleanup 默认只演练
  app.get('/api/ops', async () => opsView());
  app.post('/api/ops/run', async (req) => runOps(String(req.body?.task ?? 'keys')));
  app.post('/api/ops/cleanup', async (req) => ({
    ok: true,
    ...runCleanup({
      keepBackupDays: Number(req.body?.keepBackupDays) || 30,
      keepLogDays: Number(req.body?.keepLogDays) || 14,
      dryRun: req.body?.dryRun !== false,
    }),
  }));
  app.post('/api/usage/budget', async (req) => saveUsageLimits(req.body ?? {}));
  app.get('/api/life', async () => lifeView());
  app.get('/api/life/chronicles', async () => ({ chronicles: chronicleList() }));
  app.get('/api/life/chronicles/:name', async (req) => readChronicle(req.params.name));
  app.post('/api/life/chronicle', async (req) => generateChronicle({ days: req.body?.days }));

  // 作品集：图库/语音/便签
  app.get('/api/works/images', async (req) => listImages({ limit: Number(req.query?.limit) || 60, offset: Number(req.query?.offset) || 0 }));
  app.get('/api/works/decor', async () => decorImages({ limit: 4 }));
  app.get('/api/works/avatar', async () => {
    const name = avatarImage();
    return { name, url: name ? `/api/works/image/${encodeURIComponent(name)}` : '' };
  });
  app.get('/api/works/avatar-options', async () => avatarChoices());
  app.post('/api/ui/avatar', async (req) => saveAvatar(req.body?.name));
  app.get('/api/works/notes', async (req) => listNotes({ limit: Number(req.query?.limit) || 100, offset: Number(req.query?.offset) || 0 }));
  app.get('/api/works/note/:name', async (req, reply) => {
    const { file, type } = notePath(req.params.name);
    return reply.type(type).send(fs.createReadStream(file));
  });

  // 她的动作（dsh-pet 素材）
  app.get('/api/pet/actions', async () => listActions());
  app.get('/api/desktop-pet', async () => desktopPetStatus());
  app.post('/api/desktop-pet/start', async () => startDesktopPet());
  app.post('/api/desktop-pet/stop', async () => stopDesktopPet());
  app.get('/api/works/portrait', async () => portraitImage());
  app.get('/api/works/emotion', async (req) => emotionImage(req.query?.mood));
  app.get('/api/works/portrait-image', async (req, reply) => {
    const { name } = portraitImage();
    if (!name) return reply.code(404).send({ error: '没有立绘' });
    const { file, type } = imagePath(name);
    return reply.type(type).send(fs.createReadStream(file));
  });
  app.get('/api/works/emotion-image', async (req, reply) => {
    const { name } = emotionImage(req.query?.mood);
    if (!name) return reply.code(404).send({ error: '没有表情图' });
    const { file, type } = imagePath(name);
    return reply.type(type).send(fs.createReadStream(file));
  });
  app.get('/api/pet/action/:name', async (req, reply) => {
    const { file, type } = actionFile(req.params.name);
    return reply.type(type).send(fs.createReadStream(file));
  });
  app.get('/api/works/audio', async (req) => listAudio({ limit: Number(req.query?.limit) || 100, offset: Number(req.query?.offset) || 0 }));
  app.get('/api/works/image/:name', async (req, reply) => {
    const { file, type } = imagePath(req.params.name);
    return reply.type(type).send(fs.createReadStream(file));
  });
  app.post('/api/gateway/start', async (req) => {
    if (req.body?.confirm !== true) {
      const error = new Error('启动网关需要显式确认（confirm: true）');
      error.statusCode = 400;
      throw error;
    }
    return launchGateway({ dryRun: req.body?.dryRun === true });
  });

  // ── 静态前端 ────────────────────────────────────────────────────────────
  await app.register(fastifyStatic, {
    root: distDir,
    prefix: '/',
    wildcard: false,
    index: ['index.html'],
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      reply.code(404).send({ error: '接口不存在' });
      return;
    }
    reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'));
  });

  return app;
}
