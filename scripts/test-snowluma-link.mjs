// 连接层自测：HTTP 契约 + token 自发现 +（可选）真网关 WS 连接。
//
//   node scripts/test-snowluma-link.mjs                  # 离线：假 OneBot 服务
//   XIAOYU_SNOWLUMA_LIVE=1 node scripts/test-snowluma-link.mjs   # 额外连一次真网关（只读，不发消息）
//
// 真网关那段只调 get_login_info，不发送、不改配置。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createOneBotHttp, OneBotError,
  discoverSnowLumaConnection, createSnowLumaLink,
} from '../src/snowluma/index.js';
import { readConfig } from '../src/paths.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── 1. 假 OneBot HTTP 服务 ────────────────────────────────────────────────
const seen = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? '' });
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.url === '/get_login_info') {
      if (req.headers.authorization === 'Bearer good') {
        return send(200, { status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '小鱼' } });
      }
      return send(200, { status: 'failed', retcode: 1401, wording: 'token 无效' });
    }
    if (req.url === '/send_private_msg') return send(200, { status: 'ok', retcode: 0, data: { message_id: 42 } });
    if (req.url === '/slow') return setTimeout(() => send(200, { status: 'ok', retcode: 0, data: {} }), 400);
    if (req.url === '/boom') return send(500, { status: 'failed', retcode: -1 });
    if (req.url === '/not-json') { res.writeHead(200); return res.end('<html>'); }
    return send(404, {});
  });
});
await new Promise((resolve) => server.listen(3999, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:3999';

const good = createOneBotHttp({ baseUrl: base, token: 'good' });
const login = await good.call('get_login_info');
check('HTTP call 成功返回 data', login?.user_id === 10001);

const envelope = await good.request('get_login_info');
check('HTTP request 返回完整信封', envelope.status === 'ok' && envelope.retcode === 0);

check('token 走 Authorization: Bearer', seen.at(-1)?.auth === 'Bearer good', seen.at(-1)?.auth);

const sent = await good.call('send_private_msg', { user_id: 1, message: [] });
check('send_private_msg 返回 message_id', sent?.message_id === 42);

let authErr = null;
try { await createOneBotHttp({ baseUrl: base, token: 'bad' }).call('get_login_info'); } catch (e) { authErr = e; }
check('坏 token 抛 OneBotError(retcode=1401)', authErr instanceof OneBotError && authErr.retcode === 1401,
  authErr ? `status=${authErr.status} retcode=${authErr.retcode}` : '没有抛错');

let boomErr = null;
try { await good.call('boom'); } catch (e) { boomErr = e; }
check('HTTP 500 抛 OneBotError(status=500)', boomErr instanceof OneBotError && boomErr.status === 500, String(boomErr?.message));

let parseErr = null;
try { await good.call('not-json'); } catch (e) { parseErr = e; }
check('非 JSON 响应给出可读错误', parseErr instanceof OneBotError && /不是 JSON/.test(parseErr.message), String(parseErr?.message));

let timeoutErr = null;
try { await good.call('slow', {}, { timeoutMs: 100 }); } catch (e) { timeoutErr = e; }
check('超时也走 OneBotError', timeoutErr instanceof OneBotError, String(timeoutErr?.message));

// ── 2. token 自发现（假 SnowLuma 目录） ──────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-home-'));
fs.mkdirSync(path.join(home, 'config'), { recursive: true });
fs.writeFileSync(path.join(home, 'config', 'onebot_10001.json'), JSON.stringify({
  networks: {
    httpServers: [{ host: '127.0.0.1', port: 3999, accessToken: 'good' }],
    wsServers: [{ host: '127.0.0.1', port: 3998, accessToken: 'ws-good' }],
  },
}), 'utf8');

const found = await discoverSnowLumaConnection({
  cfg: { snowluma: { httpUrl: base, accessToken: 'stale-token', homeDir: home } },
  timeoutMs: 2000,
});
check('发现：坏 token 之后自动找到 per-account token', found.ok && found.token === 'good', found.ok ? found.source : found.error);
check('发现：带上同账号的 WS token', found.wsToken === 'ws-good' && found.wsUrl === 'ws://127.0.0.1:3998');

// ── 3. 真网关（显式开启，只读） ───────────────────────────────────────────
if (process.env.XIAOYU_SNOWLUMA_LIVE === '1') {
  const cfg = readConfig();
  const real = await discoverSnowLumaConnection({ cfg, timeoutMs: 3000 });
  check('真网关：能发现可用连接', real.ok, real.ok ? `${real.baseUrl} uin=${real.self?.user_id}` : real.error);
  if (real.ok && real.wsUrl) {
    const link = createSnowLumaLink({
      config: { httpUrl: real.baseUrl, wsUrl: real.wsUrl, accessToken: real.token, wsToken: real.wsToken },
    });
    try {
      await link.connect();
      const info = await link.loginInfo({ timeoutMs: 3000 });
      check('真网关：WS 连接 + get_login_info', info?.user_id === real.self?.user_id, `uin=${info?.user_id}`);
      const st = await link.status();
      check('真网关：status() 不抛且在线', st.ok === true, `${st.latencyMs}ms`);
    } catch (error) {
      check('真网关：WS 连接 + get_login_info', false, String(error?.message ?? error));
    } finally {
      link.close(1000, 'test');
    }
  }
} else {
  console.log('⏭  真网关测试未开启（XIAOYU_SNOWLUMA_LIVE=1 才连）');
}

server.close();
fs.rmSync(home, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${failed.length ? '失败' : '通过'} ${results.length - failed.length}/${results.length} ===`);
process.exit(failed.length ? 1 : 0);
