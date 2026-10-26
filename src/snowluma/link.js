// SnowLuma 连接对象：把「一条 SnowLuma 连接」该有的东西收在一处。
//
//   · HTTP 调 action（tools 走这条）
//   · WebSocket 收发事件（bridge 主链路走这条）
//   · 端点/token 自发现与回写
//   · 登录信息 / 健康探活
//
// 外形故意和 @snowluma/sdk 的 SnowLumaWebSocketClient 对齐（request / raw /
// sendPrivateMessage / onPrivateMessage / url / accessToken…），这样 bridge 里
// 原来那一整片 `bot.xxx` 一行都不用改，只换掉构造函数。

import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { createOneBotHttp, normalizeBaseUrl } from './http.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './discover.js';

/** 兼容两种入参：完整 config（有 snowluma 层）或窄对象。 */
export function normalizeSnowLumaConfig(config = {}) {
  const sl = config?.snowluma ?? config ?? {};
  return {
    httpUrl: normalizeBaseUrl(sl.httpUrl || 'http://127.0.0.1:3000'),
    wsUrl: String(sl.wsUrl || 'ws://127.0.0.1:3001'),
    token: String(sl.accessToken ?? ''),
    wsToken: String(sl.wsToken ?? ''),
    homeDir: String(sl.homeDir ?? ''),
    launcherPath: String(sl.launcherPath ?? ''),
  };
}

// 这些方法直接透传给 SDK 的 WS 客户端；没有 WS 时调用会给出明确错误。
const WS_METHODS = [
  'request', 'raw', 'rawResponse',
  'sendPrivateMessage', 'sendGroupMessage', 'sendMsg',
  'getImage', 'fetchFaceEntity', 'getMessage',
  'getGroupMemberList', 'getGroupMemberInfo', 'getGroupList', 'getFriendList',
  'getLoginInfo', 'getStatus',
  'on', 'onPrivateMessage', 'onGroupMessage', 'onNotice', 'onRequest', 'onEvent', 'onBotStatus',
];

/**
 * 建一条 SnowLuma 连接。
 *
 * @param {object}  options
 * @param {object}  [options.config]  完整 config 或 snowluma 窄对象
 * @param {boolean} [options.ws]      要不要 WebSocket（MCP 只用 HTTP 时传 false）
 * @param {function}[options.log]     日志
 */
