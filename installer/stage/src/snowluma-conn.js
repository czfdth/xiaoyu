// 兼容层：连接发现已经搬进 src/snowluma/。
// 老代码 `import ... from './snowluma-conn.js'` 继续可用，新代码请用 './snowluma/index.js'。
export {
  snowLumaHomeCandidates,
  readOneBotTokens,
  readOneBotHttpTokens,
  probeOneBot,
  discoverSnowLumaConnection,
  persistSnowLumaEndpoint,
  persistToken,
} from './snowluma/index.js';
