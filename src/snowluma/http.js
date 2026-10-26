// SnowLuma / OneBot v11 的 HTTP 传输层。
//
// 以前「调一个 OneBot action」在三个地方各写了一遍：bridge 的 onebotHttpAction、
// 桥接的 onebotSend、MCP 的 onebot()、网关状态 MCP 的 get_login_info。
// 四处各有一套 fetch + token 头 + 426 提示 + retcode 判断，改一处漏三处。
//
// 现在只有这里一份：createOneBotHttp() 给出 request（原始信封）/ call（只要 data）。

export class OneBotError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'OneBotError';
    this.action = info.action ?? '';
    this.baseUrl = info.baseUrl ?? '';
    this.status = info.status ?? 0;
    this.retcode = info.retcode ?? null;
    this.wording = info.wording ?? '';
    if (info.cause) this.cause = info.cause;
  }
}

export function normalizeBaseUrl(url) {
  return String(url || 'http://127.0.0.1:3000').trim().replace(/\/+$/, '');
}

/**
 * 一条 HTTP 连接（不是持久连接，OneBot HTTP 本来就是一问一答）。
 * @param {{baseUrl?:string, token?:string, timeoutMs?:number}} options
 */
export function createOneBotHttp({ baseUrl, token = '', timeoutMs = 15000 } = {}) {
  const base = normalizeBaseUrl(baseUrl);

  /**
   * 发一个 action，返回完整信封 { status, retcode, data, ... }。
   * 失败时抛 OneBotError（带 status / retcode / action，便于上层判断 401）。
   */
  async function request(action, params = {}, { timeoutMs: timeout = timeoutMs, token: overrideToken } = {}) {
    const useToken = overrideToken ?? token;
    let res;
    try {
      res = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(useToken ? { authorization: `Bearer ${useToken}` } : {}),
        },
        body: JSON.stringify(params ?? {}),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new OneBotError(`连不上 OneBot（${base}）：${error?.message ?? error}`, {
        action, baseUrl: base, cause: error,
      });
    }

    if (!res.ok) {
      const hint = res.status === 426
        ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请改为 OneBot HTTP API 地址'
        : '';
      throw new OneBotError(`OneBot ${action} HTTP ${res.status}${hint}`, {
        action, baseUrl: base, status: res.status,
      });
    }

    let body;
    try {
      body = await res.json();
    } catch (error) {
      throw new OneBotError(`OneBot ${action} 返回的不是 JSON（${base}）`, {
        action, baseUrl: base, status: res.status, cause: error,
      });
    }

    if (body?.status !== 'ok' || body?.retcode !== 0) {
      throw new OneBotError(
        `OneBot ${action} 失败: retcode=${body?.retcode} ${body?.wording ?? ''}`.trim(),
        { action, baseUrl: base, status: res.status, retcode: body?.retcode ?? null, wording: body?.wording ?? '' }
      );
    }
    return body;
  }

  /** 只要 data，不要信封（大多数调用方的用法）。 */
  async function call(action, params = {}, options = {}) {
    const body = await request(action, params, options);
    return body.data;
  }

  const withToken = (nextToken) => createOneBotHttp({ baseUrl: base, token: nextToken, timeoutMs });

  return { baseUrl: base, token, timeoutMs, request, call, withToken };
}