export function createSnowLumaLink({ config = {}, ws = true, log = () => {} } = {}) {
  const endpoints = normalizeSnowLumaConfig(config);
  let http = createOneBotHttp({ baseUrl: endpoints.httpUrl, token: endpoints.token });

  const client = ws
    ? new SnowLumaWebSocketClient({
        url: endpoints.wsUrl,
        accessToken: endpoints.wsToken || endpoints.token || undefined,
        reconnect: true,
      })
    : null;

  const link = {
    kind: 'snowluma-link',
    client,
    get http() { return http; },
    get endpoints() { return { ...endpoints }; },

    // ── 与 SDK 对齐的属性（bridge 会在自愈时直接赋值） ──────────────────
    get url() { return client?.url ?? endpoints.wsUrl; },
    set url(value) {
      endpoints.wsUrl = String(value ?? endpoints.wsUrl);
      if (client) client.url = endpoints.wsUrl;
    },
    get accessToken() { return client?.accessToken ?? endpoints.wsToken ?? endpoints.token; },
    set accessToken(value) {
      endpoints.wsToken = value ? String(value) : '';
      if (client) client.accessToken = value ? String(value) : undefined;
    },

    // ── HTTP 侧 ────────────────────────────────────────────────────────
    /** 发一个 action，返回完整信封（老 onebotHttpAction 的语义）。 */
    httpCall(action, params = {}, options = {}) {
      return http.request(action, params, options);
    },
    /** 发一个 action，只要 data。 */
    httpData(action, params = {}, options = {}) {
      return http.call(action, params, options);
    },
    /** 发消息（HTTP，和改造前的 onebotSend 完全同一条路）。 */
    sendSegments(kind, id, segments, { timeoutMs } = {}) {
      const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
      const params = kind === 'private'
        ? { user_id: Number(id), message: segments }
        : { group_id: Number(id), message: segments };
      return http.call(action, params, timeoutMs ? { timeoutMs } : {});
    },

    // ── 探活 / 发现 / 回写 ─────────────────────────────────────────────
    async loginInfo({ timeoutMs = 3000 } = {}) {
      return http.call('get_login_info', {}, { timeoutMs });
    },
    /** 网关在线吗 + 当前是哪个号。永远不抛。 */
    async status({ timeoutMs = 1500 } = {}) {
      const startedAt = Date.now();
      try {
        const data = await http.call('get_login_info', {}, { timeoutMs });
        return {
          ok: true,
          uin: data?.user_id ?? null,
          nickname: data?.nickname ?? '',
          latencyMs: Date.now() - startedAt,
          httpUrl: http.baseUrl,
        };
      } catch (error) {
        return {
          ok: false,
          error: error?.message ?? String(error),
          status: error?.status ?? 0,
          latencyMs: Date.now() - startedAt,
          httpUrl: http.baseUrl,
        };
      }
    },
    /** 自动找出可用的 HTTP/WS 端点（不自动应用，调用方决定）。 */
    discover({ timeoutMs = 4000 } = {}) {
      return discoverSnowLumaConnection({ cfg: { snowluma: endpoints }, timeoutMs });
    },
    /** 应用发现到的端点（改内存里的，不回写文件）。 */
    applyEndpoint({ httpUrl, wsUrl, token, wsToken } = {}) {
      if (httpUrl) {
        endpoints.httpUrl = normalizeBaseUrl(httpUrl);
        http = createOneBotHttp({ baseUrl: endpoints.httpUrl, token: token ?? endpoints.token });
      }
      if (token) {
        endpoints.token = String(token);
        http = createOneBotHttp({ baseUrl: endpoints.httpUrl, token: endpoints.token });
      }
      if (wsUrl) { endpoints.wsUrl = String(wsUrl); if (client) client.url = endpoints.wsUrl; }
      if (wsToken) { endpoints.wsToken = String(wsToken); if (client) client.accessToken = endpoints.wsToken; }
      return link.endpoints;
    },
    /** 把确认可用的端点写回 config.json（幂等）。 */
    persist(configPath, { accessToken, wsUrl, httpUrl } = {}) {
      return persistSnowLumaEndpoint(configPath, { accessToken, wsUrl, httpUrl });
    },
    persistToken(configPath, token) {
      return persistToken(configPath, token);
    },

    // ── WebSocket 生命周期 ─────────────────────────────────────────────
    connect() {
      if (!client) return Promise.reject(new Error('这条 SnowLuma 连接没有启用 WebSocket'));
      return client.connect();
    },
    close(code = 1000, reason = '') {
      try { client?.close(code, reason); } catch { /* 已关闭 */ }
    },
  };

  for (const method of WS_METHODS) {
    link[method] = (...args) => {
      if (!client) throw new Error(`这条 SnowLuma 连接没有启用 WebSocket（${method} 不可用）`);
      const fn = client[method];
      if (typeof fn !== 'function') throw new Error(`当前 SnowLuma SDK 没有 ${method}（版本不匹配）`);
      return fn.apply(client, args);
    };
  }

  // 让日志里能一眼看出连的是哪
  Object.defineProperty(link, 'toString', {
    value: () => `SnowLumaLink(${endpoints.httpUrl} / ${endpoints.wsUrl}${client ? '' : ' · HTTP only'})`,
  });

  log(`[snowluma] ${client ? 'WS+HTTP' : 'HTTP only'} → ${endpoints.httpUrl} / ${endpoints.wsUrl}`);
  return link;
}
