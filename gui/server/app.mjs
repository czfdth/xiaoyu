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
import { validateBody } from '../shared/contract.mjs';
import { loadRemoteConfig, verifySession, verifyPassword, signSession, SESSION_COOKIE, SESSION_DAYS, isLoopback } from './remote.js';
import {
  overview, configView, saveConfig, saveAvatar, runSetup, saveContextBudget, usageBudgetView, saveUsageLimits, remoteView, saveRemoteConfig, skinView, saveSkin, qzoneView, saveQzone,
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
import { worksWall, buildMonthlyReport, listReports } from './works-report.mjs';
import { kgView } from './kg.mjs';
import { herLiveView } from './live.mjs';
import { lifeTimeline } from './timeline.mjs';
import { searchAll } from './search.mjs';
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
    // 局域网访问：非本机请求必须带会话 Cookie，默认只读。
    // 放在最前面，是因为 assertLocalRequest 只认 127.0.0.1，会把手机请求直接 403。
    const remoteCfg = loadRemoteConfig();
    const local = isLoopback(req.hostname);
    if (!local) {
      if (!remoteCfg.enabled || !remoteCfg.hasPassword) {
        return reply.code(403).send({ error: '远程访问未开启（先在配置页设置口令）' });
      }
      // 登录/登出本身是 POST，必须放行只读拦截，否则远程永远登不进来（实测踩到过）
      const isAuthRoute = req.url === '/login'
        || req.url.startsWith('/api/remote/login')
        || req.url.startsWith('/api/remote/logout');
      if (!isAuthRoute) {
        const cookie = String(req.headers.cookie ?? '');
        const hit = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
        const session = hit ? decodeURIComponent(hit.slice(SESSION_COOKIE.length + 1)) : '';
        if (!verifySession(session)) {
          return reply.code(401).send({ error: '需要先登录：/login' });
        }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && !isAuthRoute && !remoteCfg.allowWrite) {
        return reply.code(403).send({ error: '远程访问默认只读（要改配置请在本机操作）' });
      }
    }
    if (local && req.url.startsWith('/api') && !assertLocalRequest(req, reply)) return reply;
    // 写操作：浏览器同源请求放行；本机其他程序/脚本必须带 x-console-token
    // 远程请求不走这一段——它们已经过了口令会话校验，这里再要 console-token 会把手机挡死
    // （实测：手机登录后第一次点保存会被 401 "需要 x-console-token"）。
    if (local) {
      const fromBrowser = Boolean(req.headers.origin) || req.headers['sec-fetch-site'] === 'same-origin';
      if (req.url.startsWith('/api') && req.method === 'GET' && !fromBrowser && /^\/api\/(memory|journal|her|roles)/.test(req.url)) {
        try {
          const token = fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim();
          if (token && req.headers['x-console-token'] !== token) {
            return reply.code(401).send({ error: '本机外部读取记忆需要 x-console-token' });
          }
        } catch { /* 没令牌文件就放行 */ }
      }
      if (req.url.startsWith('/api') && req.method !== 'GET' && !fromBrowser) {
        try {
          const token = fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim();
          if (token && req.headers['x-console-token'] !== token) {
            return reply.code(401).send({ error: '本机外部调用需要 x-console-token（见 state/console-token）' });
          }
        } catch { /* 没有令牌文件就不拦 */ }
      }
    }
  });

  // ── 局域网登录（手机用）──────────────────────────────────────────────
  app.get('/login', async (req, reply) => {
    const cfg = loadRemoteConfig();
    const blocked = !cfg.enabled || !cfg.hasPassword;
    reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小鱼管家 · 登录</title>
<style>body{margin:0;background:#0b0f14;color:#e6edf3;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
form{background:#121a23;border:1px solid #223040;border-radius:14px;padding:24px;width:min(92vw,340px)}
h1{font-size:17px;margin:0 0 12px}input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #28394b;background:#0b1118;color:#e6edf3;font-size:15px}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:9px;background:#38bdf8;color:#04121c;font-weight:600;font-size:15px}
p{color:#8b9bb0;font-size:12.5px;margin:10px 0 0}</style>
${blocked ? '<form><h1>远程访问没开</h1><p>先在本机控制台「配置 → 手机访问」里开启并设置口令。</p></form>'
  : `<form method="post" action="/api/remote/login"><h1>小鱼管家</h1>
<input type="password" name="password" placeholder="访问口令" autofocus required>
<button type="submit">进入</button><p>口令只存在你自己电脑上，用 scrypt 哈希保存。</p></form>`}`);
  });

  app.post('/api/remote/login', async (req, reply) => {
    const cfg = loadRemoteConfig();
    if (!cfg.enabled || !cfg.hasPassword) throw new HttpError(403, '远程访问未开启');
    const password = String(req.body?.password ?? '');
    if (!verifyPassword(password, cfg.passwordHash)) {
      await new Promise((r) => setTimeout(r, 400)); // 随手防爆破
      throw new HttpError(401, '口令不对');
    }
    const session = signSession();
    reply.header('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
    return { ok: true };
  });

  app.post('/api/remote/logout', async (req, reply) => {
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
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
  // 她此刻：实时读 journal/state（前端 10 秒轮询）
  app.get('/api/her/live', async () => herLiveView());
  // 生活时间流：日记 / 梦 / 说说 / 画 / 聊天条数，按天合并
  app.get('/api/life/timeline', async (req) => lifeTimeline({ days: Number(req.query?.days) || 7 }));
  // 全局搜索：聊天记录 / 事实 / 日记 / 知识库
  app.get('/api/search', async (req) => searchAll(String(req.query?.q ?? ''), { limit: Number(req.query?.limit) || 20 }));
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
  // 手机访问：读设置 / 开开关关 / 改口令（只允许本机调用，远程请求在 onRequest 就被拦）
  app.get('/api/remote', async () => remoteView());
  // 界面皮肤：设置存 config.json，换设备也一致
  app.get('/api/skin', async () => skinView());
  // 说说设置：概率 / 每天上限 / 最小间隔 / 免打扰
  app.get('/api/qzone', async () => qzoneView());
  app.post('/api/qzone', async (req) => saveQzone(req.body ?? {}));
  app.post('/api/skin', async (req) => {
    // 契约校验：错在哪一字段直接说，别让面板拿到 500
    const verdict = validateBody('/api/skin', req.body ?? {});
    if (!verdict.ok) throw new HttpError(400, verdict.errors.join('；'));
    return saveSkin(req.body ?? {});
  });
  app.post('/api/remote', async (req) => saveRemoteConfig(req.body ?? {}));
  // 她的画：按月归拢（梗图和表情单独分栏）
  // 关系图：实体 + 事实（服务端算好固定布局，前端只画）
  app.get('/api/kg', async () => kgView());
  app.get('/api/works/wall', async (req) => worksWall({ month: String(req.query?.month ?? '') }));
  // 月度小结：GET 读历史，POST 现算一份（会存到 state/reports/month-YYYY-MM.md）
  app.get('/api/reports', async () => listReports({}));
  app.post('/api/reports/monthly', async (req) => buildMonthlyReport({ month: String(req.body?.month ?? '') }));
  app.post('/api/ops/run', async (req) => runOps(String(req.body?.task ?? 'keys')));
  app.post('/api/ops/cleanup', async (req) => ({
    ok: true,
    ...runCleanup({
      keepBackupDays: Number(req.body?.keepBackupDays) || 30,
      keepLogDays: Number(req.body?.keepLogDays) || 14,
      dryRun: req.body?.dryRun !== false,
    }),
  }));
  app.post('/api/usage/budget', async (req) => {
    const verdict = validateBody('/api/usage/budget', req.body ?? {});
    if (!verdict.ok) throw new HttpError(400, verdict.errors.join('；'));
    return saveUsageLimits(req.body ?? {});
  });
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
