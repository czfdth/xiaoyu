// 小鱼 ↔ SnowLuma 的连接层（唯一入口）。
//
// 这里只做四件事：
//   1. 建连接   createSnowLumaLink({ config })      —— 给 bridge 用（WS + HTTP）
//   2. 调 action createOneBotHttp({ baseUrl, token }) —— 给 MCP / 工具用（HTTP）
//   3. 找端点   discoverSnowLumaConnection() / readOneBotTokens() —— 换账号后自动跟上
//   4. 发消息   text / image / record / at / reply …… 直接复用 SDK 的段构造器
//
// 别的地方不要再自己写 fetch + Bearer + retcode 判断，也不要在业务代码里拼 httpUrl。

export { createSnowLumaLink, normalizeSnowLumaConfig } from './link.js';
export { createOneBotHttp, OneBotError, normalizeBaseUrl } from './http.js';
export {
  snowLumaHomeCandidates,
  readOneBotTokens,
  readOneBotHttpTokens,
  probeOneBot,
  discoverSnowLumaConnection,
  persistSnowLumaEndpoint,
  persistToken,
} from './discover.js';

// 消息段：和 @snowluma/sdk 是同一份实现，只是在这里统一出口。
export {
  text, image, record, video, at, atAll, face, reply, chain, poke, forward,
  escapeCqText, escapeCqParam,
} from '@snowluma/sdk';
