// 只允许本机来源改写数据（防 DNS rebinding / 别的网页偷偷 POST 到本地面板）。
// GET 不拦（只读，且浏览器同源策略已经挡住跨域读取）。

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(hostHeader = '') {
  const h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

export function assertLocalRequest(req, reply) {
  const host = hostnameOf(req.headers.host);
  if (!LOOPBACK.has(host)) {
    reply.code(403).send({ error: '只允许通过 127.0.0.1 访问' });
    return false;
  }
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;

  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try { originHost = hostnameOf(new URL(origin).host); } catch { originHost = ''; }
    if (!LOOPBACK.has(originHost)) {
      reply.code(403).send({ error: '拒绝跨站写入' });
      return false;
    }
  }
  const type = String(req.headers['content-type'] ?? '');
  // DELETE 通常没有 body，不强求 content-type；写 body 的 POST/PUT/PATCH 必须是 JSON。
  if (req.method !== 'DELETE' && !type.includes('application/json')) {
    reply.code(415).send({ error: '只接受 application/json' });
    return false;
  }
  return true;
}

const DIGITS = /^\d{5,12}$/;

/** 校验并规范化「QQ 号列表」：去重、只留 5~12 位数字、最多 200 条。 */
export function normalizeIdList(value) {
  if (!Array.isArray(value)) throw new HttpError(400, '应该是数组');
  const out = [];
  for (const raw of value) {
    const s = String(raw).trim();
    if (!s) continue;
    if (!DIGITS.test(s)) throw new HttpError(400, `不是 QQ 号：${s}`);
    if (!out.includes(s)) out.push(s);
    if (out.length > 200) throw new HttpError(400, '太多了（最多 200 个）');
  }
  return out;
}

export function normalizeQQ(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (!DIGITS.test(s)) throw new HttpError(400, 'ownerQQ 要是 5~12 位数字');
  return Number(s);
}

export function assertSafeName(name, label = '名字') {
  const s = String(name ?? '').trim();
  if (!s || s.length > 60) throw new HttpError(400, `${label}长度不对`);
  if (/[\\/:*?"<>|\x00-\x1f]/.test(s) || s === '.' || s === '..') {
    throw new HttpError(400, `${label}里有非法字符`);
  }
  return s;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
