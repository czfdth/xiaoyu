// 她的动作 GIF（来自 dsh-pet，MIT）：列出与读取。
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from '../../src/paths.js';

const ACTIONS = path.join(APP_ROOT, 'pet', 'actions');

export function listActions() {
  try {
    const files = fs.readdirSync(ACTIONS).filter((f) => /\.gif$/i.test(f)).sort().map((name) => {
      const stat = fs.statSync(path.join(ACTIONS, name));
      return { name, title: path.basename(name, '.gif'), size: stat.size };
    });
    return { actions: files };
  } catch { return { actions: [] }; }
}

export function actionFile(name) {
  const safe = path.basename(String(name || ''));
  const full = path.join(ACTIONS, safe);
  if (!/\.gif$/i.test(safe) || !fs.existsSync(full)) {
    const error = new Error('动作不存在');
    error.statusCode = 404;
    throw error;
  }
  return { file: full, type: 'image/gif' };
}
