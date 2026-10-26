// 备份出站：把最新备份加密后复制到异机/网盘目录，并按份数清理。
// 配置：config.backup = { offsiteDir, encrypt: true, keep: 14 }
// 默认目录：OneDrive\xiaoyu-backups（存在 OneDrive 时），否则跳过。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_ROOT as ROOT, STATE_DIR } from '../src/paths.js';

const LOG = path.join(STATE_DIR, 'backup-offsite.log');
const KEY_FILE = path.join(STATE_DIR, 'backup-key');
const MAGIC = Buffer.from('XYBK1');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const opt = cfg.backup || {};
const keep = Math.max(1, Number(opt.keep) || 14);

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch { /* ignore */ }
}

function offsiteDir() {
  if (opt.offsiteDir) return String(opt.offsiteDir).replace(/^~/, process.env.USERPROFILE || '');
  const oneDrive = process.env.OneDrive || path.join(process.env.USERPROFILE || '', 'OneDrive');
  if (oneDrive && fs.existsSync(oneDrive)) return path.join(oneDrive, 'xiaoyu-backups');
  return '';
}

function key() {
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  } catch { /* 生成新 key */ }
  const buf = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, buf.toString('base64'), 'utf8');
  log('已生成新的备份密钥 state/backup-key（请单独保存，丢了加密备份就解不开）');
  return buf;
}

function encryptFile(src, dst, keyBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const input = fs.readFileSync(src);
  const body = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(dst, Buffer.concat([MAGIC, iv, tag, body]));
}

const dir = offsiteDir();
if (!dir) { log('没有 OneDrive，也没有配置 backup.offsiteDir，跳过（备份仍在本机）'); process.exit(0); }
fs.mkdirSync(dir, { recursive: true });

const backups = fs.readdirSync(path.join(ROOT, 'backups')).filter((f) => /\.zip$/i.test(f))
  .map((name) => ({ name, at: fs.statSync(path.join(ROOT, 'backups', name)).mtimeMs }))
  .sort((a, b) => b.at - a.at);
if (!backups.length) { log('本机还没有备份，跳过'); process.exit(0); }

const latest = backups[0].name;
const src = path.join(ROOT, 'backups', latest);
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const useEnc = opt.encrypt !== false;
const outName = useEnc ? `xiaoyu-${stamp}.zip.enc` : `xiaoyu-${stamp}.zip`;
const out = path.join(dir, outName);
if (useEnc) encryptFile(src, out, key());
else fs.copyFileSync(src, out);
log(`已出站 ${latest} → ${out}${useEnc ? '（加密）' : ''}`);

const olds = fs.readdirSync(dir).filter((f) => /^xiaoyu-.*\.(zip|zip\.enc)$/i.test(f))
  .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
  .sort((a, b) => b.at - a.at);
for (const item of olds.slice(keep)) {
  try { fs.unlinkSync(path.join(dir, item.name)); log(`清理旧出站备份 ${item.name}`); } catch { /* ignore */ }
}
