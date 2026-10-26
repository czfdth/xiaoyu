// 小鱼管家 · 后端入口（Fastify）
//
// 只监听 127.0.0.1：它是个本地面板，不该开到局域网。
// 端口默认取 src/paths.js 的 PORTS.gui（8765），XIAOYU_PORT 可覆盖。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './server/app.mjs';
import { PORTS, ensureRuntime, APP_ROOT } from '../src/paths.js';

const GUI_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.XIAOYU_PORT || PORTS.gui);

ensureRuntime({ quiet: true });

const app = await buildApp({ guiDir: GUI_DIR });

try {
  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(`小鱼管家已启动: http://127.0.0.1:${PORT}`);
  console.log(`程序目录: ${APP_ROOT}`);
} catch (error) {
  console.error('小鱼管家启动失败:', error?.message ?? error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    try { await app.close(); } catch {}
    process.exit(0);
  });
}
