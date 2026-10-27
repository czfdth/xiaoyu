# src/snowluma —— 和 SnowLuma 的连接层

> 一句话：**所有和 SnowLuma 有关的代码（HTTP action、WebSocket 事件、token 自发现、发消息段）
> 都只从这里进。** 业务代码里不应该再出现 `fetch('.../send_msg')` 或自己拼 `httpUrl`。

## 为什么要有这一层

改造前「连 SnowLuma」有四个半独立的实现：

| 位置 | 干什么 | 问题 |
|---|---|---|
| `bridge.js` `onebotHttpAction` | 读接口的 HTTP 兜底 | 一份 fetch + token + 426 提示 |
| `bridge.js` `onebotSend` | 发消息 | 又一份 fetch + token + 426 提示 |
| `bridge.js` `new SnowLumaWebSocketClient` | 收消息 | token/url 自愈逻辑和上面各写一半 |
| `mcp-snowluma-safe.js` `onebot()` | 85 个工具的所有 QQ 动作 | 又一份 |
| `mcp-host-server.js` | 网关探活 | 再一份 |
| `snowluma-conn.js` | token/端点发现 | 只被 bridge 用，MCP 吃不到 |

换 QQ 账号后 token 会变（SnowLuma 是**按账号一个文件**，HTTP 和 WS 还是两个不同 token），
四处里只要有一处没跟上，就是 401 / 1006 / 工具静默失效。

## 结构

```
src/snowluma/
  http.js      createOneBotHttp()     一条 HTTP 连接：request（信封）/ call（data）/ withToken()
  discover.js  端点与 token 自发现（原 snowluma-conn.js，兼容导出）
  link.js      createSnowLumaLink()   WS + HTTP 的组合，形状对齐 SDK 的 WS 客户端
  index.js     对外唯一入口（含 text/image/record… 消息段）
```

## 用法

**A. bridge：一条完整的连接**

```js
import { createSnowLumaLink } from './snowluma/index.js';

const bot = createSnowLumaLink({ config: cfg.snowluma, log });
bot.onPrivateMessage(async (e) => { ... });
bot.onGroupMessage(async (e) => { ... });
await bot.connect();

await bot.request('fetch_custom_face_detail', { count: 50 }); // 走 WS
const login = await bot.status();                             // HTTP 探活
```

`bot` 暴露的 `request / raw / sendPrivateMessage / sendGroupMessage / getImage /
fetchFaceEntity / getMessage / getGroupMemberList / on / onPrivateMessage / onEvent /
onBotStatus / url / accessToken / connect / close` 与 `@snowluma/sdk` 的 WS 客户端一致，
所以业务代码可以无感替换。

**B. MCP / 工具：只要 HTTP**

```js
import { createOneBotHttp } from './snowluma/index.js';

const http = createOneBotHttp({ baseUrl, token, timeoutMs: 15000 });
const data = await http.call('send_group_msg', { group_id, message });
```

**C. 换账号后自愈**

```js
import { discoverSnowLumaConnection } from './snowluma/index.js';

const found = await discoverSnowLumaConnection({ cfg });
if (found.ok) {
  bot.applyEndpoint({ wsUrl: found.wsUrl, wsToken: found.wsToken });
  bot.persist(CONFIG_FILE, { accessToken: found.token, wsUrl: found.wsUrl });
}
```

## 契约

- `call` 失败一律抛 `OneBotError`，带 `.status / .retcode / .action / .baseUrl`，
  上层可以用 `error.status === 401` 判断「token 过期」而不是去 match 字符串。
- 任何方法都不在内部重试；重试/退避是 `link` 的使用方（bridge 自愈、MCP 发现）的事。
- `status()` **永远不抛**：网关不在线是正常状态，不是异常。
- 端点优先级：显式 config > 环境变量 > SnowLuma `config/onebot_<uin>.json`。
