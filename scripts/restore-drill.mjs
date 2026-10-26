// 恢复演练：找最新出站备份，解密/解压到临时目录，验证关键文件能读，再清理。
// 不覆盖正在运行的 state；只验“这份备份能不能恢复”。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { APP_ROOT as ROOT, STATE_DIR } from '../src/paths.js';

const LOG = path.join(STATE_DIR, 'restore-drill.log');
const KEY_FILE = path.join(STATE_DIR, 'backup-key');
const MAGIC = Buffer.from('XYBK1');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const opt = cfg.backup || {};

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch { /* ignore */ }
}

function offsiteDir() {
  if (opt.offsiteDir) return String(opt.offsiteDir).replace(/^~/, process.env.USERPROFILE || '');
  const oneDrive = process.env.OneDrive || path.join(process.env.USERPROFILE || '', 'OneDrive');
  if (oneDrive && fs.existsSync(oneDrive)) return path.join(oneDrive, 'xiaoyu-backups');
  return path.join(ROOT, 'backups');
}

function decryptFile(src, dst) {
  const raw = fs.readFileSync(src);
  if (!raw.subarray(0, 5).equals(MAGIC)) throw new Error('不是 XYBK 加密备份');
  const iv = raw.subarray(5, 17);
  const tag = raw.subarray(17, 33);
  const body = raw.subarray(33);
  const key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  fs.writeFileSync(dst, Buffer.concat([decipher.update(body), decipher.final()]));
}

const dir = offsiteDir();
if (!fs.existsSync(dir)) { log(`出站目录不存在：${dir}`); process.exit(1); }
const files = fs.readdirSync(dir).filter((f) => /^xiaoyu-.*(\.zip|\.zip\.enc)$/i.test(f))
  .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
  .sort((a, b) => b.at - a.at);
if (!files.length) { log(`没有可演练的备份：${dir}`); process.exit(1); }

const latest = files[0];
const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'xiaoyu-drill-'));
const work = path.join(tmp, 'backup.zip');
try {
  if (latest.name.endsWith('.enc')) decryptFile(path.join(dir, latest.name), work);
  else fs.copyFileSync(path.join(dir, latest.name), work);

  const list = execFileSync('tar', ['-tf', work], { encoding: 'utf8', windowsHide: true });
  const entries = list.split(/\r?\n/).filter(Boolean);
  const hasLife = entries.some((e) => /state[\\/]life\.json$/i.test(e));
  const hasConfig = entries.some((e) => /config\.json$/i.test(e));

  const out = path.join(tmp, 'out');
  fs.mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-xf', work, '-C', out], { windowsHide: true });
  const lifeFile = ['state/life.json', 'state\\life.json'].map((p) => path.join(out, p)).find((p) => fs.existsSync(p));
  let birth = '';
  if (lifeFile) birth = JSON.parse(fs.readFileSync(lifeFile, 'utf8').replace(/^\uFEFF/, '')).birth || '';

  const ok = entries.length > 10 && hasConfig;
  log(`${ok ? '通过' : '失败'}：${dir}\\${latest.name}，${entries.length} 项，config=${hasConfig}，life=${hasLife}，出生=${birth || '—'}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
} catch (error) {
  log(`失败：${dir}\\${latest.name} — ${error?.message ?? error}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
}
