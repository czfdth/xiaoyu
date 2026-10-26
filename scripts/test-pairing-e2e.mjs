// 配对 E2E：起一个假 OneBot（HTTP + WebSocket），让真 bridge 连上来，
// 用一条「私聊配对码」消息走完整条链路，验证：
//   · bridge 收到私聊 → 配对成功 → 写 ownerQQ + allow.private
//   · 回执通过 HTTP send_private_msg 发出去（内容含「配对成功」）
//   · state/pairing.json 被删除
//
// 不碰真 QQ、不碰真 DSH：配置指向假端口。
//   node scripts/test-pairing-e2e.mjs

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPairing, savePairing } from '../src/pairing.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = '246810';
const OWNER = 10001;
const BOT = 10002;
const PORTS = { http: 3997, ws: 3996, bridge: 3994, dsh: 3995 };
const sent = [];
let wsSocket = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 假 OneBot HTTP ─────────────────────────────────────────────────────────
function actionData(action) {
  if (action === 'get_login_info') return { user_id: BOT, nickname: '假网关' };
  if (action === 'get_status') return { good: true, online: true };
  if (action === 'fetch_custom_face_detail') return { emojis: [] };
  if (action === 'get_group_list' || action === 'get_friend_list') return [];
  if (action === 'get_msg') return { message_id: 1, message: [] };
  return {};
}
const httpServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const action = (req.url || '/').replace(/^\//, '');
    let params = {};
    try { params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
    if (action === 'send_private_msg' || action === 'send_group_msg') {
      sent.push({ action, params, at: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9001 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: actionData(action) }));
  });
});
await new Promise((r) => httpServer.listen(PORTS.http, '127.0.0.1', r));

// ── 最小 WebSocket 服务端（只处理文本帧） ─────────────────────────────────
function wsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseFrames(buf, onText) {
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b1 = buf[offset + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) { len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { mask = buf.slice(p, p + 4); p += 4; }
    if (p + len > buf.length) return;
    const payload = Buffer.from(buf.slice(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    const opcode = buf[offset] & 0x0f;
    if (opcode === 1) onText(payload.toString('utf8'));
    if (opcode === 8) { try { wsSocket?.end(); } catch {} }
    if (opcode === 9) { try { wsSocket?.write(Buffer.from([0x8a, 0])); } catch {} }
    offset = p + len;
  }
}

const wsServer = http.createServer();
wsServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'] || '';
  const accept = crypto.createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`, '', '',
  ].join('\r\n'));
  wsSocket = socket;
  socket.on('data', (buf) => parseFrames(buf, (text) => {
    let msg = {};
    try { msg = JSON.parse(text); } catch { return; }
    const echo = msg.echo ?? msg.request_id ?? null;
    socket.write(wsFrame(JSON.stringify({
      status: 'ok', retcode: 0, data: actionData(msg.action), echo,
    })));
  }));
});
await new Promise((r) => wsServer.listen(PORTS.ws, '127.0.0.1', r));

// ── 临时数据目录 + 配对码 ──────────────────────────────────────────────────
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-pair-e2e-'));
fs.mkdirSync(path.join(data, 'state'), { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
  ownerQQ: null,
  allow: { private: [], groups: [] },
  deny: { private: [], groups: [] },
  allowAllWhenEmpty: false,
  sessionCwd: '',
  agentPreset: 'qq-chat',
  consolePort: PORTS.bridge,
  snowluma: { httpUrl: `http://127.0.0.1:${PORTS.http}`, wsUrl: `ws://127.0.0.1:${PORTS.ws}`, accessToken: 'test-token' },
  dsh: { baseUrl: `http://127.0.0.1:${PORTS.dsh}` },
}, null, 2));
savePairing(path.join(data, 'state', 'pairing.json'), createPairing({ code: CODE }));

// ── 起真 bridge ────────────────────────────────────────────────────────────
const bridge = spawn(process.execPath, ['src/bridge.js'], {
  cwd: ROOT,
  env: { ...process.env, XIAOYU_HOME: data },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeOut = '';
bridge.stdout.on('data', (d) => { bridgeOut += d; });
bridge.stderr.on('data', (d) => { bridgeOut += d; });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

await sleep(2500);
// 先发一条错误配对码：不应该配对
const wrong = {
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  time: Math.floor(Date.now() / 1000), self_id: BOT, user_id: OWNER + 1, message_id: 500,
  raw_message: '000000',
  message: [{ type: 'text', data: { text: '000000' } }],
  sender: { user_id: OWNER + 1, nickname: '路人' },
};
wsSocket?.write(wsFrame(JSON.stringify(wrong)));
await sleep(1500);
let cfgWrong = null;
try { cfgWrong = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')); } catch {}
check('错误配对码没有写 ownerQQ', !cfgWrong?.ownerQQ, `ownerQQ=${cfgWrong?.ownerQQ}`);
check('错误码之后配对码文件还在', fs.existsSync(path.join(data, 'state', 'pairing.json')));

const event = {
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  time: Math.floor(Date.now() / 1000), self_id: BOT, user_id: OWNER, message_id: 501,
  raw_message: CODE,
  message: [{ type: 'text', data: { text: CODE } }],
  sender: { user_id: OWNER, nickname: '主人' },
};
wsSocket?.write(wsFrame(JSON.stringify(event)));

let cfg = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try { cfg = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')); } catch {}
  if (cfg?.ownerQQ) break;
}

check('配对成功写了 ownerQQ', Number(cfg?.ownerQQ) === OWNER, `ownerQQ=${cfg?.ownerQQ}`);
check('进了 allow.private', (cfg?.allow?.private ?? []).map(String).includes(String(OWNER)), JSON.stringify(cfg?.allow?.private));
check('配对码文件已删除', !fs.existsSync(path.join(data, 'state', 'pairing.json')));
const reply = sent.find((s) => s.action === 'send_private_msg');
check('通过 HTTP 发了回执', Boolean(reply), reply ? JSON.stringify(reply.params).slice(0, 120) : '没捕获到');
check('回执内容提到配对成功', JSON.stringify(reply?.params ?? '').includes('配对成功'));

bridge.kill();
httpServer.close();
wsServer.close();
try { wsSocket?.destroy(); } catch {}
fs.rmSync(data, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\n--- bridge 输出 ---');
  console.log(bridgeOut.slice(-2000));
}
console.log(`\n=== ${failed.length ? '失败' : '通过'} ${results.length - failed.length}/${results.length} ===`);
process.exit(failed.length ? 1 : 0);
